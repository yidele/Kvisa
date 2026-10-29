// Shared app-level state and icons (kept separate to avoid import cycles).
import { raw } from './dom.js';

export const app = {
  dirty: false,                 // set by full-page forms with unsaved changes
  setDirty(v) { app.dirty = !!v; },
  navigate(path) { location.hash = '#' + path; },
  refreshBadge: () => {},
};
window.addEventListener('beforeunload', (e) => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });


const ICONS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list: 'M4 6h16M4 12h16M4 18h10',
  cal: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4',
  users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M17 11a3 3 0 100-6M22 21v-1a5 5 0 00-4-5',
  drop: 'M12 3s7 7.5 7 12a7 7 0 01-14 0c0-4.5 7-12 7-12z',
  car: 'M3 13l2-6h14l2 6v5h-3v-2H6v2H3zM7 16h.01M17 16h.01',
  clock: 'M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  check: 'M4 12l5 5L20 6',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14 3h-4l-.6 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2L10 21h4l.6-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
};
export const icon = (k) => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[k]}"/></svg>`);

