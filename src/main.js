// App shell, routing, session handling.
import { sb, state, roles, loadContext, loadPeople, loadCategories, rpc, run, settings } from './lib/api.js';
import { html, raw, setHtml, $, on } from './lib/dom.js';
import { toast, loading, errorState } from './components/ui.js';
import { APP_NAME } from './config.js';
import { app, icon } from './lib/app.js';

const routes = [
  { path: /^\/?$/, page: () => (roles.staff ? import('./pages/dashboard.js') : import('./pages/mytasks.js')) },
  { path: /^\/dispatch$/, page: () => import('./pages/dispatcher.js'), staff: true },
  { path: /^\/orders\/new$/, page: () => import('./pages/orderEdit.js'), staff: true },
  { path: /^\/orders\/([0-9a-f-]{36})\/edit$/, page: () => import('./pages/orderEdit.js'), staff: true, params: ['id'] },
  { path: /^\/orders\/([0-9a-f-]{36})$/, page: () => import('./pages/order.js'), staff: true, params: ['id'] },
  { path: /^\/calendar$/, page: () => import('./pages/calendar.js'), staff: true },
  { path: /^\/clients$/, page: () => import('./pages/clients.js'), staff: true },
  { path: /^\/clients\/([0-9a-f-]{36}|new)$/, page: () => import('./pages/client.js'), staff: true, params: ['id'] },
  { path: /^\/volunteers$/, page: () => import('./pages/people.js'), staff: true, props: { role: 'washer' } },
  { path: /^\/drivers$/, page: () => import('./pages/people.js'), staff: true, props: { role: 'driver' } },
  { path: /^\/people\/([0-9a-f-]{36}|new)$/, page: () => import('./pages/person.js'), staff: true, params: ['id'] },
  { path: /^\/history$/, page: () => import('./pages/history.js'), staff: true },
  { path: /^\/reports$/, page: () => import('./pages/reports.js'), staff: true },
  { path: /^\/settings$/, page: () => import('./pages/settings.js'), admin: true },
  { path: /^\/my-tasks$/, page: () => import('./pages/mytasks.js') },
  { path: /^\/notifications$/, page: () => import('./pages/notifications.js') },
  { path: /^\/search$/, page: () => import('./pages/search.js'), staff: true },
  { path: /^\/account$/, page: () => import('./pages/account.js') },
];

let currentHash = location.hash;
let cleanup = null;

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

