// In-app notifications for the signed-in user.
import { sb, run, tz, roles } from '../lib/api.js';
import { html, setHtml, $, on } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast } from '../components/ui.js';
import { fmtDateTime, relativeTime } from '../lib/format.js';
import { app } from '../lib/app.js';

export async function render(root) {
  async function draw() {
    const rows = await run(sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(100));
    const unread = rows.filter((r) => !r.read_at).length;
    setHtml(root, html`
      ${pageHeader('Notifications', unread ? html`<button class="btn" data-mark-all>Mark all as read</button>` : null,
        'Shown in this app only. Email and text messages are not connected.')}
      ${rows.length ? html`<ul class="list notif-list card">${rows.map((n) => html`
        <li class="${n.read_at ? '' : 'unread'}">
          <a class="row-link" href="${n.order_id ? (roles.staff ? '#/orders/' + n.order_id : '#/my-tasks') : '#/notifications'}" data-open="${n.id}">
            <span><strong>${n.title}</strong>${n.body ? html`<br><small>${n.body}</small>` : ''}</span>
            <small class="muted" title="${fmtDateTime(n.created_at, tz())}">${relativeTime(n.created_at)}</small>
          </a></li>`)}</ul>` : emptyState('No notifications', 'You will see new assignments, schedule changes and problems here.')}`);
  }
  on(root, 'click', '[data-open]', async (e, el) => {
    try { await run(sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', el.dataset.open).is('read_at', null)); app.refreshBadge(); } catch { /* ignore */ }
  });
  on(root, 'click', '[data-mark-all]', async () => {
    try {
      await run(sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null));
      app.refreshBadge(); await draw();
    } catch (err) { toast(err.message, 'error'); }
  });
  on(root, 'click', '[data-action=reload]', () => draw().catch((e) => setHtml(root, errorState(e))));
  setHtml(root, loading());
  try { await draw(); } catch (err) { setHtml(root, errorState(err)); }
}
