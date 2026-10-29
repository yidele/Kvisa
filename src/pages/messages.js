// Messages: job posts and what happened to each job, every WhatsApp/SMS sent, and every reply received.
import { sb, run, rpc, tz, settings, state, loadPeople, messaging } from '../lib/api.js';
import { html, setHtml, $, on } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast } from '../components/ui.js';
import { orderNo, taskLabel, fmtDateTime, relativeTime } from '../lib/format.js';
import { postJobsModal } from '../components/postJobs.js';

const CHANNEL = { whatsapp: 'WhatsApp', sms: 'Text' };
const PURPOSE = { post: 'Job post', covered: 'Covered', reply: 'Reply' };
const SEND_TONE = { pending: 'neutral', sending: 'progress', sent: 'done', failed: 'danger', cancelled: 'muted' };
const SEND_LABEL = { pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled' };
const OUTCOME = {
  take: ['Took a job', 'done'], done: ['Marked done', 'done'], ignored: ['Chat (no auto-reply)', 'neutral'],
  unknown_sender: ['Unknown number', 'warn'], error: ['Error', 'danger'],
};
const ITEM = { available: ['Open', 'warn'], accepted: ['Covered', 'done'], cancelled: ['Closed', 'muted'], expired: ['Expired', 'muted'], declined: ['Nobody took it', 'danger'] };

const badge = (label, tone) => html`<span class="badge tone-${tone}">${label}</span>`;

export async function render(root) {
  await loadPeople();
  const who = (id, fallback) => state.people?.find((p) => p.id === id)?.full_name || fallback || '';

  setHtml(root, html`
    ${pageHeader('Messages', html`<button class="btn" data-action="send">Send waiting messages</button>
      <button class="btn btn-primary" data-action="post">Post jobs</button>`,
      'WhatsApp group posts, texts to drivers, and their replies.')}
    <div data-body>${loading()}</div>`);

  async function load() {
    const box = $('[data-body]', root);
    try {
      const [posts, outbox, inbox] = await Promise.all([
        run(sb.from('job_posts').select('*').order('created_at', { ascending: false }).limit(15)),
        run(sb.from('message_outbox').select('*').order('created_at', { ascending: false }).limit(60)),
        run(sb.from('message_inbox').select('*').order('received_at', { ascending: false }).limit(60)),
      ]);
      const items = posts.length
        ? await run(sb.from('job_post_items').select('*, task_offers(status, expires_at), order_tasks(task_type), orders(order_no)').in('post_id', posts.map((p) => p.id)))
        : [];
      const s = settings();
      const toLabel = (m) => m.to_kind === 'group' ? (m.to_address === s.wa_group_id && s.wa_group_name ? s.wa_group_name : 'WhatsApp group') : who(m.person_id, '+' + m.to_address);
      const failed = outbox.filter((m) => m.status === 'failed').length;

      setHtml(box, html`
        ${failed ? html`<div class="notice notice-error">${failed} message${failed === 1 ? '' : 's'} failed to send. The reason is shown below. Use “Send again” once it’s fixed.</div>` : ''}
        <section class="card">
          <h2>Job posts</h2>
          ${posts.length ? html`<ul class="list post-list">${posts.map((p) => {
            const its = items.filter((i) => i.post_id === p.id).sort((a, b) => a.item_no - b.item_no);
            return html`<li><div class="grow">
              <strong>${fmtDateTime(p.created_at, tz())}</strong> <small class="muted">${p.channels.length ? p.channels.map((c) => CHANNEL[c]).join(' + ') : 'App only'}</small>
              <ul class="post-items">${its.map((i) => {
                const st = i.task_offers?.status || 'available';
                const [label, tone] = i.covered_person_id ? ['Covered', 'done'] : (ITEM[st] || [st, 'neutral']);
                return html`<li><strong>${i.item_no}.</strong> ${orderNo(i.orders?.order_no)} · ${taskLabel(i.order_tasks?.task_type, s)}
                  ${badge(label, tone)} ${i.covered_person_id ? html`<span>${who(i.covered_person_id)}</span> <small class="muted">${relativeTime(i.covered_at)}</small>` : ''}</li>`;
              })}</ul>
              <details><summary class="muted">Message text</summary><pre class="msg-preview">${p.body}</pre></details>
            </div></li>`;
          })}</ul>` : emptyState('No posts yet', 'Press “Post jobs” to send open jobs to the group.')}
        </section>
        <section class="card">
          <h2>Received</h2>
          ${inbox.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>From</th><th>Message</th><th>What happened</th><th>Our reply</th></tr></thead>
            <tbody>${inbox.map((m) => {
              const [label, tone] = OUTCOME[m.outcome] || [m.outcome || '—', 'neutral'];
              return html`<tr>
                <td data-label="When"><small>${fmtDateTime(m.received_at, tz())}</small></td>
                <td data-label="From">${who(m.person_id, '+' + m.from_address)} <small class="muted">${CHANNEL[m.channel]}</small></td>
                <td data-label="Message">${m.body}</td>
                <td data-label="Result">${badge(label, tone)}</td>
                <td data-label="Reply"><small class="pre">${m.detail || ''}</small></td></tr>`;
            })}</tbody></table></div>` : emptyState('Nothing received yet', 'Private replies to the WhatsApp number or SMS number appear here.')}
        </section>
        <section class="card">
          <h2>Sent</h2>
          ${outbox.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>To</th><th>Type</th><th>Message</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${outbox.map((m) => html`<tr>
              <td data-label="When"><small>${fmtDateTime(m.created_at, tz())}</small></td>
              <td data-label="To">${toLabel(m)} <small class="muted">${CHANNEL[m.channel]}</small></td>
              <td data-label="Type">${PURPOSE[m.purpose] || m.purpose}</td>
              <td data-label="Message"><small class="pre">${m.body.length > 160 ? m.body.slice(0, 160) + '…' : m.body}</small></td>
              <td data-label="Status">${badge(SEND_LABEL[m.status] || m.status, SEND_TONE[m.status] || 'neutral')}
                ${m.error ? html`<br><small class="warn-text">${m.error}</small>` : ''}</td>
              <td class="actions">
                ${['failed', 'cancelled'].includes(m.status) ? html`<button class="btn btn-sm" data-retry="${m.id}">Send again</button>` : ''}
                ${['pending', 'failed'].includes(m.status) ? html`<button class="btn btn-sm btn-danger-ghost" data-cancel="${m.id}">Cancel</button>` : ''}</td>
            </tr>`)}</tbody></table></div>` : emptyState('Nothing sent yet')}
        </section>`);
    } catch (err) { setHtml(box, errorState(err)); }
  }

  const sendNow = async (quiet) => {
    try {
      const r = await messaging('send');
      if (!quiet || r.sent || r.failed) toast(r.failed ? `Sent ${r.sent}, ${r.failed} failed.` : `Sent ${r.sent} message${r.sent === 1 ? '' : 's'}.`, r.failed ? 'warn' : 'ok');
    } catch (err) { toast(`Sending failed: ${err.message}`, 'error'); }
    await load();
  };
  on(root, 'click', '[data-action=send]', () => sendNow(false));
  on(root, 'click', '[data-action=post]', async () => { if (await postJobsModal()) load(); });
  on(root, 'click', '[data-action=reload]', () => load());
  on(root, 'click', '[data-retry]', async (e, el) => {
    try { await rpc('outbox_retry', { p_id: el.dataset.retry }); await sendNow(true); } catch (err) { toast(err.message, 'error'); }
  });
  on(root, 'click', '[data-cancel]', async (e, el) => {
    try { await rpc('outbox_cancel', { p_id: el.dataset.cancel }); toast('Cancelled.'); load(); } catch (err) { toast(err.message, 'error'); }
  });
  await load();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-overlay')) load(); }, 30000);
  return () => clearInterval(timer);
}
