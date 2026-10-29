// Walk-up tablet screens:
//   welcome (language) → menu → drop-off form → labels (print, stick on bags) → summary
//                              → "Where is my laundry?" (phone + first name) → live status
// Full screen, no navigation to the rest of Kvisa, returns to the welcome screen when left alone.
import { sb, rpc, state, settings } from '../lib/api.js';
import { html, raw, setHtml, $, on } from '../lib/dom.js';
import { orderNo, fmtDate, friendlyError } from '../lib/format.js';
import { TEXT, LANGS, LABEL_SIZES, STAGES, checkDropOff, checkTrack, stageOf, labelPages } from '../lib/kiosk.js';
import { APP_NAME } from '../config.js';

// Seconds without a touch before a screen goes back to the welcome screen.
const IDLE = { menu: 60, form: 120, labels: 300, track: 120 };
const SUMMARY_SECONDS = 45;   // the summary counts down visibly, then starts over
const TRACK_REFRESH = 20;     // "Where is my laundry?" re-checks the status this often

const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const blankForm = () => ({ first: '', middle: '', last: '', phone: '', israel: '', bags: 1 });

const BRAND = raw(`<svg class="kiosk-mark" viewBox="0 0 120 120" aria-hidden="true">
  <rect x="4" y="4" width="112" height="112" rx="28" fill="#1f5fae"/>
  <circle cx="60" cy="64" r="34" fill="#ffffff" opacity=".14"/>
  <circle cx="60" cy="64" r="24" fill="none" stroke="#ffffff" stroke-width="5" opacity=".55"/>
  <text x="60" y="80" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="50" fill="#ffffff">K</text>
  <circle cx="92" cy="26" r="7" fill="#ffffff" opacity=".8"/><circle cx="102" cy="42" r="4" fill="#ffffff" opacity=".6"/>
  <circle cx="24" cy="98" r="5" fill="#ffffff" opacity=".5"/></svg>`);
const ICON_BAG = raw('<svg class="kiosk-ic" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 16h20l4 26H10z"/><path d="M18 16v-3a6 6 0 0112 0v3"/><path d="M24 24v10M19 29h10"/></svg>');
const ICON_FIND = raw('<svg class="kiosk-ic" viewBox="0 0 48 48" aria-hidden="true"><circle cx="21" cy="21" r="11"/><path d="M29 29l10 10"/><path d="M16 21l4 4 7-8"/></svg>');

