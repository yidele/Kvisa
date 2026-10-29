// Dispatcher: the main operations table with filters and quick actions.
import { sb, run, tz, settings, state, peopleWithRole, categoryLabel } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, statusBadge, loading, errorState, emptyState, pager, toast } from '../components/ui.js';
import {
  ORDER_STATUSES, statusLabel, taskLabel, orderNo, fmtDateTime, fmtDate, relativeTime, zonedToDate, addDays,
} from '../lib/format.js';
import { assignModal, recordModal, cancelOrder, reopenOrder, changeBagsModal, rescheduleModal, loadTasks, dispatchModal, dispatchBadge } from '../components/orderActions.js';
import { DRIVER_STAGES, dispatchButtonLabel } from '../lib/format.js';
import { app } from '../lib/app.js';
import { postJobsModal } from '../components/postJobs.js';

const PAGE = 50;

function readFilters(query) {
  return {
    q: query.get('q') || '',
    from: query.get('from') || '',
    to: query.get('to') || '',
    category: query.get('category') || '',
    status: query.get('status') || '',
    driver: query.get('driver') || '',
    washer: query.get('washer') || '',
    filter: query.get('filter') || '',      // overdue | unassigned | attention
    closed: query.get('closed') === '1',
    page: Math.max(1, Number(query.get('page') || 1)),
  };
}

function toQuery(f) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (k === 'page' && v === 1) continue;
    if (v === true) p.set(k, '1'); else if (v && v !== false) p.set(k, v);
  }
  const s = p.toString();
  return '/dispatch' + (s ? '?' + s : '');
}

