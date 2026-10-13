// Reports from recorded handoff events, with CSV export.
import { sb, rpc, run, tz, state, settings, categoryLabel } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast } from '../components/ui.js';
import { todayInTz, startOfMonth, fmtDate, fmtDateTime, zonedToDate, addDays, orderNo, statusLabel } from '../lib/format.js';
import { toCsv, downloadCsv } from '../lib/csv.js';
import { app } from '../lib/app.js';

const DEFS = [
  ['orders_created', 'Orders created', 'Orders whose creation date falls in the range.'],
  ['orders_completed', 'Orders completed', 'Orders whose delivery was confirmed and all exceptions resolved within the range.'],
  ['orders_cancelled', 'Orders cancelled', 'Orders cancelled within the range (including skipped recurring dates).'],
  ['bags_collected', 'Bags collected', 'Sum of bag counts recorded at "collected from client" handoffs in the range (with corrections applied).'],
  ['bags_washed', 'Bags washed', 'Sum of bag counts recorded at "washing completed" in the range.'],
  ['bags_delivered', 'Bags delivered', 'Sum of bag counts recorded at "delivered to recipient" in the range.'],
  ['outstanding_orders', 'Outstanding orders', 'Orders created before the end of the range that are not completed or cancelled now.'],
  ['overdue_orders_now', 'Overdue orders (now)', 'Open orders with a stage past its scheduled time, as of right now.'],
  ['avg_turnaround_hours', 'Average turnaround (hours)', 'From collection to delivery, for deliveries in the range.'],
];