async function route() {
  if (!state.session) return showLogin();
  if (app.dirty && location.hash !== currentHash) {
    if (!confirm('You have unsaved changes. Leave this page and discard them?')) {
      history.replaceState(null, '', currentHash || '#/');
      return;
    }
    app.dirty = false;
  }
  currentHash = location.hash;
  const { path, query } = parseHash();
  const r = routes.find((x) => x.path.test(path));
  const main = $('#main');
  if (!main) return;
  highlightNav(path);
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const root = document.createElement('div');
  root.className = 'page';
  main.replaceChildren(root);
  if (!r) { setHtml(root, html`<div class="state state-empty"><strong>Page not found</strong><p><a href="#/">Go home</a></p></div>`); return; }
  if ((r.staff && !roles.staff) || (r.admin && !roles.admin)) {
    setHtml(root, html`<div class="state state-error"><strong>Not available</strong><p>Your role does not have access to this page.</p><p><a href="#/">Go to my tasks</a></p></div>`);
    return;
  }
  const m = path.match(r.path);
  const params = {};
  (r.params || []).forEach((name, i) => { params[name] = m[i + 1]; });
  setHtml(root, loading());
  try {
    const mod = await r.page();
    cleanup = (await mod.render(root, { params, query, props: r.props || {} })) || null;
  } catch (err) {
    console.error(err);
    setHtml(root, errorState(err));
    on(root, 'click', '[data-action=reload]', () => route());
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function navItems() {
  const items = [];
  if (roles.staff) {
    items.push(['/', 'Dashboard', 'grid'], ['/dispatch', 'Dispatcher', 'list'], ['/calendar', 'Calendar', 'cal'],
      ['/clients', 'Clients', 'users'], ['/volunteers', 'Volunteers', 'drop'], ['/drivers', 'Drivers', 'car'],
      ['/history', 'Recent History', 'clock'], ['/reports', 'Reports', 'chart']);
  }
  if (roles.field) items.push([roles.staff ? '/my-tasks' : '/', 'My tasks', 'check']);
  if (roles.admin) items.push(['/settings', 'Settings', 'gear']);
  return items;
}

const SHORT = { 'Recent History': 'History', 'My tasks': 'My tasks', Dispatcher: 'Dispatch' };
let shellBound = false;
function renderShell() {
  const items = navItems();
  const org = settings().org_name || APP_NAME;
  const ctx = state.ctx;
  setHtml(document.body, html`
    <a class="skip" href="#main">Skip to content</a>
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand"><span class="logo" aria-hidden="true">K</span><span>${org}</span></div>
      <nav>${items.map(([p, label, ic]) => html`<a href="#${p}" data-nav="${p}">${icon(ic)}<span>${label}</span></a>`)}</nav>
      <div class="sidebar-foot">
        <a href="#/account" class="me">${ctx.full_name || ctx.email}<small>${ctx.roles.join(', ')}</small></a>
      </div>
    </aside>
    <div class="shell">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-action="toggle-menu" aria-label="Menu">☰</button>
        <span class="topbar-title">${org}</span>
        ${roles.staff ? html`<form class="global-search" role="search" data-search>
          <input type="search" name="q" placeholder="Search orders, clients, people…" aria-label="Search" autocomplete="off">
        </form>` : html`<span class="spacer"></span>`}
        <a href="#/notifications" class="icon-btn bell" aria-label="Notifications">${icon('bell')}<span class="count" hidden></span></a>
        <button class="btn btn-sm btn-ghost" data-action="sign-out">Sign out</button>
      </header>
      <main id="main" tabindex="-1"></main>
    </div>
    <nav class="bottom-nav" aria-label="Quick navigation">
      ${items.slice(0, roles.staff ? 4 : 3).map(([p, label, ic]) => html`<a href="#${p}" data-nav="${p}">${icon(ic)}<span>${SHORT[label] || label}</span></a>`)}
      <button data-action="toggle-menu">${raw('<svg class="ic" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>')}<span>More</span></button>
    </nav>
    <div id="toasts" role="status" aria-live="polite"></div>`);

  if (shellBound) return;
  shellBound = true;
  on(document.body, 'click', '[data-action=toggle-menu]', () => document.body.classList.toggle('menu-open'));
  on(document.body, 'click', '.sidebar a', () => document.body.classList.remove('menu-open'));
  on(document.body, 'click', '[data-action=sign-out]', async () => {
    if (app.dirty && !confirm('Discard unsaved changes and sign out?')) return;
    app.dirty = false;
    await sb.auth.signOut();
  });
  on(document.body, 'submit', '[data-search]', (e, form) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (q) app.navigate('/search?q=' + encodeURIComponent(q));
  });
}

function highlightNav(path) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const p = a.dataset.nav;
    const active = p === '/' ? path === '/' : path === p || path.startsWith(p + '/') ||
      (p === '/dispatch' && path.startsWith('/orders')) || (p === '/clients' && path.startsWith('/clients'));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

let notifTimer = null;
async function refreshNotifications() {
  try {
    await rpc('refresh_due_notifications');
    const res = await run(sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null));
    const n = res?.count || 0;
    const el = document.querySelector('.bell .count');
    if (el) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = n === 0; }
  } catch { /* offline — try again later */ }
}

async function startApp() {
  try {
    await loadContext();
  } catch (err) {
    setHtml(document.body, html`<div class="auth-wrap"><div class="card">${errorState(err)}</div></div>`);
    on(document.body, 'click', '[data-action=reload]', () => location.reload());
    return;
  }
  if (!state.ctx || !state.ctx.active) {
    setHtml(document.body, html`<div class="auth-wrap"><div class="card auth-card"><h1>Account not active</h1>
      <p>Your account exists but is not active in ${APP_NAME}. Ask an administrator to activate it.</p>
      <button class="btn" id="so">Sign out</button></div></div>`);
    $('#so').onclick = () => sb.auth.signOut();
    return;
  }
  // A tablet login has nothing to do here: send it to the tablet app.
  if (roles.kioskOnly) { location.replace('tablet/'); return; }
  if (roles.staff) {
    await Promise.all([loadPeople(), loadCategories()]);
    rpc('generate_recurring_orders').catch(() => {});  // keeps the planning window filled; idempotent
  }
  renderShell();
  await route();
  refreshNotifications();
  clearInterval(notifTimer);
  notifTimer = setInterval(refreshNotifications, 60000);
}

async function showLogin() {
  clearInterval(notifTimer);
  const mod = await import('./pages/login.js');
  mod.render(document.body);
}

window.addEventListener('hashchange', () => { if (state.session && state.ctx) route(); });
app.refreshBadge = () => refreshNotifications();

let starting = false;
let recovering = false;
// Supabase calls must not be awaited inside this callback, so work is deferred with setTimeout.
sb.auth.onAuthStateChange((event, session) => {
  state.session = session;
  setTimeout(async () => {
    if (event === 'PASSWORD_RECOVERY') {
      recovering = true;
      const m = await import('./pages/login.js');
      m.renderReset(document.body, () => { recovering = false; startApp(); });
      return;
    }
    if (recovering) return;
    if (!session) { state.ctx = null; state.people = null; showLogin(); return; }
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !state.ctx && !starting) {
      starting = true;
      try { await startApp(); } finally { starting = false; }
    }
  }, 0);
});