// Leaving the screen (5 taps on the logo) asks for the signed-in account's password, then signs out.
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
  let result = null;
  let requestKey = newKey();
  let trackForm = { phone: '', first: '' };
  let trackResult = null;
  let lastActivity = Date.now();
  let summaryLeft = 0;
  let sinceRefresh = 0;
  let taps = [];
  const t = () => TEXT[lang];
  const dir = () => LANGS[lang].dir;

  setHtml(container, html`<div class="kiosk"><div class="kiosk-screen"></div></div><div id="kiosk-print" aria-hidden="true"></div>`);
  const shell = $('.kiosk', container);
  const body = $('.kiosk-screen', container);
  const printArea = $('#kiosk-print', container);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${(LABEL_SIZES[labelSize] || LABEL_SIZES['4x6']).css}; margin: 0; }`;
  document.head.appendChild(pageStyle);
  document.body.classList.add('kiosk-mode');

  // ---------------- screens ----------------
  const head = (backTo) => html`<header class="kiosk-head">
    <button type="button" class="logo kiosk-logo" data-k="logo" aria-label="${org}">K</button>
    <span class="kiosk-org">${org}</span>
    ${backTo ? html`<button type="button" class="btn kiosk-back" data-go="${backTo}">${dir() === 'rtl' ? '→' : '←'} ${t().back}</button>` : ''}
  </header>`;
  const err = (k) => (errors[k] ? html`<small class="kiosk-err" id="err-${k}">${errors[k]}</small>` : '');
  const inv = (k) => (errors[k] ? raw(`aria-invalid="true" aria-describedby="err-${k}"`) : '');
  const bannerBox = () => (banner ? html`<div class="notice notice-error" role="alert">${banner}</div>` : '');
  const when = (v) => fmtDate(v, s.time_zone);

  const screens = {
    welcome: () => html`<div class="kiosk-welcome">
      <button type="button" class="kiosk-brand" data-k="logo" aria-label="${org}">${BRAND}</button>
      <h1 class="kiosk-welcome-name">${org}</h1>
      <p class="kiosk-taglines"><span lang="he" dir="rtl">${TEXT.he.tagline}</span><span lang="en" dir="ltr">${TEXT.en.tagline}</span><span lang="yi" dir="rtl">${TEXT.yi.tagline}</span></p>
      <div class="kiosk-langs">${Object.entries(LANGS).map(([k, l]) =>
        html`<button type="button" class="kiosk-lang-btn" data-lang="${k}" lang="${k}" dir="${l.dir}">${l.name}</button>`)}</div>
    </div>`,

    menu: () => html`${head('welcome')}<div class="kiosk-body"><section class="kiosk-menu">
      <h1>${t().menuTitle}</h1>
      <div class="kiosk-choices">
        <button type="button" class="kiosk-choice primary" data-go="form">${ICON_BAG}<strong>${t().newCall}</strong><span>${t().newCallSub}</span></button>
        <button type="button" class="kiosk-choice" data-go="track">${ICON_FIND}<strong>${t().track}</strong><span>${t().trackSub}</span></button>
      </div></section></div>`,

    form: () => html`${head('menu')}<div class="kiosk-body"><form class="kiosk-card" data-form="dropoff" novalidate autocomplete="off">
      <h1>${t().formTitle}</h1>
      ${bannerBox()}
      <div class="kiosk-names">
        <label class="field kiosk-field"><span>${t().first}</span>
          <input name="first" value="${form.first}" maxlength="40" autocapitalize="words" dir="auto" ${inv('first')}>${err('first')}</label>
        <label class="field kiosk-field"><span>${t().middle} <small class="muted">${t().optional}</small></span>
          <input name="middle" value="${form.middle}" maxlength="40" autocapitalize="words" dir="auto"></label>
        <label class="field kiosk-field"><span>${t().last}</span>
          <input name="last" value="${form.last}" maxlength="40" autocapitalize="words" dir="auto" ${inv('last')}>${err('last')}</label>
      </div>
      <div class="kiosk-phones">
        <label class="field kiosk-field"><span>${t().phoneHere}</span>
          <input name="phone" type="tel" inputmode="tel" value="${form.phone}" maxlength="25" dir="ltr" ${inv('phone')}>${err('phone')}</label>
        <label class="field kiosk-field"><span>${t().phoneIsrael}</span>
          <input name="israel" type="tel" inputmode="tel" value="${form.israel}" maxlength="25" dir="ltr" ${inv('israel')}>${err('israel')}</label>
      </div>
      <div class="field kiosk-field"><span id="bags-label">${t().bags}</span>
        <div class="kiosk-stepper" role="group" aria-labelledby="bags-label">
          <button type="button" class="btn" data-k="less" aria-label="${t().less}">−</button>
          <output class="kiosk-bags" aria-live="polite">${form.bags}</output>
          <button type="button" class="btn" data-k="more" aria-label="${t().more}">+</button>
        </div>${err('bags')}</div>
      <button type="submit" class="btn btn-primary btn-lg btn-block kiosk-submit" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().printLabels}</button>
    </form></div>`,

    labels: () => html`${head(null)}<div class="kiosk-body"><section class="kiosk-card kiosk-labels">
      <h1>${t().labelsTitle}</h1>
      <p class="kiosk-printing"><span class="spinner"></span>${t().labelsPrinting}</p>
      <ol class="kiosk-steps"><li>${t().labelsStep1(result.bags)}</li><li>${t().labelsStep2}</li></ol>
      <div class="kiosk-minis" dir="ltr">${labelPages(result.bags).map((p) => html`<div class="k-mini">
        <span class="k-mini-no">${orderNo(result.order_no)}</span>
        <span class="k-mini-name" dir="auto">${result.name}</span>
        <span class="k-mini-foot">Bag ${p.index} of ${p.of}</span></div>`)}</div>
      <div class="kiosk-actions">
        <button type="button" class="btn btn-lg" data-k="print">${t().printAgain}</button>
        <button type="button" class="btn btn-lg btn-primary" data-go="summary">${t().labelsDone}</button>
      </div></section></div>`,

    summary: () => html`${head(null)}<div class="kiosk-body"><section class="kiosk-card kiosk-summary" aria-live="polite">
      <div class="kiosk-check" aria-hidden="true">✓</div>
      <h1>${t().summaryTitle}</h1>
      ${result.returning ? html`<p class="kiosk-sub">${t().welcomeBack}</p>` : ''}
      <p class="kiosk-sub">${t().yourNo}</p>
      <div class="kiosk-orderno" dir="ltr">${orderNo(result.order_no)}</div>
      <dl class="kiosk-info">
        <div><dt>${t().name}</dt><dd dir="auto">${result.name}</dd></div>
        <div><dt>${t().phoneHere}</dt><dd dir="ltr">${result.phone}</dd></div>
        <div><dt>${t().phoneIsrael}</dt><dd dir="ltr">${result.israel_phone}</dd></div>
        <div><dt>${t().bagsCount}</dt><dd>${result.bags}</dd></div>
        <div><dt>${t().date}</dt><dd>${when(result.created_at)}</dd></div>
      </dl>
      <p class="kiosk-hint">${t().trackHint}</p>
      <button type="button" class="btn btn-lg btn-primary kiosk-finish" data-go="welcome">${t().finish}</button>
      <p class="muted kiosk-countdown">${t().resetIn(summaryLeft)}</p>
    </section></div>`,

    track: () => (trackResult ? html`${head('menu')}<div class="kiosk-body"><section class="kiosk-card kiosk-track">
      <h1>${t().trackTitle}</h1>
      ${bannerBox()}
      ${trackResult.length ? html`<ul class="kiosk-orders">${trackResult.map(trackItem)}</ul>`
        : html`<p class="kiosk-sub">${t().trackNone}</p>`}
      <p class="muted kiosk-live"><span class="kiosk-dot" aria-hidden="true"></span>${t().trackAuto}</p>
      <button type="button" class="btn btn-lg btn-primary kiosk-finish" data-go="welcome">${t().finish}</button>
    </section></div>`
      : html`${head('menu')}<div class="kiosk-body"><form class="kiosk-card" data-form="track" novalidate autocomplete="off">
      <h1>${t().trackTitle}</h1>
      ${bannerBox()}
      <label class="field kiosk-field"><span>${t().trackPhone}</span>
        <input name="phone" type="tel" inputmode="tel" value="${trackForm.phone}" maxlength="25" dir="ltr" ${inv('phone')}>${err('phone')}</label>
      <label class="field kiosk-field"><span>${t().trackFirst}</span>
        <input name="first" value="${trackForm.first}" maxlength="40" dir="auto" ${inv('first')}>${err('first')}</label>
      <button type="submit" class="btn btn-primary btn-lg btn-block kiosk-submit" ${busy ? raw('disabled') : ''}>${busy ? t().sending : t().trackFind}</button>
    </form></div>`),
  };

  function trackItem(o) {
    const st = stageOf(o.status);
    const at = STAGES.indexOf(st);
    return html`<li class="kiosk-order">
      <div class="kiosk-order-head"><strong dir="ltr">${orderNo(o.order_no)}</strong>
        <span>${o.bags} ${t().bagsWord} · ${t().droppedOff} ${when(o.created_at)}</span></div>
      <p class="kiosk-order-note ${st}">${at >= 0 && st !== 'delivered' ? html`<span class="muted">${t().now}</span> ` : ''}${t()['stage_' + st]}</p>
      ${at >= 0 ? html`<ol class="kiosk-progress">${STAGES.map((k, i) => html`<li class="${i < at || st === 'delivered' ? 'done' : i === at ? 'now' : ''}" ${i === at ? raw('aria-current="step"') : ''}>
          <span class="kiosk-progress-dot" aria-hidden="true">${i < at || st === 'delivered' ? '✓' : i + 1}</span><span>${t()['step_' + k]}</span></li>`)}</ol>` : ''}
    </li>`;
  }

  function draw() {
    const d = screen === 'welcome' ? 'ltr' : dir();
    shell.setAttribute('dir', d);
    shell.setAttribute('lang', screen === 'welcome' ? 'en' : lang);
    shell.dataset.screen = screen;
    setHtml(body, screens[screen]());
    const first = $('input[aria-invalid=true]', body);
    if (first) first.focus();
  }

  function go(next) {
    readForms();
    errors = {}; banner = '';
    if (next === 'welcome') { reset(); return; }
    if (next === 'track' && screen === 'menu') trackResult = null;
    if (next === 'summary') summaryLeft = SUMMARY_SECONDS;
    screen = next;
    lastActivity = Date.now();
    draw();
    window.scrollTo(0, 0);
  }

  function readForms() {
    const f = $('form[data-form=dropoff]', body);
    if (f) form = { ...form, first: f.elements.first.value, middle: f.elements.middle.value, last: f.elements.last.value,
      phone: f.elements.phone.value, israel: f.elements.israel.value };
    const tf = $('form[data-form=track]', body);
    if (tf) trackForm = { phone: tf.elements.phone.value, first: tf.elements.first.value };
  }

  function reset() {
    screen = 'welcome'; lang = 'he';
    form = blankForm(); trackForm = { phone: '', first: '' }; trackResult = null;
    result = null; errors = {}; banner = ''; busy = false;
    requestKey = newKey();
    setHtml(printArea, '');
    draw();
  }

  function renderLabels() {
    setHtml(printArea, html`${labelPages(result.bags).map((p) => html`<div class="k-label" data-size="${labelSize}">
      <div class="k-label-org">${org}</div>
      <div class="k-label-no">${orderNo(result.order_no)}</div>
      <div class="k-label-name" dir="auto">${result.name}</div>
      <div class="k-label-phone" dir="ltr">${result.phone}</div>
      <div class="k-label-foot"><strong>Bag ${p.index} of ${p.of}</strong><span>${when(result.created_at)}</span></div>
    </div>`)}`);
  }

  function printLabels() { setTimeout(() => window.print(), 150); }

  function failed(e) {
    const msg = friendlyError(e.raw || e);
    return /reach the server/.test(msg) || !navigator.onLine ? t().errOffline : `${t().errServer} (${msg})`;
  }

  async function submitDropOff() {
    readForms();
    const c = checkDropOff(form, maxBags, lang);
    errors = c.errors; banner = '';
    if (!c.ok) { draw(); return; }
    busy = true; draw();
    try {
      result = await rpc('kiosk_submit', { p_first: c.value.first, p_middle: c.value.middle, p_last: c.value.last,
        p_phone: c.value.phone, p_israel_phone: c.value.israel, p_bags: c.value.bags, p_request_key: requestKey });
      busy = false;
      renderLabels();
      go('labels');
      printLabels();
    } catch (e) {
      // keep the same request key: a retry after a lost reply must not create a second order
      busy = false;
      banner = failed(e);
      draw();
    }
  }

  async function submitTrack({ quiet = false } = {}) {
    if (!quiet) {
      readForms();
      const c = checkTrack(trackForm, lang);
      errors = c.errors; banner = '';
      if (!c.ok) { draw(); return; }
      trackForm = c.value;
      busy = true; draw();
    }
    try {
      trackResult = await rpc('kiosk_track', { p_phone: trackForm.phone, p_first_name: trackForm.first });
      banner = '';
    } catch (e) {
      if (!quiet) banner = failed(e);
    } finally {
      busy = false;
      sinceRefresh = 0;
      if (screen === 'track' && (!quiet || trackResult)) draw();
    }
  }

  async function exitTablet() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('dir', dir());
    setHtml(overlay, html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="kx-title"><form class="modal-form" novalidate>
      <header class="modal-head"><h2 id="kx-title">${t().exitTitle}</h2></header>
      <div class="modal-body"><p>${t().exitPrompt}</p>
        <label class="field"><span>${t().password}</span><input name="password" type="password" autocomplete="current-password"></label></div>
      <div class="form-error" role="alert" hidden></div>
      <footer class="modal-foot"><button type="button" class="btn" data-x="cancel">${t().cancel}</button>
        <button type="submit" class="btn btn-danger">${t().exit}</button></footer></form></div>`);
    container.appendChild(overlay);
    const f = $('form', overlay);
    f.elements.password.focus();
    $('[data-x=cancel]', overlay).onclick = () => overlay.remove();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithPassword({ email: state.ctx.email, password: f.elements.password.value });
      if (error) { const box = $('.form-error', overlay); box.textContent = t().errPassword; box.hidden = false; return; }
      overlay.remove();
      await sb.auth.signOut();
    };
  }

  const offs = [
    on(container, 'click', '[data-lang]', (e, el) => { lang = el.dataset.lang; go('menu'); }),
    on(container, 'click', '[data-go]', (e, el) => go(el.dataset.go)),
    on(container, 'click', '[data-k]', (e, el) => {
      const k = el.dataset.k;
      if (k === 'less' || k === 'more') {
        form.bags = Math.min(maxBags, Math.max(1, form.bags + (k === 'more' ? 1 : -1)));
        $('.kiosk-bags', body).textContent = form.bags;
      } else if (k === 'print') printLabels();
      else if (k === 'logo') {
        const now = Date.now();
        taps = taps.filter((x) => now - x < 4000).concat(now);
        if (taps.length >= 5) { taps = []; exitTablet(); }
      }
    }),
    on(container, 'submit', 'form[data-form]', (e, f) => {
      e.preventDefault();
      if (busy) return;
      if (f.dataset.form === 'dropoff') submitDropOff(); else submitTrack();
    }),
  ];
  const touch = () => { lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'input'].forEach((ev) => container.addEventListener(ev, touch));

  const timer = setInterval(() => {
    if (screen === 'welcome' || document.querySelector('.modal-overlay')) return;
    if (screen === 'summary') {
      summaryLeft -= 1;
      if (summaryLeft <= 0) reset();
      else { const el = $('.kiosk-countdown', body); if (el) el.textContent = t().resetIn(summaryLeft); }
      return;
    }
    if (busy) return;
    if (Date.now() - lastActivity > IDLE[screen] * 1000) { reset(); return; }
    if (screen === 'track' && trackResult && ++sinceRefresh >= TRACK_REFRESH) submitTrack({ quiet: true });
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