export async function render(root, { query }) {
  const today = todayInTz(tz());
  const f = { from: query.get('from') || startOfMonth(today), to: query.get('to') || today, category: query.get('category') || '' };
  setHtml(root, html`
    ${pageHeader('Reports', html`<button class="btn" data-export="orders">Export orders (CSV)</button>`)}
    <form class="filters card" data-filters>
      <label><span>From</span><input type="date" name="from" value="${f.from}" required></label>
      <label><span>To</span><input type="date" name="to" value="${f.to}" required></label>
      <select name="category" aria-label="Category"><option value="">All categories</option>
        ${(state.categories || []).map((c) => html`<option value="${c.id}" ${c.id === f.category ? raw('selected') : ''}>${c.label}</option>`)}</select>
      <button class="btn" type="submit">Run report</button>
    </form>
    <div data-report>${loading('Calculating…')}</div>`);
  on(root, 'submit', '[data-filters]', (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    if (v.to < v.from) { toast('The end date is before the start date.', 'error'); return; }
    const p = new URLSearchParams(Object.entries(v).filter(([, x]) => x));
    app.navigate('/reports?' + p);
  });

  const box = $('[data-report]', root);
  let r;
  try { r = await rpc('report_summary', { p_from: f.from, p_to: f.to, p_category: f.category || null }); }
  catch (err) { setHtml(box, errorState(err)); return; }
  const range = `${fmtDate(f.from)} – ${fmtDate(f.to)} (${r.time_zone})${f.category ? ' · ' + categoryLabel(f.category) : ''}`;
  const t = r.totals || {};

  const table = (key, title, cols, rows) => html`
    <section class="card">
      <header class="card-head"><h2>${title}</h2>${rows.length ? html`<button class="btn btn-sm" data-export="${key}">CSV</button>` : ''}</header>
      ${rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr>${cols.map((c) => html`<th>${c.label}</th>`)}</tr></thead>
        <tbody>${rows.map((row) => html`<tr>${cols.map((c) => html`<td data-label="${c.label}">${c.fmt ? c.fmt(row[c.key]) : row[c.key] ?? '—'}</td>`)}</tr>`)}</tbody>
      </table></div>` : emptyState('No data in this range', '')}
    </section>`;

  const tables = {
    by_category: { title: 'Service totals by category', cols: [
      { key: 'category', label: 'Category' }, { key: 'orders_created', label: 'Orders created' }, { key: 'orders_completed', label: 'Completed' },
      { key: 'bags_collected', label: 'Bags collected' }, { key: 'bags_washed', label: 'Bags washed' }, { key: 'bags_delivered', label: 'Bags delivered' }], rows: r.by_category || [] },
    washers: { title: 'Volunteer workload', cols: [
      { key: 'name', label: 'Volunteer' }, { key: 'washes_completed', label: 'Washes completed' }, { key: 'bags_washed', label: 'Bags washed' },
      { key: 'assigned_open', label: 'Open assignments now' }], rows: r.washers || [] },
    drivers: { title: 'Driver workload', cols: [
      { key: 'name', label: 'Driver' }, { key: 'pickups', label: 'Pickups' }, { key: 'dropoffs', label: 'Drop-offs' },
      { key: 'return_collections', label: 'Return collections' }, { key: 'deliveries', label: 'Deliveries' }, { key: 'bags_handled', label: 'Bags collected' }], rows: r.drivers || [] },
    exceptions: { title: 'Bag-count discrepancies & exceptions', cols: [
      { key: 'order_no', label: 'Order', fmt: orderNo }, { key: 'kind', label: 'Type', fmt: (k) => String(k).replace(/_/g, ' ') },
      { key: 'status', label: 'Status' }, { key: 'expected', label: 'Expected' }, { key: 'actual', label: 'Actual' },
      { key: 'description', label: 'Description' }, { key: 'reported_at', label: 'Reported', fmt: (d) => fmtDateTime(d, tz()) },
      { key: 'resolution', label: 'Resolution' }], rows: r.exceptions || [] },
    recurring: { title: 'Recurring schedule performance', cols: [
      { key: 'client', label: 'Client' }, { key: 'status', label: 'Series' }, { key: 'occurrences', label: 'Occurrences in range' },
      { key: 'completed', label: 'Completed' }, { key: 'cancelled_or_skipped', label: 'Cancelled / skipped' }, { key: 'open', label: 'Still open' }], rows: r.recurring || [] },
  };

  setHtml(box, html`
    <p class="report-range"><strong>Reporting period:</strong> ${range}</p>
    <section class="stats">${DEFS.map(([k, label, def]) => html`
      <div class="stat" title="${def}"><span class="stat-value">${t[k] ?? '—'}</span><span class="stat-label">${label}</span></div>`)}</section>
    <details class="card"><summary>How these numbers are calculated</summary>
      <dl class="kv">${DEFS.map(([, label, def]) => html`<div><dt>${label}</dt><dd>${def}</dd></div>`)}</dl>
      <p class="muted">Collected, washed and delivered are separate totals and are never interchanged. Undone steps are excluded.</p>
      <button class="btn btn-sm" data-export="totals">Export totals (CSV)</button></details>
    ${Object.entries(tables).map(([k, x]) => table(k, x.title, x.cols, x.rows))}`);

  on(root, 'click', '[data-export]', async (e, el) => {
    const k = el.dataset.export;
    const stamp = `${f.from}_to_${f.to}${f.category ? '_' + f.category : ''}`;
    try {
      if (k === 'totals') {
        downloadCsv(`kvisa-totals-${stamp}.csv`, toCsv(DEFS.map(([key, label, def]) => ({ metric: label, value: t[key], definition: def, period: range })),
          [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }, { key: 'definition', label: 'Definition' }, { key: 'period', label: 'Period' }]));
      } else if (k === 'orders') {
        let q = sb.from('order_overview').select('*')
          .gte('created_at', zonedToDate(f.from, '00:00', tz()).toISOString())
          .lt('created_at', zonedToDate(addDays(f.to, 1), '00:00', tz()).toISOString()).order('order_no');
        if (f.category) q = q.eq('category_id', f.category);
        const rows = await run(q.limit(10000));
        downloadCsv(`kvisa-orders-${stamp}.csv`, toCsv(rows, [
          { key: 'order_no', label: 'Order', value: (o) => orderNo(o.order_no) }, { key: 'client_name', label: 'Client' },
          { key: 'category_label', label: 'Category' }, { key: 'status', label: 'Status', value: (o) => statusLabel(o.status, settings()) },
          { key: 'expected_bags', label: 'Expected bags' }, { key: 'current_bags', label: 'Current bags' },
          { key: 'current_location', label: 'Location' }, { key: 'pickup_at', label: 'Pickup', value: (o) => fmtDateTime(o.pickup_at, tz(), { year: true }) },
          { key: 'pickup_driver_name', label: 'Pickup driver' }, { key: 'washer_name', label: 'Washer' }, { key: 'delivery_driver_name', label: 'Delivery driver' },
          { key: 'expected_return_date', label: 'Expected return' }, { key: 'completed_at', label: 'Completed', value: (o) => o.completed_at ? fmtDateTime(o.completed_at, tz(), { year: true }) : '' },
          { key: 'open_exceptions', label: 'Open exceptions' }, { key: 'cancel_reason', label: 'Cancel reason' },
        ]));
      } else {
        const x = tables[k];
        downloadCsv(`kvisa-${k}-${stamp}.csv`, toCsv(x.rows, x.cols.map((c) => ({ key: c.key, label: c.label, value: c.fmt ? (row) => c.fmt(row[c.key]) : undefined }))));
      }
    } catch (err) { toast(err.message, 'error'); }
  });
}
