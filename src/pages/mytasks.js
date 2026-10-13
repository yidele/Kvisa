// Driver / washing-volunteer home: only their own tasks, big one-hand buttons.
import { rpc, tz, settings, state } from '../lib/api.js';
import { html, setHtml, $, on } from '../lib/dom.js';
import { loading, errorState, emptyState, toast, telLink, mapLink, taskStatusBadge } from '../components/ui.js';
import { recordModal, problemModal } from '../components/orderActions.js';
import { taskLabel, orderNo, fmtDateTime, fmtTime, todayInTz, zonedToDate, addDays, nextActions, dateToZonedParts } from '../lib/format.js';

export async function render(root, { query }) {
  let tab = query.get('tab') || 'today';
  let rows = [];

  async function draw() {
    const today = todayInTz(tz());
    const startToday = zonedToDate(today, '00:00', tz()).toISOString();
    const endToday = zonedToDate(addDays(today, 1), '00:00', tz()).toISOString();
    try {
      if (tab === 'done') rows = (await rpc('my_tasks', { p_from: zonedToDate(addDays(today, -30), '00:00', tz()).toISOString(), p_to: null, p_include_done: true }))
        .filter((r) => r.task_status === 'completed').reverse();
      else {
        const all = await rpc('my_tasks', {});
        rows = tab === 'today'
          ? all.filter((r) => !r.scheduled_at || r.scheduled_at < endToday)   // today + anything overdue
          : all.filter((r) => r.scheduled_at && r.scheduled_at >= endToday);
      }
    } catch (err) { setHtml(root, errorState(err)); return; }

    const card = (r) => {
      const acts = r.can_act ? nextActions(r.task_type, r.task_status, r.washing_received) : [];
      const overdue = r.task_status !== 'completed' && r.scheduled_at && r.scheduled_at < startToday;
      const isWash = r.task_type === 'washing';
      return html`
        <article class="task-card card ${overdue ? 'overdue' : ''}">
          <header>
            <div><strong>${taskLabel(r.task_type, settings())}</strong> <small class="muted">${orderNo(r.order_no)}</small></div>
            ${taskStatusBadge(r.task_status)}
          </header>
          <p class="when">${r.task_status === 'completed' ? html`Done ${fmtDateTime(r.completed_at, tz())}` : html`${fmtDateTime(r.scheduled_at, tz())}${overdue ? html` <span class="badge tone-warn">Overdue</span>` : ''}`}</p>
          <dl class="kv">
            ${isWash ? html`<div><dt>For</dt><dd>${r.client_label}</dd></div>`
              : html`<div><dt>Pick up at</dt><dd>${mapLink(r.from_address)}</dd></div><div><dt>Take to</dt><dd>${mapLink(r.to_address)}</dd></div>`}
            <div><dt>Bags</dt><dd><strong>${r.task_status === 'completed' ? r.actual_bags : r.expected_bags}</strong>${r.bag_notes ? html` · ${r.bag_notes}` : ''}</dd></div>
            ${r.contact_name ? html`<div><dt>${r.task_type === 'pickup' ? 'Contact' : r.task_type === 'delivery' ? 'Recipient' : 'Washer'}</dt><dd>${r.contact_name} ${telLink(r.contact_phone)}</dd></div>` : ''}
            ${isWash && r.other_party_name ? html`<div><dt>Brought by</dt><dd>${r.other_party_name} ${telLink(r.other_party_phone)}</dd></div>` : ''}
            ${r.instructions ? html`<div><dt>Instructions</dt><dd>${r.instructions}</dd></div>` : ''}
            ${r.open_problems ? html`<div><dt>Problem</dt><dd class="warn-text">Reported — the dispatcher is looking into it</dd></div>` : ''}
          </dl>
          ${r.task_status !== 'completed' ? html`<div class="big-actions">
            ${acts.map((a, i) => html`<button class="btn ${i === acts.length - 1 ? 'btn-primary' : ''} btn-lg" data-act="record" data-task="${r.task_id}" data-event="${a.event}">${a.label}</button>`)}
            ${!r.can_act && r.order_status !== 'cancelled' ? html`<p class="muted">Waiting for the previous step to be recorded.</p>` : ''}
            <button class="btn btn-ghost" data-act="problem" data-task="${r.task_id}">Report a problem</button>
          </div>` : ''}
        </article>`;
    };

    setHtml(root, html`
      <header class="page-head"><div><h1>My tasks</h1><p class="sub">Hi ${state.ctx.full_name || ''}</p></div></header>
      <div class="tabs" role="tablist">
        ${[['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Done']].map(([k, l]) => html`
          <button class="tab ${tab === k ? 'active' : ''}" role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`)}
      </div>
      <div class="task-list">${rows.length ? rows.map(card)
        : emptyState(tab === 'done' ? 'Nothing completed in the last 30 days' : tab === 'today' ? 'Nothing for today' : 'Nothing upcoming',
          tab === 'today' ? 'New assignments will show up here and in your notifications.' : '')}</div>`);
  }

  on(root, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; setHtml(root, loading()); draw(); });
  on(root, 'click', '[data-action=reload]', () => draw());
  on(root, 'click', '[data-act]', async (e, el) => {
    const r = rows.find((x) => x.task_id === el.dataset.task);
    if (!r) return;
    const task = { id: r.task_id, task_type: r.task_type, status: r.task_status };
    try {
      let changed;
      if (el.dataset.act === 'problem') changed = await problemModal(task, r.order_no);
      else changed = await recordModal(task, { orderNoValue: r.order_no, washingReceived: r.washing_received, currentBags: r.expected_bags, preferEvent: el.dataset.event });
      if (changed) draw();
    } catch (err) { toast(err.message, 'error'); }
  });

  setHtml(root, loading());
  await draw();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-overlay')) draw(); }, 60000);
  return () => clearInterval(timer);
}
