"""Browser smoke tests: every page renders without JavaScript errors, key flows open,
and user text is escaped. Uses a fake Supabase client (tests/e2e/fake-supabase.js), so it
needs no network or database. Run: python3 tests/e2e/smoke.py  (requires Python Playwright + Chromium)
"""
import functools, http.server, os, pathlib, socketserver, sys, threading
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
FAKE = (ROOT / 'tests/e2e/fake-supabase.js').read_text()
SHOTS = ROOT / 'tests/e2e/screens'
SHOTS.mkdir(exist_ok=True)
ORDER = '11111111-1111-1111-1111-111111111111'
CLIENT = '22222222-2222-2222-2222-222222222222'
PERSON = '00000000-0000-0000-0000-0000000000b2'

STAFF_PAGES = [
    ('dashboard', '#/', 'Dashboard'),
    ('dispatcher', '#/dispatch', 'Dispatcher'),
    ('order', f'#/orders/{ORDER}', 'K-1001'),
    ('order-edit', f'#/orders/{ORDER}/edit', 'Edit K-1001'),
    ('order-new', '#/orders/new', 'New order'),
    ('calendar-week', '#/calendar?view=week', 'Calendar'),
    ('calendar-month', '#/calendar?view=month', 'Calendar'),
    ('calendar-day', '#/calendar?view=day', 'Calendar'),
    ('calendar-list', '#/calendar?view=list', 'Calendar'),
    ('clients', '#/clients', 'Clients'),
    ('client', f'#/clients/{CLIENT}', 'Cohen Family'),
    ('client-new', '#/clients/new', 'New client'),
    ('volunteers', '#/volunteers', 'Washing volunteers'),
    ('drivers', '#/drivers', 'Drivers'),
    ('person', f'#/people/{PERSON}', 'Bracha Washer'),
    ('history', '#/history', 'Recent History'),
    ('reports', '#/reports', 'Reports'),
    ('settings', '#/settings', 'Settings'),
    ('notifications', '#/notifications', 'Notifications'),
    ('search', '#/search?q=cohen', 'Search'),
    ('account', '#/account', 'My account'),
]

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

def new_page(browser, base, role='admin', logged_out=False, mobile=False):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1360, 'height': 900},
                              is_mobile=mobile, has_touch=mobile)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
    page.dialog_policy = {'mode': 'error', 'seen': []}
    def on_dialog(d):
        pol = page.dialog_policy
        pol['seen'].append(d.message)
        if pol['mode'] == 'accept': d.accept()
        elif pol['mode'] == 'dismiss': d.dismiss()
        else: errors.append(f'unexpected dialog: {d.message}'); d.dismiss()
    page.on('dialog', on_dialog)
    page.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
    page.goto(base + '/index.html')
    page.evaluate(f"localStorage.setItem('fakeRole', '{role}'); {'localStorage.setItem(\"fakeLoggedOut\",\"1\")' if logged_out else 'localStorage.removeItem(\"fakeLoggedOut\")'}")
    page.goto('about:blank')   # force a full reload so the fake picks up the role
    return page, errors

def wait_page(page):
    page.wait_for_function("() => { const m = document.querySelector('main .page'); return m && !m.querySelector('.state-loading'); }", timeout=8000)

