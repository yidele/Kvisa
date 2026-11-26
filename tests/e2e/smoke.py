"""Browser smoke tests: every page renders without JavaScript errors, key flows open,
and user text is escaped. Uses a fake Supabase client (tests/e2e/fake-supabase.js), so it
needs no network or database. Run: python3 tests/e2e/smoke.py  (requires Python Playwright + Chromium;
set CHROMIUM_PATH to use an already-installed Chromium)
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
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
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

        check('office app keeps its own K mark (the tablet logo is only in the tablet app)',
              page.inner_text('.sidebar .brand .logo').strip() == 'K' and page.query_selector('.sidebar img') is None)

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

        # ---- walk-up tablet (kiosk login) ----
        tctx = browser.new_context(viewport={'width': 1280, 'height': 800}, has_touch=True)
        tab = tctx.new_page()
        terr = []
        tab.on('pageerror', lambda e: terr.append(f'pageerror: {e}'))
        tab.on('console', lambda m: terr.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        tab.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        tab.add_init_script("localStorage.setItem('fakeRole','kiosk'); localStorage.removeItem('fakeLoggedOut'); window.__prints = 0; window.print = () => { window.__prints++; };")
        rpcs = lambda name: [w for w in tab.evaluate('window.__writes') if w.get('rpc') == name]
        no_overflow = lambda: not tab.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2')
        tab.goto(f'{base}/index.html')
        tab.wait_for_url('**/tablet/**')
        tab.wait_for_selector('.kiosk-welcome')
        check('a tablet login opening the main app is sent to the tablet app', '/tablet/' in tab.url, tab.url)
        wt = tab.inner_text('.kiosk')
        check('1 welcome: logo and Hebrew / English / Yiddish', tab.evaluate("document.querySelector('.kiosk-mark').naturalWidth > 0 && document.querySelector('.kiosk-logo img') === null") and 'Kvisa Test Org' in wt
              and 'עברית' in wt and 'English' in wt and 'אידיש' in wt and tab.query_selector('.sidebar') is None and not terr, terr[:3])
        tab.screenshot(path=str(SHOTS / 'tablet-1-welcome.png'))
        tab.goto(f'{base}/index.html#/settings'); tab.wait_for_url('**/tablet/**'); tab.wait_for_selector('.kiosk-welcome')
        check('tablet login cannot open office pages', 'Settings' not in tab.inner_text('body'))

        # Yiddish: how it works, right-to-left
        tab.click('[data-lang=yi]'); tab.wait_for_selector('.kiosk-how')
        check('2 Yiddish "how it works" is right-to-left, with Continue and "I have an ID number"', tab.get_attribute('.kiosk', 'dir') == 'rtl'
              and 'ווי אזוי עס ארבעט' in tab.inner_text('.kiosk') and 'איך האב אן ID נומער' in tab.inner_text('.kiosk') and len(tab.query_selector_all('.kiosk-how li')) == 4)
        tab.screenshot(path=str(SHOTS / 'tablet-2-info-yi.png'))
        tab.click('.kiosk-back'); tab.wait_for_selector('.kiosk-welcome')

        # English drop-off, start to finish
        tab.click('[data-lang=en]'); tab.wait_for_selector('.kiosk-how')
        it = tab.inner_text('.kiosk')
        check('2 English "how it works" mentions about 2 days', 'How it works' in it and '2 days' in it and tab.get_attribute('.kiosk', 'dir') == 'ltr', it)
        tab.screenshot(path=str(SHOTS / 'tablet-2-info-en.png'))
        tab.click('[data-go=form]'); tab.wait_for_selector('form[data-form=dropoff]')
        tab.click('.kiosk-submit'); tab.wait_for_selector('.kiosk-err')
        et = tab.inner_text('form')
        check('3 empty form explains what is missing (Israeli number not required) and sends nothing',
              'Please type your first name' in et and 'Please type a valid phone number' in et and et.count('Please') == 3 and not rpcs('kiosk_submit'), et)
        ft = tab.inner_text('form')
        check('3 form asks first, middle (optional), last name, phone here and phone in Israel', all(x in ft for x in
              ['First name', 'Middle name', '(optional)', 'Last name', 'Phone number here (America)', 'Phone number in Israel', 'How many bags?']), ft)
        tab.fill('input[name=first]', 'Moshe'); tab.fill('input[name=last]', 'Levi')
        tab.fill('input[name=phone]', '718-555-0101'); tab.fill('input[name=israel]', '12')
        tab.click('[data-k=more]'); tab.click('[data-k=more]')
        check('3 bag stepper counts up', tab.inner_text('.kiosk-bags').strip() == '3')
        tab.screenshot(path=str(SHOTS / 'tablet-3-form.png'))
        tab.click('.kiosk-submit'); tab.wait_for_selector('.kiosk-labels')
        pt = tab.inner_text('.kiosk-labels')
        check('4 preview shows one label per bag plus a receipt, before anything is sent',
              len(tab.query_selector_all('.k-mini')) == 4 and len(tab.query_selector_all('.k-mini.receipt')) == 1 and 'Bag 3 of 3' in pt
              and 'Confirm & print' in pt and not rpcs('kiosk_submit') and tab.evaluate('window.__prints') == 0, pt)
        tab.screenshot(path=str(SHOTS / 'tablet-4-preview.png'))
        tab.click('[data-go=form]'); tab.wait_for_selector('form[data-form=dropoff]')
        check('4 Change details goes back with everything kept', tab.input_value('input[name=first]') == 'Moshe' and tab.inner_text('.kiosk-bags').strip() == '3')
        tab.click('.kiosk-submit'); tab.wait_for_selector('.kiosk-labels')
        tab.click('[data-k=confirm]'); tab.wait_for_selector('.kiosk-summary'); tab.wait_for_timeout(300)
        a = rpcs('kiosk_submit')[-1]['args'] if rpcs('kiosk_submit') else {}
        check('5 Confirm sends the details once', len(rpcs('kiosk_submit')) == 1 and a.get('p_first') == 'Moshe' and a.get('p_last') == 'Levi'
              and a.get('p_phone') == '718-555-0101' and a.get('p_israel_phone') == '12' and a.get('p_bags') == 3 and len(a.get('p_request_key', '')) == 36, a)
        check('5 prints one label per bag plus the receipt', tab.evaluate('window.__prints') == 1 and len(tab.query_selector_all('#kiosk-print .k-label')) == 4
              and len(tab.query_selector_all('#kiosk-print .k-label.receipt')) == 1 and 'ID 1015' in tab.inner_text('#kiosk-print .receipt'))
        check('5 the completed page shows the printed labels with the real ID', len(tab.query_selector_all('.kiosk-summary .k-mini')) == 4
              and 'K-1015' in tab.inner_text('.kiosk-summary .kiosk-minis') and 'ID 1015' in tab.inner_text('.kiosk-summary .k-mini.receipt'))
        st = tab.inner_text('.kiosk-summary')
        check('5 completed page shows the ID, details and how to cancel', all(x in st for x in
              ['Completed!', '1015', 'Moshe <b>Levi</b>', '718-555-0101', '052-123-4567', 'taking your bags back', 'I have an ID number']), st)
        check('5 completed page fits the tablet', no_overflow() and not terr, terr[:3])
        tab.screenshot(path=str(SHOTS / 'tablet-5-completed.png'), full_page=True)
        tab.emulate_media(media='print')
        tab.pdf(path=str(SHOTS / 'tablet-labels.pdf'), prefer_css_page_size=True, print_background=True)
        tab.emulate_media(media='screen')
        tab.click('[data-k=print]'); tab.wait_for_timeout(300)
        check('Print again reprints', tab.evaluate('window.__prints') == 2)
        tab.click('[data-go=welcome]'); tab.wait_for_selector('.kiosk-welcome')
        check('Finish returns to the welcome screen with nothing left over', tab.inner_text('#kiosk-print').strip() == '')

        # I have an ID number → waiting → cancel
        tab.click('[data-lang=en]'); tab.click('[data-go=lookup]'); tab.wait_for_selector('form[data-form=lookup]')
        tab.fill('input[name=id]', '1016'); tab.fill('input[name=last4]', '0000'); tab.click('.kiosk-submit')
        tab.wait_for_selector('.notice-error')
        check('6 a wrong ID or digits gets a clear message', "didn't find a drop-off" in tab.inner_text('.notice-error'))
        tab.fill('input[name=id]', 'K-1016'); tab.fill('input[name=last4]', '4567'); tab.click('.kiosk-submit')
        tab.wait_for_selector('.kiosk-status')
        la = rpcs('kiosk_lookup')[-1]['args']
        sv = tab.inner_text('.kiosk-status')
        check('6 ID lookup shows "waiting for pickup" and a cancel button', la == {'p_order_no': 1016, 'p_last4': '4567'}
              and 'Waiting for pickup' in sv and 'Cancel my drop-off' in sv, (la, sv))
        tab.screenshot(path=str(SHOTS / 'tablet-6-waiting.png'))
        tab.click('[data-k=cancel-ask]'); tab.wait_for_selector('.kiosk-confirm')
        tab.click('[data-k=keep]'); tab.wait_for_selector('.kiosk-cancel')
        check('6 "No, keep it" cancels nothing', not rpcs('kiosk_cancel'))
        tab.click('[data-k=cancel-ask]'); tab.click('[data-k=cancel-yes]'); tab.wait_for_selector('.kiosk-state.cancelled')
        check('6 "Yes, cancel" cancels it', rpcs('kiosk_cancel')[-1]['args'] == {'p_order_no': 1016, 'p_last4': '4567'}
              and 'was cancelled' in tab.inner_text('.kiosk-status') and tab.query_selector('.kiosk-cancel') is None)
        tab.screenshot(path=str(SHOTS / 'tablet-6-cancelled.png'))
        tab.click('.kiosk-back'); tab.wait_for_selector('form[data-form=lookup]')
        tab.fill('input[name=id]', '1009'); tab.fill('input[name=last4]', '4567'); tab.click('.kiosk-submit')
        tab.wait_for_selector('.kiosk-state.picked_up')
        check('6 once picked up there is no cancel button', 'Picked up' in tab.inner_text('.kiosk-status') and tab.query_selector('.kiosk-cancel') is None)
        check('6 status page fits the tablet', no_overflow() and not terr, terr[:3])
        tab.click('[data-go=welcome]'); tab.wait_for_selector('.kiosk-welcome')

        # a second person gets a new request key
        tab.click('[data-lang=he]'); tab.click('[data-go=form]'); tab.wait_for_selector('form[data-form=dropoff]')
        check('Hebrew form is right-to-left and starts blank', tab.get_attribute('.kiosk', 'dir') == 'rtl' and tab.input_value('input[name=first]') == '')
        tab.fill('input[name=first]', 'Dovid'); tab.fill('input[name=last]', 'Klein'); tab.fill('input[name=phone]', '0529999999')
        tab.click('.kiosk-submit'); tab.click('[data-k=confirm]'); tab.wait_for_selector('.kiosk-summary')
        keys = [w['args']['p_request_key'] for w in rpcs('kiosk_submit')]
        check('each new person gets a new request key', len(keys) == 2 and keys[0] != keys[1], keys)
        tab.click('[data-go=welcome]'); tab.wait_for_selector('.kiosk-welcome')

        # leave tablet mode
        tab.click('[data-lang=en]'); tab.wait_for_selector('.kiosk-how')
        for _ in range(5): tab.click('[data-k=logo]')
        tab.wait_for_selector('.modal input[type=password]')
        tab.fill('.modal input[type=password]', 'wrong'); tab.click('.modal button[type=submit]')
        tab.wait_for_selector('.modal .form-error:not([hidden])')
        check('leaving tablet mode needs the password', 'Wrong password' in tab.inner_text('.modal') and not tab.evaluate('window.__signedOut || false'))
        tab.fill('.modal input[type=password]', 'right-password'); tab.click('.modal button[type=submit]')
        tab.wait_for_timeout(300)
        check('right password signs the tablet out', tab.evaluate('window.__signedOut === true'))
        tctx.close()

        # the same screens on a small phone-sized window
        sctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        sm = sctx.new_page()
        sm.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        sm.add_init_script("localStorage.setItem('fakeRole','kiosk'); localStorage.removeItem('fakeLoggedOut'); window.print = () => {};")
        sm.goto(f'{base}/tablet/'); sm.wait_for_selector('.kiosk-welcome')
        fits = lambda: not sm.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2')
        ok = [fits()]
        sm.click('[data-lang=he]'); sm.wait_for_selector('.kiosk-how'); ok.append(fits())
        sm.click('[data-go=form]'); sm.wait_for_selector('form[data-form=dropoff]'); ok.append(fits())
        sm.fill('input[name=first]', 'א'); sm.fill('input[name=last]', 'ב'); sm.fill('input[name=phone]', '0529999999')
        sm.click('[data-k=more]'); sm.click('[data-k=more]'); sm.click('[data-k=more]')
        sm.click('.kiosk-submit'); sm.wait_for_selector('.kiosk-labels'); ok.append(fits())
        check('tablet screens also fit a small screen', all(ok), ok)
        sctx.close()

        # the separate tablet app: staff can try it with their own account
        sp, serr = new_page(browser, base)
        sp.goto(f'{base}/index.html#/settings'); wait_page(sp)
        stext = sp.text_content('main')
        check('settings has the tablet section, its address and the Tablet role', 'Tablet (walk-up screen)' in stext and 'Open the tablet app' in stext and '/tablet/' in stext)
        sp.goto(f'{base}/tablet/')
        sp.wait_for_selector('.kiosk-welcome')
        check('staff can run the tablet app', sp.query_selector('.sidebar') is None and not serr, serr[:3])
        check('tablet app is installable (manifest)', sp.evaluate("fetch('manifest.webmanifest').then(r => r.json()).then(m => m.display + '|' + m.start_url)") == 'fullscreen|./')
        sp.close()
        so, soerr = new_page(browser, base, logged_out=True)
        so.goto(f'{base}/tablet/')
        so.wait_for_selector('.auth-card form')
        check('signed-out tablet app offers sign in and create account', 'Create account' in so.inner_text('.auth-card') and not soerr, soerr[:3])
        so.fill('input[name=email]', 'x@y.z'); so.fill('input[name=password]', 'nope'); so.click('button[type=submit]')
        so.wait_for_selector('.notice-error')
        check('tablet sign-in explains a wrong password', 'incorrect' in so.inner_text('.notice-error') and so.input_value('input[name=email]') == 'x@y.z')
        so.click('[data-mode=signup]')
        check('tablet app can create an invited account', so.query_selector('form[data-form=signup] input[name=password2]') is not None)
        so.screenshot(path=str(SHOTS / 'tablet-signin.png'))
        so.close()

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
