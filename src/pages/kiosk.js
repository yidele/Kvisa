// Walk-up tablet screen: a meshulach types name, phone and number of bags; the order opens
// automatically and one label per bag prints. Full screen, no navigation, resets itself.
import { sb, rpc, state, settings } from '../lib/api.js';
import { html, raw, setHtml, $, on } from '../lib/dom.js';
import { orderNo, fmtDate, friendlyError } from '../lib/format.js';
import { TEXT, LANGS, LABEL_SIZES, checkKiosk, labelPages } from '../lib/kiosk.js';
import { APP_NAME } from '../config.js';

const DEFAULT_LANG = 'he';
const DONE_SECONDS = 30;       // the thank-you screen returns to a blank form after this
const IDLE_SECONDS = 90;       // a half-filled form is cleared after this long untouched

const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// Leaving the screen (5 taps on the logo) asks for the signed-in account's password, then signs out.
export function render(container) {
  const s = settings();
  const org = s.org_name || APP_NAME;
  const maxBags = s.kiosk_max_bags || 20;
  let lang = DEFAULT_LANG;
  let values = { name: '', phone: '', bags: 1 };
  let errors = {};
  let banner = '';
  let busy = false;
  let result = null;
  let requestKey = newKey();
  let lastActivity = Date.now();
  let doneLeft = 0;
  let taps = [];
  const t = () => TEXT[lang];

  setHtml(container, html`
    <div class="kiosk"><header class="kiosk-head">
      <button type="button" class="logo kiosk-logo" data-k="logo" aria-label="${org}">K</button>
      <span class="kiosk-org">${org}</span>
      <div class="kiosk-lang" role="group" aria-label="Language">${Object.entries(LANGS).map(([k, l]) =>
        html`<button type="button" class="btn" data-lang="${k}" lang="${k}">${l.name}</button>`)}</div>
    </header><div class="kiosk-body"></div></div>
    <div id="kiosk-print" aria-hidden="true"></div>`);
  const shell = $('.kiosk', container);
  const body = $('.kiosk-body', container);
  const printArea = $('#kiosk-print', container);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${(LABEL_SIZES[s.label_size] || LABEL_SIZES['4x6']).css}; margin: 0; }`;
  document.head.appendChild(pageStyle);
  document.body.classList.add('kiosk-mode');

  function readForm() {
    const f = $('form', body);
    if (f) values = { ...values, name: f.elements.name.value, phone: f.elements.phone.value };
  }

  function draw() {
    shell.setAttribute('dir', LANGS[lang].dir);
    shell.setAttribute('lang', lang);
    container.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    if (result) {
      setHtml(body, html`<section class="kiosk-card kiosk-done" aria-live="polite">
        <div class="kiosk-check" aria-hidden="true">✓</div>
        <h1><bdi>${t().thanks(result.name)}</bdi></h1>
        ${result.returning ? html`<p class="kiosk-sub">${t().welcomeBack}</p>` : ''}
        <p class="kiosk-sub">${t().yourNo}</p>
        <div class="kiosk-orderno" dir="ltr">${orderNo(result.order_no)}</div>
        <p class="kiosk-sub">${t().stick(result.bags)}</p>
        <div class="kiosk-actions">
          <button type="button" class="btn btn-lg" data-k="print">${t().printAgain}</button>
          <button type="button" class="btn btn-lg btn-primary" data-k="reset">${t().done}</button>
        </div>
        <p class="muted kiosk-countdown">${t().resetIn(doneLeft)}</p>
      </section>`);
      return;
    }
    const err = (k) => (errors[k] ? html`<small class="kiosk-err" id="err-${k}">${errors[k]}</small>` : '');
    setHtml(body, html`<form class="kiosk-card" novalidate autocomplete="off">
      <h1>${t().title}</h1>
      <p class="kiosk-sub">${t().intro}</p>
      ${banner ? html`<div class="notice notice-error" role="alert">${banner}</div>` : ''}
      <label class="field kiosk-field"><span>${t().name}</span>
        <input name="name" value="${values.name}" maxlength="80" autocapitalize="words" enterkeyhint="next" dir="auto"
          ${errors.name ? raw('aria-invalid="true" aria-describedby="err-name"') : ''}>${err('name')}</label>
      <label class="field kiosk-field"><span>${t().phone}</span>
        <input name="phone" type="tel" inputmode="tel" value="${values.phone}" maxlength="25" dir="ltr" enterkeyhint="done"
          ${errors.phone ? raw('aria-invalid="true" aria-describedby="err-phone"') : ''}>${err('phone')}</label>
      <div class="field kiosk-field"><span id="bags-label">${t().bags}</span>
        <div class="kiosk-stepper" role="group" aria-labelledby="bags-label">
          <button type="button" class="btn" data-k="less" aria-label="${t().less}">−</button>
          <output class="kiosk-bags" aria-live="polite">${values.bags}</output>
          <button type="button" class="btn" data-k="more" aria-label="${t().more}">+</button>
        </div>${err('bags')}</div>
      <button type="submit" class="btn btn-primary btn-lg btn-block kiosk-submit" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().submit}</button>
    </form>`);
  }

  function renderLabels() {
    const when = fmtDate(result.created_at, s.time_zone);
    setHtml(printArea, html`${labelPages(result.bags).map((p) => html`<div class="k-label" data-size="${s.label_size || '4x6'}">
      <div class="k-label-org">${org}</div>
      <div class="k-label-no">${orderNo(result.order_no)}</div>
      <div class="k-label-name" dir="auto">${result.name}</div>
      <div class="k-label-phone" dir="ltr">${result.phone}</div>
      <div class="k-label-foot"><strong>Bag ${p.index} of ${p.of}</strong><span>${when}</span></div>
    </div>`)}`);
  }

  function printLabels() { setTimeout(() => window.print(), 150); }

  function reset() {
    result = null; errors = {}; banner = ''; busy = false; doneLeft = 0;
    values = { name: '', phone: '', bags: 1 };
    requestKey = newKey();
    lang = DEFAULT_LANG;
    setHtml(printArea, '');
    draw();
  }

  async function submit() {
    readForm();
    const c = checkKiosk(values, maxBags, lang);
    errors = c.errors; banner = '';
    if (!c.ok) { draw(); $('[aria-invalid=true]', body)?.focus(); return; }
    busy = true; draw();
    try {
      result = await rpc('kiosk_submit', { p_name: c.value.name, p_phone: c.value.phone, p_bags: c.value.bags, p_request_key: requestKey });
      doneLeft = DONE_SECONDS;
      renderLabels();
      draw();
      printLabels();
    } catch (e) {
      // keep the same request key: a retry after a lost reply must not create a second order
      const msg = friendlyError(e.raw || e);
      banner = /reach the server/.test(msg) || !navigator.onLine ? t().errOffline : `${t().errServer} (${msg})`;
    } finally {
      busy = false;
      if (!result) draw();
    }
  }

  async function exitTablet() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('dir', LANGS[lang].dir);
    setHtml(overlay, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="kx-title"><form class="modal-form" novalidate>
      <header class="modal-head"><h2 id="kx-title">${t().exitTitle}</h2></header>
      <div class="modal-body"><p>${t().exitPrompt}</p>
        <label class="field"><span>${t().password}</span><input name="password" type="password" autocomplete="current-password"></label></div>
      <div class="form-error" role="alert" hidden></div>
      <footer class="modal-foot"><button type="button" class="btn" data-x="cancel">${t().cancel}</button>
        <button type="submit" class="btn btn-danger">${t().exit}</button></footer></form></div>`);
    container.appendChild(overlay);
    const form = $('form', overlay);
    form.elements.password.focus();
    $('[data-x=cancel]', overlay).onclick = () => overlay.remove();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: state.ctx.email, password: form.elements.password.value });
      if (error) { const box = $('.form-error', overlay); box.textContent = t().errPassword; box.hidden = false; return; }
      overlay.remove();
      await sb.auth.signOut();
    };
  }

  const offs = [
    on(container, 'click', '[data-lang]', (e, el) => { readForm(); lang = el.dataset.lang; errors = {}; banner = ''; draw(); }),
    on(container, 'click', '[data-k]', (e, el) => {
      const k = el.dataset.k;
      if (k === 'less' || k === 'more') {
        values.bags = Math.min(maxBags, Math.max(1, values.bags + (k === 'more' ? 1 : -1)));
        $('.kiosk-bags', body).textContent = values.bags;
      } else if (k === 'print') printLabels();
      else if (k === 'reset') reset();
      else if (k === 'logo') {
        const now = Date.now();
        taps = taps.filter((x) => now - x < 4000).concat(now);
        if (taps.length >= 5) { taps = []; exitTablet(); }
      }
    }),
    on(container, 'submit', 'form.kiosk-card', (e) => { e.preventDefault(); if (!busy) submit(); }),
  ];
  const touch = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'input'].forEach((ev) => container.addEventListener(ev, touch));

  const timer = setInterval(() => {
    if (result) {
      doneLeft -= 1;
      if (doneLeft <= 0) reset();
      else { const el = $('.kiosk-countdown', body); if (el) el.textContent = t().resetIn(doneLeft); }
      return;
    }
    readForm();
    const started = values.name || values.phone || values.bags !== 1 || lang !== DEFAULT_LANG;
    if (started && !busy && Date.now() - lastActivity > IDLE_SECONDS * 1000) reset();
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
    document.removeEventListener('visibilitychange', keepAwake);
    if (wake) wake.release().catch(() => {});
    pageStyle.remove();
    document.body.classList.remove('kiosk-mode');
  };
}
