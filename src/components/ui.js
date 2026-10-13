// Shared UI pieces: toasts, modals, confirmations, badges, empty/loading/error states.
import { html, raw, setHtml, esc, $, on, formValues } from '../lib/dom.js';
import { statusLabel, STATUS_TONE, TASK_STATUS_LABELS } from '../lib/format.js';
import { settings } from '../lib/api.js';

// ---------------- toasts ----------------
export function toast(message, kind = 'ok') {
  let host = $('#toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 3500);
}

// ---------------- modal ----------------
// openModal resolves with whatever onSubmit returns, or null when cancelled.
// If onSubmit throws, the message is shown inside the modal and the entered data is kept.
export function openModal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', danger = false, wide = false,
  onSubmit, onMount, hideSubmit = false, guardUnsaved = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    setHtml(overlay, html`
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <form class="modal-form" novalidate>
          <header class="modal-head">
            <h2 id="modal-title">${title}</h2>
            <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
          </header>
          <div class="modal-body">${body}</div>
          <div class="form-error" role="alert" hidden></div>
          <footer class="modal-foot">
            <button type="button" class="btn" data-close>${cancelLabel}</button>
            ${hideSubmit ? '' : html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>`}
          </footer>
        </form>
      </div>`);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');
    const form = $('form', overlay);
    const errBox = $('.form-error', overlay);
    let dirty = false;
    form.addEventListener('input', () => { dirty = true; });

    const close = (val) => {
      overlay.remove();
      if (!document.querySelector('.modal-overlay')) document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const tryCancel = () => {
      if (guardUnsaved && dirty && !confirm('Discard the changes you entered?')) return;
      close(null);
    };
    const onKey = (e) => { if (e.key === 'Escape' && overlay === document.querySelector('.modal-overlay:last-of-type')) tryCancel(); };
    document.addEventListener('keydown', onKey);
    on(overlay, 'click', '[data-close]', tryCancel);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) tryCancel(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Saving…'; }
      try {
        const result = onSubmit ? await onSubmit(formValues(form), form) : true;
        if (result === false) return;
        close(result === undefined ? true : result);
      } catch (err) {
        errBox.textContent = err.message || String(err);
        errBox.hidden = false;
        errBox.scrollIntoView({ block: 'nearest' });
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; }
      }
    });
    if (onMount) onMount(form, { close, setError: (m) => { errBox.textContent = m; errBox.hidden = !m; } });
    const first = form.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  });
}

// Confirmation for consequential actions. Returns { reason } or null.
export async function confirmAction({ title, message, confirmLabel = 'Confirm', danger = false, reasonLabel, reasons = [], reasonRequired = false }) {
  const body = html`
    <p>${message}</p>
    ${reasonLabel ? html`
      <label class="field"><span>${reasonLabel}${reasonRequired ? ' *' : ''}</span>
        ${reasons.length ? html`<select name="reason_pick">${reasons.map((r) => html`<option>${r}</option>`)}<option value="">Other (type below)</option></select>` : ''}
        <textarea name="reason" rows="2" placeholder="${reasons.length ? 'Add detail (optional)' : ''}"></textarea>
      </label>` : ''}`;
  return openModal({
    title, body, submitLabel: confirmLabel, danger, guardUnsaved: false,
    onSubmit: (v) => {
      const picked = v.reason_pick || '';
      const extra = (v.reason || '').trim();
      const reason = [picked, extra].filter(Boolean).join(' — ');
      if (reasonLabel && reasonRequired && !reason) throw new Error('Please give a reason.');
      return { reason };
    },
  });
}

// ---------------- small render helpers ----------------
export function statusBadge(status) {
  return html`<span class="badge tone-${STATUS_TONE[status] || 'neutral'}">${statusLabel(status, settings())}</span>`;
}

export function taskStatusBadge(status) {
  const tone = { pending: 'neutral', in_progress: 'progress', completed: 'done', cancelled: 'muted' }[status] || 'neutral';
  return html`<span class="badge tone-${tone}">${TASK_STATUS_LABELS[status] || status}</span>`;
}

export function loading(label = 'Loading…') {
  return html`<div class="state state-loading" aria-busy="true"><span class="spinner"></span>${label}</div>`;
}

export function errorState(err, retryAction = 'reload') {
  return html`<div class="state state-error" role="alert">
    <strong>Couldn't load this.</strong><p>${err?.message || String(err)}</p>
    <button class="btn" data-action="${retryAction}">Try again</button></div>`;
}

export function emptyState(title, text, action) {
  return html`<div class="state state-empty"><strong>${title}</strong>${text ? html`<p>${text}</p>` : ''}${action || ''}</div>`;
}

export function field(label, control, hint) {
  return html`<label class="field"><span>${label}</span>${control}${hint ? html`<small class="hint">${hint}</small>` : ''}</label>`;
}

export function pageHeader(title, actions, subtitle) {
  return html`<header class="page-head"><div><h1>${title}</h1>${subtitle ? html`<p class="sub">${subtitle}</p>` : ''}</div>
    <div class="page-actions">${actions || ''}</div></header>`;
}

export function pager(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return '';
  return html`<nav class="pager" aria-label="Pages">
    <button class="btn btn-sm" data-action="page" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>‹ Prev</button>
    <span>Page ${page} of ${pages} · ${total} total</span>
    <button class="btn btn-sm" data-action="page" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Next ›</button>
  </nav>`;
}

export function telLink(phone) {
  if (!phone) return '';
  return html`<a href="tel:${String(phone).replace(/[^\d+]/g, '')}">${phone}</a>`;
}

export function mapLink(address) {
  if (!address) return html`<span class="muted">No address</span>`;
  return html`<a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener">${address}</a>`;
}

export { esc };
