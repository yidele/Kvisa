// Walk-up tablet screens:
//   welcome (language) → how it works → details → label preview → (confirm & print) → completed
//                      → "I have an ID number" (ID + last 4 phone digits) → waiting / picked up, cancel while waiting
// Full screen, no navigation to the rest of Kvisa, returns to the welcome screen when left alone.
import { sb, rpc, state, settings } from '../lib/api.js';
import { html, raw, setHtml, $, on } from '../lib/dom.js';
import { orderNo, fmtDate, friendlyError } from '../lib/format.js';
import { TEXT, LANGS, LABEL_SIZES, checkDropOff, checkLookup, labelPages, hebrewDate, localDate } from '../lib/kiosk.js';
import { APP_NAME } from '../config.js';
import { LOGO_WHITE } from '../lib/app.js';
import { attachKeyboard } from '../components/kioskKeyboard.js';

// Seconds without a touch before a screen goes back to the welcome screen.
const IDLE = { info: 60, form: 120, preview: 120, lookup: 90, status: 90 };
const DONE_SECONDS = 60;      // the completed screen counts down visibly, then starts over

const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const blankForm = () => ({ first: '', middle: '', last: '', phone: '', israel: '', bags: 1 });

// Boxes typed with the in-app keyboard: read-only to the browser, so the Windows keyboard never opens.
const KB = Object.fromEntries(['name', 'phone', 'digits'].map((k) => [k, raw(`data-kbd="${k}" readonly inputmode="none"`)]));

const ICON_ID = raw('<svg class="kiosk-ic sm" viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="11" width="36" height="26" rx="4"/><path d="M13 20h10M13 27h16M33 20h2"/></svg>');

