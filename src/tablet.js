// Tablet app (tablet/index.html): sign in once, then the walk-up screen fills the window.
// Works with a Tablet account, or with an administrator/dispatcher account for trying it out.
import { sb, state, roles, loadContext } from './lib/api.js';
import { html, setHtml, $, on } from './lib/dom.js';
import { errorState } from './components/ui.js';

let cleanup = null;
let starting = false;
let recovering = false;

function stop() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
}

function message(title, text) {
  setHtml(document.body, html`<div class="auth-wrap"><div class="card auth-card">
    <h1>${title}</h1><p>${text}</p>
    <button class="btn btn-block" data-action="sign-out">Sign out</button></div></div>`);
  $('[data-action=sign-out]').onclick = () => sb.auth.signOut();
}

// Same sign-in screen as the main site: sign in, create an (invited) account, or reset a password.
async function showSignIn() {
  stop();
  const mod = await import('./pages/login.js');
  mod.render(document.body);
}

async function start() {
  try {
    await loadContext();
  } catch (err) {
    setHtml(document.body, html`<div class="auth-wrap"><div class="card">${errorState(err)}</div></div>`);
    on(document.body, 'click', '[data-action=reload]', () => location.reload());
    return;
  }
  if (!state.ctx || !state.ctx.active) return message('Account not active', 'Ask a Kvisa administrator to activate this account.');
  if (!roles.kiosk && !roles.staff) {
    return message('Not a tablet account', 'This account cannot run the tablet. Sign in with the tablet account, or an administrator or dispatcher account.');
  }
  const mod = await import('./pages/kiosk.js');
  stop();
  cleanup = mod.render(document.body);
}

// Supabase calls must not be awaited inside this callback, so work is deferred with setTimeout.
sb.auth.onAuthStateChange((event, session) => {
  state.session = session;
  setTimeout(async () => {
    if (event === 'PASSWORD_RECOVERY') {
      recovering = true;
      stop();
      const m = await import('./pages/login.js');
      m.renderReset(document.body, () => { recovering = false; start(); });
      return;
    }
    if (recovering) return;
    if (!session) { state.ctx = null; showSignIn(); return; }
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !state.ctx && !starting) {
      starting = true;
      try { await start(); } finally { starting = false; }
    }
  }, 0);
});
