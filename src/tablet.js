// Tablet app (tablet/index.html): sign in once, then the walk-up screen fills the window.
// Works with a Tablet account, or with an administrator/dispatcher account for trying it out.
import { sb, state, roles, loadContext } from './lib/api.js';
import { html, setHtml, $, on, formValues } from './lib/dom.js';
import { friendlyError } from './lib/format.js';
import { errorState } from './components/ui.js';

let cleanup = null;
let starting = false;

function stop() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
}

function message(title, text) {
  setHtml(document.body, html`<div class="auth-wrap"><div class="card auth-card">
    <h1>${title}</h1><p>${text}</p>
    <button class="btn btn-block" data-action="sign-out">Sign out</button></div></div>`);
  $('[data-action=sign-out]').onclick = () => sb.auth.signOut();
}

function showSignIn(msg) {
  stop();
  setHtml(document.body, html`
    <div class="auth-wrap"><div class="card auth-card">
      <div class="brand brand-lg"><span class="logo" aria-hidden="true">K</span><span>Kvisa Tablet</span></div>
      <p class="muted">Sign in once with the tablet's account (or your own Kvisa account to try it out).
        The tablet stays signed in after that.</p>
      ${msg ? html`<div class="notice notice-error" role="alert">${msg}</div>` : ''}
      <form novalidate>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button>
      </form>
    </div></div>`);
  const form = $('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      if (!v.email || !v.password) throw new Error('Enter the email and password.');
      const { error } = await sb.auth.signInWithPassword({ email: v.email.trim(), password: v.password });
      if (error) throw error;
    } catch (err) {
      showSignIn(friendlyError(err));
      $('input[name=email]').value = v.email || '';
    }
  });
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
    if (!session) { state.ctx = null; showSignIn(); return; }
    if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !state.ctx && !starting) {
      starting = true;
      try { await start(); } finally { starting = false; }
    }
  }, 0);
});
