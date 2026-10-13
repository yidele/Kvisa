// Live operational dashboard. Every number comes from the database (dashboard_summary).
import { sb, rpc, run, tz, settings } from '../lib/api.js';
import { html, setHtml, on, $ } from '../lib/dom.js';
import { pageHeader, statusBadge, loading, errorState, emptyState } from '../components/ui.js';
import { todayInTz, zonedToDate, addDays, fmtDateTime, fmtTime, taskLabel, orderNo, relativeTime } from '../lib/format.js';
import { app } from '../lib/app.js';

export async function render(root) {
  let date = todayInTz(tz());

  const draw = async () => {
    setHtml(root, html`
      ${pageHeader('Dashboard', html`
        <label class="inline-field"><span class="sr-only">Date</span><input type="date" value="${date}" data-date></label>
        <a class="btn btn-primary" href="#/orders/new">+ New order</a>
        <a class="btn" href="#/clients/new">+ Add client</a>
        <a class="btn" href="#/dispatch?filter=unassigned">Assign tasks</a>`)}
      <div data-body>${loading()}</div>`);
    const body = $('[data-body]', root);
    try {
      const start = zonedToDate(date, '00:00', tz()).toISOString();
      const end = zonedToDate(addDays(date, 1), '00:00', tz()).toISOString();
      const [s, today, urgent, recent, delivered] = await Promise.all([
        rpc('dashboard_summary', { p_date: date }),
        run(sb.from('task_calendar').select('*').gte('scheduled_at', start).lt('scheduled_at', end)
          .in('task_status', ['pending', 'in_progress']).neq('order_status', 'cancelled').order('scheduled_at').limit(50)),
        run(sb.from('order_overview').select('*').or('is_overdue.eq.true,open_exceptions.gt.0,status.eq.exception')
          .not('status', 'in', '(completed,cancelled)').order('pickup_at').limit(20)),
        run(sb.from('order_overview').select('id,order_no,client_name,status,updated_at').order('updated_at', { ascending: false }).limit(8)),
        run(sb.from('handoff_effective').select('order_id,occurred_at,effective_bags,to_party').eq('event_type', 'delivered_to_recipient')
          .order('occurred_at', { ascending: false }).limit(8)),
      ]);
      const deliveredOrders = delivered.length
        ? await run(sb.from('orders').select('id,order_no').in('id', delivered.map((d) => d.order_id))) : [];
      const noById = Object.fromEntries(deliveredOrders.map((o) => [o.id, o.order_no]));
      const card = (label, value, href, tone = '') => html`
        <a class="stat ${tone}" href="${href}"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></a>`;
      setHtml(body, html`
        <section class="stats" aria-label="Summary for ${date}">
          ${card('Pickups scheduled', s.pickups_scheduled, `#/calendar?view=day&date=${date}`)}
          ${card('Pickups completed', s.pickups_completed, '#/history?action=handoff.collected_from_client')}
          ${card('Awaiting washing', s.awaiting_washing, '#/dispatch?status=awaiting_washing,awaiting_dropoff')}
          ${card('Being washed', s.washing_in_progress, '#/dispatch?status=washing_in_progress')}
          ${card(`Bags ready for return (${s.orders_ready_for_return} orders)`, s.bags_ready_for_return, '#/dispatch?status=ready_for_return')}
          ${card('Returns scheduled', s.returns_scheduled, `#/calendar?view=day&date=${date}`)}
          ${card('Overdue / delayed', s.overdue, '#/dispatch?filter=overdue', s.overdue ? 'warn' : '')}
          ${card('Unresolved discrepancies', s.open_discrepancies, '#/dispatch?filter=attention', s.open_discrepancies ? 'danger' : '')}
          ${card('Volunteers assigned / active', `${s.washers_assigned} / ${s.washers_active}`, '#/volunteers')}
          ${card('Driver tasks outstanding', s.driver_tasks_outstanding, '#/drivers')}
          ${card('Unassigned tasks (7 days)', s.unassigned_tasks, '#/dispatch?filter=unassigned', s.unassigned_tasks ? 'warn' : '')}
        </section>
        <div class="grid-2">
          <section class="card">
            <h2>Upcoming tasks — ${date === todayInTz(tz()) ? 'today' : date}</h2>
            ${today.length ? html`<ul class="list">${today.map((t) => html`
              <li><a href="#/orders/${t.order_id}" class="row-link">
                <span class="time">${fmtTime(t.scheduled_at, tz())}</span>
                <span><strong>${taskLabel(t.task_type, settings())}</strong> · ${orderNo(t.order_no)} · ${t.client_name}
                  <small class="${t.assignee_name ? 'muted' : 'warn-text'}">${t.assignee_name || 'Unassigned'}</small></span>
              </a></li>`)}</ul>` : emptyState('Nothing scheduled', 'No open tasks on this day.')}
          </section>
          <section class="card">
            <h2>Urgent & overdue</h2>
            ${urgent.length ? html`<ul class="list">${urgent.map((o) => html`
              <li><a href="#/orders/${o.id}" class="row-link">
                <span>${orderNo(o.order_no)} · ${o.client_name}</span>
                <span>${statusBadge(o.status)} ${o.is_overdue ? html`<span class="badge tone-warn">Overdue</span>` : ''}
                  ${o.open_exceptions ? html`<span class="badge tone-danger">${o.open_exceptions} issue(s)</span>` : ''}</span>
              </a></li>`)}</ul>` : emptyState('All clear', 'No overdue orders or open issues.')}
          </section>
          <section class="card">
            <h2>Recently changed</h2>
            ${recent.length ? html`<ul class="list">${recent.map((o) => html`
              <li><a href="#/orders/${o.id}" class="row-link"><span>${orderNo(o.order_no)} · ${o.client_name}</span>
                <span>${statusBadge(o.status)} <small class="muted">${relativeTime(o.updated_at)}</small></span></a></li>`)}</ul>`
              : emptyState('No orders yet', 'Create the first order to get started.', html`<a class="btn btn-primary" href="#/orders/new">New order</a>`)}
          </section>
          <section class="card">
            <h2>Recent deliveries</h2>
            ${delivered.length ? html`<ul class="list">${delivered.map((d) => html`
              <li><a href="#/orders/${d.order_id}" class="row-link"><span>${orderNo(noById[d.order_id])} · ${d.effective_bags} bag(s) to ${d.to_party || 'recipient'}</span>
                <small class="muted">${fmtDateTime(d.occurred_at, tz())}</small></a></li>`)}</ul>` : emptyState('No deliveries yet', '')}
          </section>
        </div>`);
    } catch (err) {
      setHtml(body, errorState(err));
    }
  };

  on(root, 'change', '[data-date]', (e, el) => { if (el.value) { date = el.value; draw(); } });
  on(root, 'click', '[data-action=reload]', () => draw());
  await draw();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-overlay')) draw(); }, 60000);
  return () => clearInterval(timer);
}
