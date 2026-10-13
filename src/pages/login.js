// Sign in, create account (invite-only), password reset.
import { sb } from '../lib/api.js';
import { html, setHtml, $, on, formValues } from '../lib/dom.js';
import { friendlyError } from '../lib/format.js';
import { APP_NAME } from '../config.js';

const redirectUrl = () => location.origin + location.pathname;

export function render(container) {
  let mode = 'signin';
  const draw = (msg, kind = 'error') => {
    setHtml(container, html`
      <div class="auth-wrap">
        <div class="card auth-card">
          <div class="brand brand-lg"><span class="logo" aria-hidden="true">K</span><span>${APP_NAME}</span></div>
          <div class="tabs" role="tablist">
            <button role="tab" class="tab ${mode === 'signin' ? 'active' : ''}" data-mode="signin" aria-selected="${mode === 'signin'}">Sign in</button>
            <button role="tab" class="tab ${mode === 'signup' ? 'active' : ''}" data-mode="signup" aria-selected="${mode === 'signup'}">Create account</button>
          </div>
          ${msg ? html`<div class="notice notice-${kind}" role="alert">${msg}</div>` : ''}
          ${mode === 'signin' ? html`
            <form data-form="signin" novalidate>
              <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
              <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
              <button class="btn btn-primary btn-block" type="submit">Sign in</button>
              <button class="link-btn" type="button" data-mode="forgot">Forgot password?</button>
            </form>` : mode === 'signup' ? html`
            <form data-form="signup" novalidate>
              <p class="muted">Kvisa is invite-only. Use the email address an administrator invited.
                (The very first account becomes the administrator.)</p>
              <label class="field"><span>Your name</span><input name="full_name" autocomplete="name" required></label>
              <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
              <label class="field"><span>Choose a password</span><input name="password" type="password" autocomplete="new-password" minlength="8" required>
                <small class="hint">At least 8 characters.</small></label>
              <label class="field"><span>Repeat password</span><input name="password2" type="password" autocomplete="new-password" required></label>
              <button class="btn btn-primary btn-block" type="submit">Create account</button>
            </form>` : html`
            <form data-form="forgot" novalidate>
              <p class="muted">We'll email you a link to choose a new password.</p>
              <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
              <button class="btn btn-primary btn-block" type="submit">Send reset link</button>
              <button class="link-btn" type="button" data-mode="signin">Back to sign in</button>
            </form>`}
        </div>
      </div>`);
  };
  draw();

  if (container.dataset.loginBound) return;
  container.dataset.loginBound = '1';
  on(container, 'click', '[data-mode]', (e, el) => {
    if (!container.querySelector('.auth-card')) return;
    mode = el.dataset.mode; draw();
  });
  on(container, 'submit', 'form[data-form]', async (e, form) => {
    e.preventDefault();
    if (!container.querySelector('.auth-card')) return;
    const v = formValues(form);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (form.dataset.form === 'signin') {
        if (!v.email || !v.password) throw new Error('Enter your email and password.');
        const { error } = await sb.auth.signInWithPassword({ email: v.email.trim(), password: v.password });
        if (error) throw error;
      } else if (form.dataset.form === 'signup') {
        if (!v.full_name.trim()) throw new Error('Enter your name.');
        if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) throw new Error('Enter a valid email.');
        if (v.password.length < 8) throw new Error('Password must be at least 8 characters.');
        if (v.password !== v.password2) throw new Error('The two passwords do not match.');
        const { data, error } = await sb.auth.signUp({
          email: v.email.trim(), password: v.password,
          options: { data: { full_name: v.full_name.trim() }, emailRedirectTo: redirectUrl() },
        });
        if (error) throw error;
        if (!data.session) { mode = 'signin'; draw('Account created. Check your email for a confirmation link, then sign in.', 'ok'); }
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(v.email.trim(), { redirectTo: redirectUrl() });
        if (error) throw error;
        mode = 'signin'; draw('If that email has an account, a reset link is on its way.', 'ok');
      }
    } catch (err) {
      const keep = formValues(form);
      draw(friendlyError(err));
      // keep what was typed (except passwords)
      const f = container.querySelector('form');
      if (f) for (const [k, val] of Object.entries(keep)) if (!k.startsWith('password') && f.elements[k]) f.elements[k].value = val;
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
}

export function renderReset(container, done) {
  setHtml(container, html`
    <div class="auth-wrap"><div class="card auth-card">
      <h1>Choose a new password</h1>
      <div class="notice notice-error" role="alert" hidden></div>
      <form novalidate>
        <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="field"><span>Repeat password</span><input name="password2" type="password" autocomplete="new-password" required></label>
        <button class="btn btn-primary btn-block" type="submit">Save password</button>
      </form>
    </div></div>`);
  const form = $('form', container);
  const err = $('.notice', container);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    err.hidden = true;
    try {
      if (v.password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (v.password !== v.password2) throw new Error('The two passwords do not match.');
      const { error } = await sb.auth.updateUser({ password: v.password });
      if (error) throw error;
      history.replaceState(null, '', location.pathname + '#/');
      done && done();
    } catch (ex) { err.textContent = friendlyError(ex); err.hidden = false; }
  });
}
