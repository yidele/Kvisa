// Recent History: the append-only audit log, searchable and filterable.
import { sb, run, tz, state, personName } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, pager } from '../components/ui.js';
import { fmtDateTime, zonedToDate, addDays, statusLabel, taskLabel, orderNo, EVENT_LABELS } from '../lib/format.js';
import { settings } from '../lib/api.js';
import { app } from '../lib/app.js';

export const ACTION_LABELS = {
  'order.created': 'Order created', 'order.edited': 'Order edited', 'order.bag_count_changed': 'Bag count changed',
  'order.address_changed': 'Address changed', 'order.status_changed': 'Status changed', 'order.cancelled': 'Order cancelled',
  'order.reopened': 'Order reopened', 'task.created': 'Stage created', 'task.assigned': 'Assigned', 'task.reassigned': 'Reassigned',
  'task.rescheduled': 'Time changed', 'task.status_changed': 'Stage progress', 'task.address_changed': 'Stage address changed',
  'task.bag_count_changed': 'Stage bag count changed', 'task.edited': 'Stage edited', 'task.reopened': 'Stage reopened (undo)',
  'exception.reported': 'Exception reported', 'exception.resolved': 'Exception resolved',
  'recurring.insert': 'Recurring schedule created', 'recurring.update': 'Recurring schedule changed',
  'recurring.updated': 'Recurring series edited', 'recurring.generated': 'Order generated from schedule',
  'recurring.series_applied': 'Series change applied', 'recurring.status_changed': 'Series paused / resumed / cancelled',
  'handoff.count_correction': 'Bag count corrected', 'handoff.event_reverted': 'Step undone',
  'offer.dispatched': 'Dispatched to drivers', 'offer.accepted': 'Driver accepted job', 'offer.declined': 'Driver declined job',
  'offer.cancelled': 'Offer cancelled', 'offer.expired': 'Offer expired', 'offer.access_revoked': 'Driver access revoked (reassigned)',
  'task.offers.insert': 'Offer created', 'offer.recipients.insert': 'Driver offered',
  'user.roles_changed': 'User roles changed', 'user.activated': 'User activated', 'user.deactivated': 'User deactivated',
};
for (const [k, v] of Object.entries(EVENT_LABELS)) ACTION_LABELS['handoff.' + k] = 'Handoff: ' + v;

const FIELD_LABELS = {
  assignee_id: 'Assignee', scheduled_at: 'Scheduled', expected_bags: 'Expected bags', actual_bags: 'Actual bags',
  status: 'Status', pickup_address: 'Pickup address', return_address: 'Return address', from_address: 'From',
  to_address: 'To', notes: 'Notes', delivery_instructions: 'Instructions', return_recipient: 'Recipient',
  completed_at: 'Completed', started_at: 'Started', cancel_reason: 'Cancel reason', full_name: 'Name', active: 'Active',
};
const HIDDEN = new Set(['id', 'created_at', 'order_id', 'client_id', 'seq', 'original_scheduled_at', 'created_by', 'recorded_by',
  'recorded_at', 'cancelled_by', 'detached_from_series', 'person_no', 'client_no', 'order_no']);

function fmtVal(k, v, entity) {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'assignee_id' || k.endsWith('person_id') || k.startsWith('default_') && k.endsWith('_id')) return personName(v) || 'someone';
  if (k === 'status' && entity === 'orders') return statusLabel(v, settings());
  if (k === 'task_type') return taskLabel(v, settings());
  if (/_at$/.test(k) && typeof v === 'string') return fmtDateTime(v, tz());
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function changes(row) {
  const n = row.new_value || {}; const o = row.old_value || {};
  if (row.action.startsWith('handoff.') && n.event_type) {
    return n.actual_bags != null ? `${n.actual_bags} bag(s)${n.expected_bags != null && n.expected_bags !== n.actual_bags ? ` (expected ${n.expected_bags})` : ''}` : '';
  }
  if (!row.old_value) {
    if (row.entity === 'orders') return `${n.expected_bags ?? ''} bag(s)`;
    return '';
  }
  return Object.keys(n).filter((k) => !HIDDEN.has(k)).map((k) =>
    `${FIELD_LABELS[k] || k.replace(/_/g, ' ')}: ${fmtVal(k, o[k], row.entity)} → ${fmtVal(k, n[k], row.entity)}`).join('; ');
}