// Leaving the screen (5 taps on the logo) asks for the signed-in account's password, then closes the app.
export function render(container) {
  const s = settings();
  const org = s.org_name || APP_NAME;
  const maxBags = s.kiosk_max_bags || 20;
  const labelSize = s.label_size || '4x6';
  let lang = 'he';
  let screen = 'welcome';
  let form = blankForm();
  let errors = {};
  let banner = '';
  let busy = false;
  let result = null;        // the drop-off just made
  let requestKey = newKey();
  let lookupForm = { id: '', last4: '' };
  let found = null;         // the drop-off found by ID
  let confirmingCancel = false;
  let lastActivity = Date.now();
  let doneLeft = 0;
  let taps = [];
  const t = () => TEXT[lang];
  const dir = () => LANGS[lang].dir;

  setHtml(container, html`<div class="kiosk"><div class="kiosk-screen"></div></div><div id="kiosk-print" aria-hidden="true"></div>`);
  const shell = $('.kiosk', container);
  const body = $('.kiosk-screen', container);
  const printArea = $('#kiosk-print', container);
  const pageStyle = document.createElement('style');
  const sizes = LABEL_SIZES[labelSize] || LABEL_SIZES['4x6'];
  pageStyle.textContent = `@page { size: ${sizes.css}; margin: 0; } @page receipt { size: ${sizes.receipt}; margin: 0; }`;
  document.head.appendChild(pageStyle);
  document.body.classList.add('kiosk-mode');
  const kb = attachKeyboard(shell, { text: () => TEXT[lang], lettersFor: () => (lang === 'en' ? 'en' : 'he') });

  // ---------------- screens ----------------
  const head = (backTo) => html`<header class="kiosk-head">
    <button type="button" class="kiosk-logo" data-k="logo" aria-label="${org}"><img src="${LOGO_WHITE}" alt=""></button>
    <span class="kiosk-org">${org}</span>
    ${backTo ? html`<button type="button" class="btn kiosk-back" data-go="${backTo}">${dir() === 'rtl' ? '→' : '←'} ${t().back}</button>` : ''}
  </header>`;
  const err = (k) => (errors[k] ? html`<small class="kiosk-err" id="err-${k}">${errors[k]}</small>` : '');
  const inv = (k) => (errors[k] ? raw(`aria-invalid="true" aria-describedby="err-${k}"`) : '');
  const bannerBox = () => (banner ? html`<div class="notice notice-error" role="alert">${banner}</div>` : '');
  const when = (v) => fmtDate(v, s.time_zone);
  const fullName = () => [form.first, form.middle, form.last].map((x) => x.trim()).filter(Boolean).join(' ');

  const miniBag = (no, p) => html`<div class="k-mini">
    <span class="k-mini-put" dir="auto">${t().labelPut}</span><span class="k-mini-no">${no}</span>
    <span class="k-mini-foot">${t().bagOf(p.index, p.of)}</span></div>`;
  const miniReceipt = (id, name, bags) => html`<div class="k-mini receipt">
    <span class="k-mini-tag">${t().receipt}</span><span class="k-mini-no">ID ${id}</span>
    <span class="k-mini-name" dir="auto">${name}</span><span class="k-mini-foot">${bags} ${t().bagsWord}</span></div>`;

  const screens = {
    welcome: () => html`<div class="kiosk-welcome">
      <button type="button" class="kiosk-brand" data-k="logo" aria-label="${org}"><img class="kiosk-mark" src="${LOGO_WHITE}" alt=""></button>
      <h1 class="kiosk-welcome-name">${org}</h1>
      <p class="kiosk-taglines"><span lang="he" dir="rtl">${TEXT.he.tagline}</span><span lang="en" dir="ltr">${TEXT.en.tagline}</span><span lang="yi" dir="rtl">${TEXT.yi.tagline}</span></p>
      <div class="kiosk-langs">${Object.entries(LANGS).map(([k, l]) =>
        html`<button type="button" class="kiosk-lang-btn" data-lang="${k}" lang="${k}" dir="${l.dir}">${l.name}</button>`)}</div>
    </div>`,

    info: () => html`${head('welcome')}<div class="kiosk-body"><section class="kiosk-card kiosk-info-page">
      <h1>${t().infoTitle}</h1>
      <ol class="kiosk-how">${t().infoSteps.map((x, i) => html`<li><span class="kiosk-how-no" aria-hidden="true">${i + 1}</span><span>${x}</span></li>`)}</ol>
      <button type="button" class="btn btn-primary btn-lg btn-block kiosk-submit" data-go="form">${t().continue}</button>
      <button type="button" class="kiosk-idlink" data-go="lookup">${ICON_ID}<span><strong>${t().haveId}</strong><small>${t().haveIdSub}</small></span></button>
    </section></div>`,

    form: () => html`${head('info')}<div class="kiosk-body"><form class="kiosk-card" data-form="dropoff" novalidate autocomplete="off">
      <h1>${t().formTitle}</h1>
      ${bannerBox()}
      <div class="kiosk-names">
        <label class="field kiosk-field"><span>${t().first}</span>
          <input name="first" value="${form.first}" maxlength="40" ${KB.name} dir="auto" ${inv('first')}>${err('first')}</label>
        <label class="field kiosk-field"><span>${t().middle} <small class="muted">${t().optional}</small></span>
          <input name="middle" value="${form.middle}" maxlength="40" ${KB.name} dir="auto"></label>
        <label class="field kiosk-field"><span>${t().last}</span>
          <input name="last" value="${form.last}" maxlength="40" ${KB.name} dir="auto" ${inv('last')}>${err('last')}</label>
      </div>
      <div class="kiosk-phones">
        <label class="field kiosk-field"><span>${t().phoneHere}</span>
          <input name="phone" value="${form.phone}" maxlength="25" ${KB.phone} dir="ltr" ${inv('phone')}>${err('phone')}</label>
        <label class="field kiosk-field"><span>${t().phoneIsrael}</span>
          <input name="israel" value="${form.israel}" maxlength="30" ${KB.phone} dir="ltr"></label>
      </div>
      <div class="field kiosk-field"><span id="bags-label">${t().bags}</span>
        <div class="kiosk-stepper" role="group" aria-labelledby="bags-label">
          <button type="button" class="btn" data-k="less" aria-label="${t().less}">−</button>
          <output class="kiosk-bags" aria-live="polite">${form.bags}</output>
          <button type="button" class="btn" data-k="more" aria-label="${t().more}">+</button>
        </div>${err('bags')}</div>
      <button type="submit" class="btn btn-primary btn-lg btn-block kiosk-submit">${t().next}</button>
    </form></div>`,

    preview: () => html`${head('form')}<div class="kiosk-body"><section class="kiosk-card kiosk-labels">
      <h1>${t().previewTitle}</h1>
      ${bannerBox()}
      <p class="kiosk-sub">${t().previewText(form.bags)}</p>
      <div class="kiosk-minis" dir="ltr">
        ${labelPages(form.bags).map((p) => miniBag('K-····', p))}
        ${miniReceipt('····', fullName(), form.bags)}
      </div>
      <div class="kiosk-actions">
        <button type="button" class="btn btn-lg" data-go="form">${t().edit}</button>
        <button type="button" class="btn btn-lg btn-primary" data-k="confirm" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().confirm}</button>
      </div></section></div>`,

    done: () => html`${head(null)}<div class="kiosk-body"><section class="kiosk-card kiosk-summary" aria-live="polite">
      <div class="kiosk-check" aria-hidden="true">✓</div>
      <h1>${t().doneTitle}</h1>
      <p class="kiosk-printing"><span class="spinner"></span>${t().printing}</p>
      <p class="kiosk-sub">${t().stick(result.bags)}</p>
      <div class="kiosk-minis" dir="ltr">
        ${labelPages(result.bags).map((p) => miniBag(orderNo(result.order_no), p))}
        ${miniReceipt(result.order_no, result.name, result.bags)}
      </div>
      <p class="kiosk-sub">${t().yourId}</p>
      <div class="kiosk-orderno" dir="ltr">${result.order_no}</div>
      <dl class="kiosk-info">
        <div><dt>${t().name}</dt><dd dir="auto">${result.name}</dd></div>
        <div><dt>${t().bagsCount}</dt><dd>${result.bags}</dd></div>
        <div><dt>${t().phoneHere}</dt><dd dir="ltr">${result.phone}</dd></div>
        ${result.israel_phone ? html`<div><dt>${t().phoneIsrael}</dt><dd dir="ltr">${result.israel_phone}</dd></div>` : ''}
        <div><dt>${t().date}</dt><dd>${when(result.created_at)}</dd></div>
      </dl>
      <div class="kiosk-warn"><strong>${t().cancelNote}</strong><span>${t().howLogin}</span></div>
      <div class="kiosk-actions">
        <button type="button" class="btn btn-lg" data-k="print">${t().printAgain}</button>
        <button type="button" class="btn btn-lg btn-primary" data-go="welcome">${t().finish}</button>
      </div>
      <p class="muted kiosk-countdown">${t().resetIn(doneLeft)}</p>
    </section></div>`,

    lookup: () => html`${head('info')}<div class="kiosk-body"><form class="kiosk-card" data-form="lookup" novalidate autocomplete="off">
      <h1>${t().lookupTitle}</h1>
      ${bannerBox()}
      <label class="field kiosk-field"><span>${t().idLabel}</span>
        <input name="id" value="${lookupForm.id}" maxlength="9" ${KB.digits} dir="ltr" ${inv('id')}>${err('id')}</label>
      <label class="field kiosk-field"><span>${t().last4}</span>
        <input name="last4" value="${lookupForm.last4}" maxlength="4" ${KB.digits} dir="ltr" ${inv('last4')}>${err('last4')}</label>
      <button type="submit" class="btn btn-primary btn-lg btn-block kiosk-submit" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().find}</button>
    </form></div>`,

    status: () => html`${head('lookup')}<div class="kiosk-body"><section class="kiosk-card kiosk-status">
      <h1>${t().statusTitle}</h1>
      ${bannerBox()}
      <div class="kiosk-found">
        <div class="kiosk-found-head"><span dir="ltr">ID ${found.order_no}</span><span>${found.bags} ${t().bagsWord} · ${when(found.created_at)}</span></div>
        <p class="kiosk-state ${found.state}">${t()['state_' + found.state]}</p>
        ${found.state === 'waiting' ? html`<p class="kiosk-sub">${t().waitingNote}</p>` : ''}
        ${found.state === 'picked_up' ? html`<p class="kiosk-sub">${t().pickedNote}</p>` : ''}
        ${found.state === 'cancelled' && found.justCancelled ? html`<p class="kiosk-sub">${t().cancelledMsg}</p>` : ''}
      </div>
      ${found.can_cancel ? (confirmingCancel ? html`<div class="kiosk-confirm">
          <strong>${t().confirmCancelTitle}</strong><span>${t().confirmCancelText}</span>
          <div class="kiosk-actions">
            <button type="button" class="btn btn-lg" data-k="keep">${t().noKeep}</button>
            <button type="button" class="btn btn-lg btn-danger" data-k="cancel-yes" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().yesCancel}</button>
          </div></div>`
        : html`<button type="button" class="btn btn-lg btn-block kiosk-cancel" data-k="cancel-ask">${t().cancelBtn}</button>`) : ''}
      <button type="button" class="btn btn-lg btn-primary kiosk-finish" data-go="welcome">${t().finish}</button>
    </section></div>`,
  };

  function draw() {
    shell.setAttribute('dir', screen === 'welcome' ? 'ltr' : dir());
    shell.setAttribute('lang', screen === 'welcome' ? 'en' : lang);
    shell.dataset.screen = screen;
    setHtml(body, screens[screen]());
    const first = $('input[aria-invalid=true]', body);
    if (first) kb.open(first); else kb.refresh();
  }

  function go(next) {
    readForms();
    errors = {}; banner = ''; confirmingCancel = false;
    kb.close();
    if (next === 'welcome') { reset(); return; }
    if (next === 'lookup' && screen !== 'status') { lookupForm = { id: '', last4: '' }; }
    if (next === 'done') doneLeft = DONE_SECONDS;
    screen = next;
    lastActivity = Date.now();
    draw();
    window.scrollTo(0, 0);
  }

  function readForms() {
    const f = $('form[data-form=dropoff]', body);
    if (f) form = { ...form, first: f.elements.first.value, middle: f.elements.middle.value, last: f.elements.last.value,
      phone: f.elements.phone.value, israel: f.elements.israel.value };
    const lf = $('form[data-form=lookup]', body);
    if (lf) lookupForm = { id: lf.elements.id.value, last4: lf.elements.last4.value };
  }

  function reset() {
    kb.close();
    screen = 'welcome'; lang = 'he';
    form = blankForm(); lookupForm = { id: '', last4: '' }; found = null; confirmingCancel = false;
    result = null; errors = {}; banner = ''; busy = false;
    requestKey = newKey();
    setHtml(printArea, '');
    draw();
  }

  // One label per bag, then one receipt for the person. Bag labels carry only the order number and what to do,
  // in English, plus Hebrew or Yiddish after a slash when that was the screen language. The receipt is in the
  // person's language, with the Hebrew date for Hebrew and Yiddish.
  function renderLabels() {
    const r = result;
    const tl = TEXT[lang];
    // English, then (for Hebrew / Yiddish) a slash and the same words on their own line, so the two never mix
    const also = (en, other) => (lang === 'en' ? en : html`<span class="k-l1">${en} /</span><span class="k-l1" dir="rtl" lang="${lang}">${other}</span>`);
    setHtml(printArea, html`${labelPages(r.bags).map((p) => html`<div class="k-label bag" data-size="${labelSize}">
      <div class="k-label-put">${also(TEXT.en.labelPut, tl.labelPut)}</div>
      <div class="k-label-no">${orderNo(r.order_no)}</div>
      <div class="k-label-foot">${also(TEXT.en.bagOf(p.index, p.of), tl.bagOf(p.index, p.of))}</div>
    </div>`)}<div class="k-label receipt" data-size="${labelSize}" dir="${LANGS[lang].dir}" lang="${lang}">
      <div class="k-label-title">${tl.receiptTitle}</div>
      <div class="k-label-no" dir="ltr">ID ${r.order_no}</div>
      <div class="k-label-name" dir="auto">${r.name}</div>
      <div class="k-label-phone" dir="ltr">${r.phone}</div>
      <div class="k-label-line">${r.bags} ${tl.bagsWord}</div>
      <div class="k-label-line">${localDate(r.created_at, lang, s.time_zone)}</div>
      ${lang === 'en' ? '' : html`<div class="k-label-line">${hebrewDate(r.created_at, s.time_zone)}</div>`}
      <div class="k-label-cancel">${tl.receiptCancel}</div>
    </div>`);
  }

  function printLabels() { setTimeout(() => window.print(), 150); }

  function failed(e) {
    const msg = friendlyError(e.raw || e);
    return /reach the server/.test(msg) || !navigator.onLine ? t().errOffline : `${t().errServer} (${msg})`;
  }

  function toPreview() {
    readForms();
    const c = checkDropOff(form, maxBags, lang);
    errors = c.errors; banner = '';
    if (!c.ok) { draw(); return; }
    form = { ...form, ...c.value };
    go('preview');
  }

  async function confirmAndPrint() {
    busy = true; banner = ''; draw();
    try {
      result = await rpc('kiosk_submit', { p_first: form.first, p_middle: form.middle, p_last: form.last,
        p_phone: form.phone, p_israel_phone: form.israel, p_bags: form.bags, p_request_key: requestKey });
      busy = false;
      renderLabels();
      go('done');
      printLabels();
    } catch (e) {
      // keep the same request key: a retry after a lost reply must not create a second order
      busy = false;
      banner = failed(e);
      draw();
    }
  }

  async function lookUp() {
    readForms();
    const c = checkLookup(lookupForm, lang);
    errors = c.errors; banner = '';
    if (!c.ok) { draw(); return; }
    busy = true; draw();
    try {
      found = await rpc('kiosk_lookup', { p_order_no: c.value.id, p_last4: c.value.last4 });
      found.last4 = c.value.last4;
      busy = false;
      go('status');
    } catch (e) {
      busy = false;
      banner = /KVISA_NOT_FOUND/.test(String(e.raw?.message || e.message)) ? t().notFound : failed(e);
      draw();
    }
  }

  async function cancelDropOff() {
    busy = true; draw();
    try {
      await rpc('kiosk_cancel', { p_order_no: found.order_no, p_last4: found.last4 });
      found = { ...found, state: 'cancelled', can_cancel: false, justCancelled: true };
    } catch (e) {
      banner = failed(e);
    } finally {
      busy = false; confirmingCancel = false;
      draw();
    }
  }

  async function exitTablet() {
    kb.close();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('dir', 'ltr');   // for the office, always in English
    setHtml(overlay, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="kx-title"><form class="modal-form" novalidate>
      <header class="modal-head"><h2 id="kx-title">Leave tablet mode</h2></header>
      <div class="modal-body"><p>Type the tablet account's password to close the app.</p>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password"></label></div>
      <div class="form-error" role="alert" hidden></div>
      <footer class="modal-foot"><button type="button" class="btn" data-x="cancel">Cancel</button>
        <button type="submit" class="btn btn-danger">Leave</button></footer></form></div>`);
    container.appendChild(overlay);
    const f = $('form', overlay);
    f.elements.password.focus();
    $('[data-x=cancel]', overlay).onclick = () => overlay.remove();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: state.ctx.email, password: f.elements.password.value });
      if (error) { const box = $('.form-error', overlay); box.textContent = 'Wrong password.'; box.hidden = false; return; }
      overlay.remove();
      // Close the browser window (the tablet opens it full screen with nothing else), which leaves the
      // tablet on the Windows desktop and keeps the login. If the browser refuses, sign out instead.
      window.close();
      setTimeout(() => { if (!window.closed) sb.auth.signOut(); }, 600);
    };
  }

  const offs = [
    on(container, 'click', '[data-lang]', (e, el) => { lang = el.dataset.lang; go('info'); }),
    on(container, 'click', '[data-go]', (e, el) => go(el.dataset.go)),
    on(container, 'click', '[data-k]', (e, el) => {
      const k = el.dataset.k;
      if (k === 'less' || k === 'more') {
        form.bags = Math.min(maxBags, Math.max(1, form.bags + (k === 'more' ? 1 : -1)));
        $('.kiosk-bags', body).textContent = form.bags;
      } else if (k === 'confirm') { if (!busy) confirmAndPrint(); }
      else if (k === 'print') printLabels();
      else if (k === 'cancel-ask') { confirmingCancel = true; draw(); }
      else if (k === 'keep') { confirmingCancel = false; draw(); }
      else if (k === 'cancel-yes') { if (!busy) cancelDropOff(); }
      else if (k === 'logo') {
        const now = Date.now();
        taps = taps.filter((x) => now - x < 4000).concat(now);
        if (taps.length >= 5) { taps = []; exitTablet(); }
      }
    }),
    // typing into a box clears its "please type…" message
    on(container, 'input', 'input[data-kbd]', (e, el) => {
      if (!errors[el.name]) return;
      delete errors[el.name];
      el.removeAttribute('aria-invalid');
      $(`#err-${el.name}`, body)?.remove();
    }),
    on(container, 'submit', 'form[data-form]', (e, f) => {
      e.preventDefault();
      if (busy) return;
      if (f.dataset.form === 'dropoff') toPreview(); else lookUp();
    }),
  ];
  const touch = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'input'].forEach((ev) => container.addEventListener(ev, touch));

  const timer = setInterval(() => {
    if (screen === 'welcome' || busy || document.querySelector('.modal-overlay')) return;
    if (screen === 'done') {
      doneLeft -= 1;
      if (doneLeft <= 0) reset();
      else { const el = $('.kiosk-countdown', body); if (el) el.textContent = t().resetIn(doneLeft); }
      return;
    }
    if (Date.now() - lastActivity > IDLE[screen] * 1000) reset();
  }, 1000);

  // Keep the tablet screen awake while this page is open (where the browser allows it).
  let wake = null;
  const keepAwake = async () => { try { if (document.visibilityState === 'visible' && navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ } };
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  draw();

  return () => {
    clearInterval(timer);
    offs.forEach((off) => off());
    kb.destroy();
    document.removeEventListener('visibilitychange', keepAwake);
    if (wake) wake.release().catch(() => {});
    pageStyle.remove();
    document.body.classList.remove('kiosk-mode');
  };
}
