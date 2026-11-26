// In-app keyboard for the walk-up tablet. Boxes marked data-kbd="name|phone|digits" are read-only to the
// browser (so the Windows keyboard never opens); tapping one opens this keyboard with only the keys that box
// needs. A physical keyboard (e.g. over remote desktop) still types, through the same filter.
import { html, setHtml, $, $$ } from '../lib/dom.js';
import { KBD_LAYOUTS, typeKey } from '../lib/kiosk.js';

// root: the element the boxes live in; text(): the current language's TEXT (for Next / Done / space);
// lettersFor(): 'he' or 'en', the letter layout a name box starts with.
export function attachKeyboard(root, { text, lettersFor }) {
  const panel = document.createElement('div');
  panel.className = 'kbd';
  panel.hidden = true;
  panel.setAttribute('dir', 'ltr');
  root.appendChild(panel);
  let target = null;          // the box being typed into
  let letters = 'he';

  const kindOf = (el) => el.dataset.kbd;
  const boxes = () => $$('input[data-kbd]', root).filter((el) => el.offsetParent !== null);

  function keyHtml(k) {
    const t = text();
    if (k === 'space') return html`<button type="button" class="kbd-key kbd-space" data-key="space">${t.kbdSpace}</button>`;
    return html`<button type="button" class="kbd-key" data-key="${k}">${k}</button>`;
  }

  function draw() {
    if (!target) return;
    const kind = kindOf(target);
    const t = text();
    const rows = kind === 'name' ? KBD_LAYOUTS[letters] : KBD_LAYOUTS[kind];
    const last = boxes().indexOf(target) === boxes().length - 1;
    setHtml(panel, html`<div class="kbd-inner kbd-${kind === 'name' ? 'letters' : 'numbers'}">
      ${rows.map((r) => html`<div class="kbd-row">${r.map(keyHtml)}</div>`)}
      <div class="kbd-row kbd-controls">
        ${kind === 'name' ? html`<button type="button" class="kbd-key kbd-switch" data-key="switch">${letters === 'he' ? 'ABC' : 'אבג'}</button>
          ${keyHtml('space')}` : ''}
        <button type="button" class="kbd-key kbd-back" data-key="back" aria-label="Backspace">⌫</button>
        <button type="button" class="kbd-key kbd-go" data-key="${last ? 'done' : 'next'}">${last ? t.kbdDone : t.kbdNext}</button>
      </div></div>`);
  }

  function open(el) {
    if (target) target.classList.remove('kbd-target');
    target = el;
    if (kindOf(el) === 'name') letters = el.value && /[a-z]/i.test(el.value) ? 'en' : lettersFor();
    el.classList.add('kbd-target');
    panel.hidden = false;
    root.classList.add('kbd-open');
    draw();
    // make room at the bottom for this keyboard, then bring the box just above it
    root.style.setProperty('--kbd-h', `${panel.offsetHeight}px`);
    requestAnimationFrame(() => {
      const box = el.getBoundingClientRect();
      const top = panel.getBoundingClientRect().top;
      if (box.bottom > top - 16) window.scrollBy(0, box.bottom - top + 32);
      else if (box.top < 90) window.scrollBy(0, box.top - 110);
    });
  }

  function close() {
    if (target) target.classList.remove('kbd-target');
    target = null;
    panel.hidden = true;
    root.classList.remove('kbd-open');
  }

  function press(key) {
    if (!target) return;
    if (key === 'done') { close(); return; }
    if (key === 'next') {
      const list = boxes();
      const nextBox = list[list.indexOf(target) + 1];
      if (nextBox) open(nextBox); else close();
      return;
    }
    if (key === 'switch') { letters = letters === 'he' ? 'en' : 'he'; draw(); return; }
    const before = target.value;
    target.value = typeKey(before, key, kindOf(target), Number(target.maxLength) > 0 ? Number(target.maxLength) : 40);
    if (target.value !== before) target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const onDown = (e) => {
    const box = e.target.closest('input[data-kbd]');
    if (box && root.contains(box)) { open(box); return; }
    const key = e.target.closest('.kbd [data-key]');
    if (key) { e.preventDefault(); press(key.dataset.key); }
  };
  const onKey = (e) => {
    if (!target || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Backspace') press('back');
    else if (e.key === 'Enter' || e.key === 'Tab') press(boxes().indexOf(target) === boxes().length - 1 ? 'done' : 'next');
    else if (e.key === 'Escape') close();
    else if (e.key.length === 1 || Array.from(e.key).length === 1) press(e.key === ' ' ? 'space' : e.key);
    else return;
    e.preventDefault();
  };
  root.addEventListener('pointerdown', onDown);
  document.addEventListener('keydown', onKey);

  return {
    open,
    close,
    // after the screen is redrawn: keep typing into the same box if it is still there
    refresh() {
      if (!target) return;
      const same = target.name && $(`input[data-kbd][name="${target.name}"]`, root);
      if (same) open(same); else close();
    },
    destroy() {
      root.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      panel.remove();
    },
  };
}