export function renderAuditList(rows, { showOrder = true, orderNos = {} } = {}) {
  if (!rows.length) return emptyState('No history yet', '');
  return html`<ol class="audit">${rows.map((r) => html`
    <li>
      <div class="audit-head"><strong>${ACTION_LABELS[r.action] || r.action}</strong>
        ${showOrder && r.order_id ? html` · <a href="#/orders/${r.order_id}">${orderNos[r.order_id] ? orderNo(orderNos[r.order_id]) : 'order'}</a>` : ''}
        <small class="muted">${fmtDateTime(r.at, tz(), { year: false })} · ${r.actor_email || 'system'}</small></div>
      ${changes(r) ? html`<div class="audit-change">${changes(r)}</div>` : ''}
      ${r.reason ? html`<div class="audit-reason">Reason: ${r.reason}</div>` : ''}
    </li>`)}</ol>`;
}

const PAGE = 50;

export async function render(root, { query }) {
  const f = {
    from: query.get('from') || '', to: query.get('to') || '', user: query.get('user') || '',
    action: query.get('action') || '', order: query.get('order') || '', client: query.get('client') || '',
    page: Math.max(1, Number(query.get('page') || 1)),
  };
  const [users, clients] = await Promise.all([
    run(sb.from('profiles').select('id,email,full_name').order('email')),
    run(sb.from('clients').select('id,name').order('name')),
  ]);
  const nav = (patch) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v && !(k === 'page' && v === 1)) p.set(k, v);
    app.navigate('/history' + (p.toString() ? '?' + p : ''));
  };
  const actions = Object.keys(ACTION_LABELS);
  setHtml(root, html`
    ${pageHeader('Recent History', null, 'Every change is recorded here permanently. Entries cannot be edited or deleted.')}
    <form class="filters card" data-filters>
      <label><span>From</span><input type="date" name="from" value="${f.from}"></label>
      <label><span>To</span><input type="date" name="to" value="${f.to}"></label>
      <select name="user" aria-label="User"><option value="">Any user</option>
        ${users.map((u) => html`<option value="${u.id}" ${u.id === f.user ? raw('selected') : ''}>${u.full_name || u.email}</option>`)}</select>
      <select name="client" aria-label="Client"><option value="">Any client</option>
        ${clients.map((c) => html`<option value="${c.id}" ${c.id === f.client ? raw('selected') : ''}>${c.name}</option>`)}</select>
      <select name="action" aria-label="Action"><option value="">Any action</option>
        ${actions.map((a) => html`<option value="${a}" ${a === f.action ? raw('selected') : ''}>${ACTION_LABELS[a]}</option>`)}</select>
      <input name="order" value="${f.order}" placeholder="Order # (e.g. K-1001)" aria-label="Order number">
      <button class="btn" type="submit">Apply</button>
      ${Object.entries(f).some(([k, v]) => k !== 'page' && v) ? html`<a class="btn btn-ghost" href="#/history">Clear</a>` : ''}
    </form>
    <section class="card" data-list>${loading()}</section>`);

  on(root, 'submit', '[data-filters]', (e, form) => { e.preventDefault(); nav({ ...formValues(form), page: 1 }); });
  on(root, 'change', '[data-filters] select, [data-filters] input[type=date]', (e, el) => el.form.requestSubmit());
  on(root, 'click', '[data-action=page]', (e, el) => nav({ page: Number(el.dataset.page) }));

  const box = $('[data-list]', root);
  try {
    let q = sb.from('audit_logs').select('*', { count: 'exact' });
    if (f.from) q = q.gte('at', zonedToDate(f.from, '00:00', tz()).toISOString());
    if (f.to) q = q.lt('at', zonedToDate(addDays(f.to, 1), '00:00', tz()).toISOString());
    if (f.user) q = q.eq('actor_id', f.user);
    if (f.client) q = q.eq('client_id', f.client);
    if (f.action) q = q.eq('action', f.action);
    if (f.order) {
      const n = Number(String(f.order).replace(/\D/g, ''));
      const o = n ? await run(sb.from('orders').select('id').eq('order_no', n).maybeSingle()) : null;
      q = q.eq('order_id', o ? o.id : '00000000-0000-0000-0000-000000000000');
    }
    q = q.order('at', { ascending: false }).range((f.page - 1) * PAGE, f.page * PAGE - 1);
    const { data, count } = await run(q);
    const ids = [...new Set(data.map((r) => r.order_id).filter(Boolean))];
    const nos = ids.length ? await run(sb.from('orders').select('id,order_no').in('id', ids)) : [];
    setHtml(box, html`${renderAuditList(data, { orderNos: Object.fromEntries(nos.map((o) => [o.id, o.order_no])) })}${pager(f.page, PAGE, count)}`);
  } catch (err) { setHtml(box, errorState(err)); }
}
