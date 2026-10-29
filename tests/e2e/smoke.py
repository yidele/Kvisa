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
    ('messages', '#/messages', 'Messages'),
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

        # dispatcher: Dispatch button and modal showing the masked route
        page.goto(f'{base}/index.html#/dispatch'); wait_page(page)
        dt = page.inner_text('main')
        check('dispatcher shows dispatch status and a "Dispatch return pickup" button after washing', 'driver dispatch' in dt.lower() and 'Dispatch return pickup' in dt, dt[-300:])
        page.screenshot(path=str(SHOTS / 'dispatcher-dispatch.png'))
        page.goto(f'{base}/index.html#/orders/{ORDER}'); wait_page(page)
        check('order page shows dispatch states per stage', 'Driver dispatch' in page.inner_text('main') and 'Declined' in page.inner_text('main') and 'Washing is not completed yet' in page.inner_text('main'))
        page.click('[data-act=dispatch]')
        page.wait_for_selector('.modal .route-preview')
        mtext = page.inner_text('.modal')
        check('dispatch modal previews street-to-street route', 'Maple Avenue' in mtext and 'Other St' in mtext and 'revealed only to the driver who accepts' in mtext)
        page.click('.modal button[type=submit]')
        page.wait_for_selector('.modal', state='detached')
        sent = [w for w in page.evaluate('window.__writes') if w.get('rpc') == 'dispatch_task']
        check('dispatch sends the offer to all drivers by default', sent and sent[-1]['args']['p_person_ids'] is None, sent)
        page.screenshot(path=str(SHOTS / 'order-dispatch.png'))

        # post jobs to WhatsApp: numbered preview, channels, and the post call
        page.goto(f'{base}/index.html#/dispatch'); wait_page(page)
        page.click('[data-action=post-jobs]')
        page.wait_for_selector('.modal .post-jobs')
        page.wait_for_function("() => (document.querySelector('[data-preview]')?.textContent || '').includes('1. Return collection')", timeout=3000)
        mtext = page.inner_text('.modal')
        check('post jobs lists only ready, unassigned jobs', 'Return collection' in mtext and 'Final delivery' not in mtext.split('Message preview')[0], mtext[:300])
        check('post jobs shows WhatsApp group on and SMS off until set up', page.is_checked('.modal input[name=ch_whatsapp]') and page.is_disabled('.modal input[name=ch_sms]') and 'Kvisa Drivers' in mtext)
        page.screenshot(path=str(SHOTS / 'post-jobs.png'))
        page.click('.modal button[type=submit]')
        page.wait_for_selector('.modal', state='detached')
        writes = page.evaluate('window.__writes')
        posted = [w for w in writes if w.get('rpc') == 'post_jobs']
        check('post sends the chosen jobs to the WhatsApp group', posted and posted[-1]['args']['p_channels'] == ['whatsapp'] and posted[-1]['args']['p_task_ids'] == ['33333333-3333-3333-3333-333333333334'], posted)
        check('posting triggers sending right away', any(w.get('fn') == 'messaging' and w['body'] == {'action': 'send'} for w in writes))

        # messages page: covered jobs, failed sends can be retried, incoming text is escaped
        errors.clear()
        page.goto(f'{base}/index.html#/messages'); wait_page(page)
        mt = page.inner_text('main')
        check('messages page shows posts, replies and sends', 'Covered' in mt and 'Avi Driver' in mt and 'Took a job' in mt and 'Unknown number' in mt and 'HTTP 401: bad token' in mt, mt[:400])
        check('incoming message text is escaped', '<script>alert(2)</script>' in mt and not errors, errors[:2])
        page.click('[data-retry=mo2]'); page.wait_for_timeout(300)
        check('failed message can be sent again', any(w.get('rpc') == 'outbox_retry' and w['args'] == {'p_id': 'mo2'} for w in page.evaluate('window.__writes')))

        # settings: WhatsApp group picker
        page.goto(f'{base}/index.html#/settings'); wait_page(page)
        page.click('#messaging summary')
        page.wait_for_function("() => (document.querySelector('[data-msg-status]')?.textContent || '').includes('WhatsApp: connected')", timeout=3000)
        page.click('[data-action=load-groups]')
        page.wait_for_function("() => document.querySelectorAll('[data-groups] option').length === 3", timeout=3000)
        page.select_option('[data-groups]', '120363000000000002@g.us')
        page.click('#messaging button.btn-primary')
        page.wait_for_timeout(400)
        upd = [w for w in page.evaluate('window.__writes') if w.get('table') == 'organization_settings' and w.get('op') == 'update']
        check('settings save the chosen WhatsApp group', upd and upd[-1]['values']['wa_group_id'] == '120363000000000002@g.us' and upd[-1]['values']['wa_group_name'] == 'Family', upd[-1:] if upd else upd)
        page.screenshot(path=str(SHOTS / 'settings-messaging.png'))

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
        check('driver lands on Available jobs when a job is offered', 'Available jobs (1)' in text and 'Main Street' in text and 'Maple Avenue' in text and not merr, merr[:3])
        check('job offer shows streets only (no house number)', 'The exact address appears after you accept' in text and not any(ch.isdigit() for ch in text.split('Main Street')[1].split('When')[0]))
        mob.screenshot(path=str(SHOTS / 'driver-offer.png'))
        mob.click('button[data-accept="1"]')
        mob.wait_for_timeout(400)
        writes = mob.evaluate('window.__writes')
        acc = [w for w in writes if w.get('rpc') == 'respond_offer']
        check('Accept call sends an atomic accept to the server', acc and acc[-1]['args'] == {'p_offer_id': 'off2', 'p_accept': True}, acc)
        mob.goto(f'{base}/index.html#/my-tasks?tab=today'); wait_page(mob)
        text = mob.inner_text('main')
        check('driver sees assigned task with exact address (mobile)', 'Return collection' in text and '2 Wash Ave' in text and not merr, merr[:3])
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