export async function render(root, { query }) {
  const f = readFilters(query);
  const cats = state.categories || [];
  const drivers = peopleWithRole('driver', { includeInactive: true });
  const washers = peopleWithRole('washer', { includeInactive: true });
  const statusSet = f.status ? f.status.split(',') : [];
  const active = ['q', 'from', 'to', 'category', 'status', 'driver', 'washer', 'filter'].some((k) => f[k]) || f.closed;

  setHtml(root, html`
    ${pageHeader('Dispatcher', html`<button class="btn" data-action="post-jobs">Post jobs</button> <a class="btn btn-primary" href="#/orders/new">+ New order</a>`)}
    <details class="card filter-box" ${active || window.matchMedia('(min-width: 901px)').matches ? raw('open') : ''}>
    <summary>Filters${active ? ' (active)' : ''}</summary>
    <form class="filters card" data-filters>
      <input type="search" name="q" value="${f.q}" placeholder="Order # or client name" aria-label="Search orders">
      <label><span>From</span><input type="date" name="from" value="${f.from}"></label>
      <label><span>To</span><input type="date" name="to" value="${f.to}"></label>
      <select name="category" aria-label="Category"><option value="">All categories</option>
        ${cats.map((c) => html`<option value="${c.id}" ${c.id === f.category ? raw('selected') : ''}>${c.label}</option>`)}</select>
      <select name="status" aria-label="Status"><option value="">Any status</option>
        ${ORDER_STATUSES.map((s) => html`<option value="${s}" ${statusSet.length === 1 && statusSet[0] === s ? raw('selected') : ''}>${statusLabel(s, settings())}</option>`)}
        ${statusSet.length > 1 ? html`<option value="${f.status}" selected>${statusSet.map((s) => statusLabel(s, settings())).join(' / ')}</option>` : ''}</select>
      <select name="driver" aria-label="Driver"><option value="">Any driver</option>
        ${drivers.map((p) => html`<option value="${p.id}" ${p.id === f.driver ? raw('selected') : ''}>${p.full_name}</option>`)}</select>
      <select name="washer" aria-label="Washing volunteer"><option value="">Any volunteer</option>
        ${washers.map((p) => html`<option value="${p.id}" ${p.id === f.washer ? raw('selected') : ''}>${p.full_name}</option>`)}</select>
      <select name="filter" aria-label="Quick filter"><option value="">All orders</option>
        <option value="attention" ${f.filter === 'attention' ? raw('selected') : ''}>Needs attention</option>
        <option value="overdue" ${f.filter === 'overdue' ? raw('selected') : ''}>Overdue</option>
        <option value="unassigned" ${f.filter === 'unassigned' ? raw('selected') : ''}>Missing assignments</option></select>
      <label class="check"><input type="checkbox" name="closed" ${f.closed ? raw('checked') : ''}> Include completed & cancelled</label>
      <button class="btn" type="submit">Apply</button>
      ${active ? html`<a class="btn btn-ghost" href="#/dispatch">Clear filters</a>` : ''}
    </form></details>
    <div data-table>${loading()}</div>`);

  on(root, 'submit', '[data-filters]', (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    app.navigate(toQuery({ ...v, closed: !!v.closed, page: 1 }));
  });
  on(root, 'change', '[data-filters] select, [data-filters] input[type=checkbox], [data-filters] input[type=date]', (e, el) => {
    el.form.requestSubmit();
  });
  on(root, 'click', '[data-action=page]', (e, el) => app.navigate(toQuery({ ...f, page: Number(el.dataset.page) })));
  on(root, 'click', '[data-action=reload]', () => load());
  on(root, 'click', '[data-action=post-jobs]', async () => {
    try { if (await postJobsModal()) load(); } catch (err) { toast(err.message, 'error'); }
  });

  const rowsById = new Map();
  on(root, 'click', '[data-act]', async (e, el) => {
    const o = rowsById.get(el.dataset.id);
    if (!o) return;
    try {
      let changed = null;
      switch (el.dataset.act) {
        case 'assign': changed = await assignModal(o.id); break;
        case 'record': {
          if (!o.next_task_id) return;
          const tasks = await loadTasks(o.id);
          const t = tasks.find((x) => x.id === o.next_task_id);
          const { data: rec } = await sb.from('handoff_effective').select('id').eq('task_id', t.id).eq('event_type', 'received_by_washer').limit(1);
          changed = await recordModal(t, { orderNoValue: o.order_no, washingReceived: !!(rec && rec.length), currentBags: o.current_bags });
          break;
        }
        case 'bags': changed = await changeBagsModal(o); break;
        case 'reschedule': changed = await rescheduleModal(o, await loadTasks(o.id)); break;
        case 'cancel': changed = await cancelOrder(o); break;
        case 'reopen': changed = await reopenOrder(o); break;
        case 'dispatch': changed = await dispatchModal(el.dataset.task, { orderNoValue: o.order_no, taskType: el.dataset.type }); break;
      }
      if (changed) load();
    } catch (err) { toast(err.message, 'error'); }
  });

  async function load() {
    const box = $('[data-table]', root);
    try {
      let q = sb.from('order_overview').select('*', { count: 'exact' });
      if (f.q) {
        const n = f.q.replace(/^k-?/i, '');
        q = /^\d+$/.test(n) ? q.eq('order_no', Number(n)) : q.ilike('client_name', `%${f.q}%`);
      }
      if (f.from) q = q.gte('pickup_at', zonedToDate(f.from, '00:00', tz()).toISOString());
      if (f.to) q = q.lt('pickup_at', zonedToDate(addDays(f.to, 1), '00:00', tz()).toISOString());
      if (f.category) q = q.eq('category_id', f.category);
      if (statusSet.length) q = q.in('status', statusSet);
      else if (!f.closed) q = q.not('status', 'in', '(completed,cancelled)');
      if (f.driver) q = q.or(`pickup_driver_id.eq.${f.driver},delivery_driver_id.eq.${f.driver},next_assignee_id.eq.${f.driver}`);
      if (f.washer) q = q.eq('washer_id', f.washer);
      if (f.filter === 'overdue') q = q.eq('is_overdue', true);
      if (f.filter === 'unassigned') q = q.eq('has_unassigned', true);
      if (f.filter === 'attention') q = q.or('is_overdue.eq.true,open_exceptions.gt.0,status.eq.exception,has_unassigned.eq.true');
      q = q.order('pickup_at', { ascending: true, nullsFirst: false }).range((f.page - 1) * PAGE, f.page * PAGE - 1);
      const { data, count } = await run(q);
      rowsById.clear();
      // driver-dispatch state of each order's next driver stage
      const disp = data.length ? await run(sb.from('task_dispatch').select('*').in('order_id', data.map((o) => o.id))) : [];
      const nextDrive = {};
      for (const o of data) {
        const stages = disp.filter((d) => d.order_id === o.id && DRIVER_STAGES.includes(d.task_type)).sort((a, b) => a.seq - b.seq);
        nextDrive[o.id] = stages.find((d) => d.task_status !== 'completed' && d.task_status !== 'cancelled') || null;
      }
      const dispatchCell = (o) => {
        const d = nextDrive[o.id];
        if (!d || o.status === 'cancelled') return html`—`;
        const ready = !d.blocked_reason && ['not_dispatched', 'declined', 'expired', 'cancelled'].includes(d.dispatch_status);
        return html`${dispatchBadge(d.dispatch_status)}<br><small class="muted">${taskLabel(d.task_type, settings())}</small>
          ${ready ? html`<br><button class="btn btn-sm btn-primary" data-act="dispatch" data-id="${o.id}" data-task="${d.task_id}" data-type="${d.task_type}">${dispatchButtonLabel(d.task_type)}</button>` : ''}`;
      };
      data.forEach((o) => rowsById.set(o.id, o));
      if (!data.length) {
        setHtml(box, emptyState(active ? 'No orders match these filters' : 'No open orders',
          active ? 'Try clearing some filters.' : 'Create an order to get started.',
          active ? html`<a class="btn" href="#/dispatch">Clear filters</a>` : html`<a class="btn btn-primary" href="#/orders/new">New order</a>`));
        return;
      }
      setHtml(box, html`
        <div class="table-wrap card">
          <table class="table dispatch-table">
            <thead><tr>
              <th>Order</th><th>Client</th><th>Status</th><th>Bags</th><th>Location</th><th>Next step</th>
              <th>Driver (pickup / delivery)</th><th>Washer</th><th>Pickup</th><th>Return by</th><th>Driver dispatch</th><th>Updated</th><th><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>${data.map((o) => html`
              <tr class="${o.is_overdue || o.open_exceptions ? 'row-flag' : ''}">
                <td data-label="Order"><a href="#/orders/${o.id}"><strong>${orderNo(o.order_no)}</strong></a>
                  ${o.recurring_schedule_id ? html`<span class="badge tone-neutral" title="Recurring">↻</span>` : ''}</td>
                <td data-label="Client"><a href="#/clients/${o.client_id}">${o.client_name}</a><br><small class="muted">${o.category_label || categoryLabel(o.category_id)}</small></td>
                <td data-label="Status">${statusBadge(o.status)}
                  ${o.is_overdue ? html`<span class="badge tone-warn">Overdue</span>` : ''}
                  ${o.open_exceptions ? html`<span class="badge tone-danger">${o.open_exceptions} issue</span>` : ''}</td>
                <td data-label="Bags">${o.current_bags}${o.current_bags !== o.expected_bags ? html` <small class="muted">(exp. ${o.expected_bags})</small>` : ''}</td>
                <td data-label="Location">${o.current_location}</td>
                <td data-label="Next step">${o.next_task_type ? html`${taskLabel(o.next_task_type, settings())}<br>
                  <small class="${o.next_assignee_name ? 'muted' : 'warn-text'}">${o.next_assignee_name || 'Unassigned'}</small>` : '—'}</td>
                <td data-label="Drivers">${o.pickup_driver_name || html`<span class="warn-text">—</span>`} / ${o.delivery_driver_name || html`<span class="warn-text">—</span>`}</td>
                <td data-label="Washer">${o.washer_name || html`<span class="warn-text">Unassigned</span>`}</td>
                <td data-label="Pickup">${fmtDateTime(o.pickup_at, tz())}</td>
                <td data-label="Return by">${fmtDate(o.expected_return_date, tz())}</td>
                <td data-label="Dispatch">${dispatchCell(o)}</td>
                <td data-label="Updated"><small>${relativeTime(o.updated_at)}</small></td>
                <td class="actions">
                  <a class="btn btn-sm" href="#/orders/${o.id}">Open</a>
                  <a class="btn btn-sm" href="#/orders/${o.id}/edit">Edit</a>
                  <details class="menu"><summary class="btn btn-sm" aria-label="More actions">⋯</summary>
                    <div class="menu-list">
                      ${o.status !== 'cancelled' && o.status !== 'completed' ? html`
                        <button data-act="assign" data-id="${o.id}">Assign / reassign</button>
                        ${o.next_task_id ? html`<button data-act="record" data-id="${o.id}">Record handoff</button>` : ''}
                        <button data-act="reschedule" data-id="${o.id}">Change date</button>
                        <button data-act="bags" data-id="${o.id}">Change bag count</button>
                        <button data-act="cancel" data-id="${o.id}" class="danger">Cancel order</button>` : ''}
                      ${o.status === 'cancelled' ? html`<button data-act="reopen" data-id="${o.id}">Reopen order</button>` : ''}
                    </div></details>
                </td>
              </tr>`)}</tbody>
          </table>
        </div>
        ${pager(f.page, PAGE, count)}`);
    } catch (err) {
      setHtml(box, errorState(err));
    }
  }
  await load();
  // close open menus when clicking elsewhere
  const closeMenus = (e) => root.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  document.addEventListener('click', closeMenus);
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-overlay') && !root.querySelector('details.menu[open]')) load(); }, 60000);
  return () => { clearInterval(timer); document.removeEventListener('click', closeMenus); };
}