def main():
    httpd = serve()
    base = f'http://127.0.0.1:{httpd.server_address[1]}'
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # ---- staff pages (desktop) ----
        page, errors = new_page(browser, base)
        for name, hash_, expect in STAFF_PAGES:
            errors.clear()
            page.goto(f'{base}/index.html{hash_}')
            try:
                wait_page(page)
                text = page.inner_text('main')
                bad = page.query_selector('main .state-error')
                check(f'page renders: {name}', expect in text and not bad and not errors,
                      (errors[:3] if errors else '') or (page.inner_text('main .state-error') if bad else f'missing "{expect}"'))
            except Exception as e:
                check(f'page renders: {name}', False, f'{e} {errors[:3]}')
            page.screenshot(path=str(SHOTS / f'{name}.png'), full_page=False)

        # escaping of user-supplied text
        page.goto(f'{base}/index.html#/orders/{ORDER}'); wait_page(page)
        check('user text is escaped (no script injection)', '<script>alert(1)</script>' in page.inner_text('main') and not errors, errors[:2])

        # assign modal opens with conflict warnings and closes
        page.click('text=Assign >> nth=0')
        page.wait_for_selector('.modal')
        page.select_option('.modal select[data-assignee] >> nth=0', index=1)
        page.wait_for_selector('.conflicts .notice', timeout=3000)
        check('assign modal shows conflict warning', 'Also has Pickup' in page.inner_text('.modal'))
        page.dialog_policy['mode'] = 'accept'
        page.click('.modal-foot [data-close]')
        page.wait_for_selector('.modal', state='detached')
        check('cancelling a changed modal asks before discarding', any('Discard' in m for m in page.dialog_policy['seen']))
        page.dialog_policy.update(mode='error', seen=[])

        # new order validation keeps data and explains the error
        page.goto(f'{base}/index.html#/orders/new'); wait_page(page)
        page.fill('input[name=bag_notes]', 'keep me')
        page.click('button[type=submit]')
        page.wait_for_selector('.form-error:not([hidden])')
        check('new order: clear validation message', 'Choose a client' in page.inner_text('.form-error'))
        check('new order: entered data preserved after error', page.input_value('input[name=bag_notes]') == 'keep me')
        # unsaved-changes guard
        page.dialog_policy['mode'] = 'dismiss'
        page.evaluate("location.hash = '#/clients'")
        page.wait_for_timeout(300)
        check('leaving a dirty form asks for confirmation', any('unsaved' in m.lower() for m in page.dialog_policy['seen']) and '/orders/new' in page.url, page.dialog_policy['seen'])
        page.dialog_policy.update(mode='error', seen=[])

        # reports CSV export
        page2, errors2 = new_page(browser, base)
        page2.goto(f'{base}/index.html#/reports'); wait_page(page2)
        with page2.expect_download() as dl:
            page2.click('[data-export=washers]')
        content = pathlib.Path(dl.value.path()).read_text(encoding='utf-8-sig')
        check('report CSV export downloads', content.startswith('Volunteer,') and 'Bracha Washer' in content, content[:80])
        page2.close()

        # ---- driver on a phone ----
        mob, merr = new_page(browser, base, role='driver', mobile=True)
        mob.goto(f'{base}/index.html#/'); wait_page(mob)
        text = mob.inner_text('main')
        check('driver lands on My tasks (mobile)', 'My tasks' in text and 'Return collection' in text and not merr, merr[:3])
        check('driver nav has no staff pages', mob.query_selector('a[href="#/clients"]') is None and mob.query_selector('a[href="#/settings"]') is None)
        mob.screenshot(path=str(SHOTS / 'driver-mobile.png'))
        mob.click('.big-actions .btn-primary')
        mob.wait_for_selector('.modal')
        check('driver record modal pre-selects tapped step', mob.eval_on_selector('.modal select[name=event]', 'e => e.value') == 'collected_from_washer')
        mob.fill('.modal input[name=bags]', '2.5')
        mob.click('.modal button[type=submit]')
        mob.wait_for_selector('.modal .form-error:not([hidden])')
        check('bag count must be a whole number', 'whole number' in mob.inner_text('.modal .form-error'))
        mob.fill('.modal input[name=bags]', '3')
        mob.click('.modal button[type=submit]')
        mob.wait_for_selector('.modal', state='detached')
        writes = mob.evaluate('window.__writes')
        rec = [w for w in writes if w.get('rpc') == 'record_handoff']
        check('driver handoff sent to server with count', rec and rec[-1]['args']['p_actual_bags'] == 3 and rec[-1]['args']['p_event'] == 'collected_from_washer', rec)
        mob.screenshot(path=str(SHOTS / 'driver-mobile-after.png'))
        mob.goto(f'{base}/index.html#/settings'); wait_page(mob)
        check('driver blocked from settings page', 'Not available' in mob.inner_text('main'))

        # staff pages on a phone render too
        mob2, merr2 = new_page(browser, base, mobile=True)
        for name, hash_, expect in [('m-dispatcher', '#/dispatch', 'Dispatcher'), ('m-order', f'#/orders/{ORDER}', 'K-1001'), ('m-calendar', '#/calendar', 'Calendar')]:
            merr2.clear()
            mob2.goto(f'{base}/index.html{hash_}'); wait_page(mob2)
            overflow = mob2.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2')
            check(f'mobile page fits screen: {name}', expect in mob2.inner_text('main') and not merr2 and not overflow, (merr2[:2], 'overflow' if overflow else ''))
            mob2.screenshot(path=str(SHOTS / f'{name}.png'))

        # ---- signed out ----
        lo, lerr = new_page(browser, base, logged_out=True)
        lo.goto(f'{base}/index.html'); lo.wait_for_selector('.auth-card')
        lo.click('[data-mode=signup]')
        lo.fill('input[name=full_name]', 'New Person'); lo.fill('input[name=email]', 'new@x.org')
        lo.fill('input[name=password]', 'longpassword'); lo.fill('input[name=password2]', 'longpassword')
        lo.click('button[type=submit]')
        lo.wait_for_selector('.notice-error')
        check('uninvited sign-up gets a clear message', 'not been invited' in lo.inner_text('.notice-error'))
        check('password fields are masked', lo.eval_on_selector('input[name=password]', 'e => e.type') == 'password')
        lo.screenshot(path=str(SHOTS / 'login.png'))
        browser.close()
    httpd.shutdown()
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
