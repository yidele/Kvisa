// The signed-in user's own account: name and password.
import { sb, run, state, loadContext } from '../lib/api.js';
import { html, setHtml, $, formValues } from '../lib/dom.js';
import { pageHeader, toast } from '../components/ui.js';
import { friendlyError } from '../lib/format.js';

export async function render(root) {
  const c = state.ctx;
  setHtml(root, html`
    ${pageHeader('My account')}
    <section class="card form-section">
      <dl class="kv"><div><dt>Email</dt><dd>${c.email}</dd></div><div><dt>Roles</dt><dd>${c.roles.join(', ')}</dd></div></dl>
      <form data-pw novalidate>
        <h2>Change password</h2>
        <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" minlength="8"></label>
        <label class="field"><span>Repeat new password</span><input name="password2" type="password" autocomplete="new-password"></label>
        <button class="btn btn-primary">Change password</button>
      </form>
    </section>`);
  $('[data-pw]', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    try {
      if (v.password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (v.password !== v.password2) throw new Error('The two passwords do not match.');
      const { error } = await sb.auth.updateUser({ password: v.password });
      if (error) throw error;
      e.target.reset(); toast('Password changed.');
    } catch (err) { toast(friendlyError(err), 'error'); }
  });
}
