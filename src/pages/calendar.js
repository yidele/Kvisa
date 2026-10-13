// Calendar & weekly schedule: day / week / month / list views of every stage.
import { sb, run, tz, settings, state, peopleWithRole } from '../lib/api.js';
import { html, raw, setHtml, $, $$, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast, confirmAction } from '../components/ui.js';
import {
  todayInTz, addDays, startOfWeek, startOfMonth, daysInMonth, weekdayOf, zonedToDate, dateToZonedParts,
  fmtTime, fmtDate, taskLabel, orderNo, WEEKDAYS, statusLabel,
} from '../lib/format.js';
import { app } from '../lib/app.js';

const TYPE_SHORT = { pickup: 'Pickup', dropoff: 'Drop-off', washing: 'Wash', return_collection: 'Return pickup', delivery: 'Delivery' };

export async function render(root, { query }) {
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  const f = {
    view: query.get('view') || (narrow ? 'list' : 'week'),
    date: query.get('date') || todayInTz(tz()),
    person: query.get('person') || '',
    category: query.get('category') || '',
    types: query.get('types') || '',
    unassigned: query.get('unassigned') === '1',
  };
  const nav = (patch) => {
    const n = { ...f, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(n)) if (v === true) p.set(k, '1'); else if (v) p.set(k, v);
    app.navigate('/calendar?' + p);
  };

  let start; let days;
  if (f.view === 'day') { start = f.date; days = 1; }
  else if (f.view === 'week') { start = startOfWeek(f.date); days = 7; }
  else if (f.view === 'month') { start = startOfWeek(startOfMonth(f.date)); days = Math.ceil((weekdayOf(startOfMonth(f.date)) + daysInMonth(f.date)) / 7) * 7; }
  else { start = f.date; days = 14; }
  const end = addDays(start, days);
  const step = { day: 1, week: 7, month: 0, list: 14 }[f.view];
  const prev = f.view === 'month' ? addDays(startOfMonth(f.date), -1) : addDays(f.date, -step);
  const next = f.view === 'month' ? addDays(startOfMonth(f.date), daysInMonth(f.date)) : addDays(f.date, step);
  const people = state.people || [];
  const typeSet = f.types ? f.types.split(',') : [];

  setHtml(root, html`
    ${pageHeader('Calendar & weekly schedule', html`<a class="btn btn-primary" href="#/orders/new?date=${f.date}">+ New order</a>`)}
    <div class="cal-toolbar card">
      <div class="btn-group" role="group" aria-label="View">
        ${['day', 'week', 'month', 'list'].map((v) => html`<button class="btn btn-sm ${f.view === v ? 'active' : ''}" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`)}
      </div>
      <div class="btn-group">
        <button class="btn btn-sm" data-go="${prev}" aria-label="Previous">‹</button>
        <button class="btn btn-sm" data-go="${todayInTz(tz())}">Today</button>
        <button class="btn btn-sm" data-go="${next}" aria-label="Next">›</button>
      </div>
      <strong class="cal-range">${f.view === 'month' ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(f.date + 'T12:00:00Z'))
        : `${fmtDate(start)} – ${fmtDate(addDays(end, -1))}`}</strong>
      <form class="cal-filters" data-filters>
        <select name="person" aria-label="Person"><option value="">Everyone</option>
          ${people.filter((p) => p.active).map((p) => html`<option value="${p.id}" ${p.id === f.person ? raw('selected') : ''}>${p.full_name}</option>`)}</select>
        <select name="category" aria-label="Category"><option value="">All categories</option>
          ${(state.categories || []).map((c) => html`<option value="${c.id}" ${c.id === f.category ? raw('selected') : ''}>${c.label}</option>`)}</select>
        <select name="types" aria-label="Stage"><option value="">All stages</option>
          <option value="pickup,dropoff" ${f.types === 'pickup,dropoff' ? raw('selected') : ''}>Pickups & drop-offs</option>
          <option value="washing" ${f.types === 'washing' ? raw('selected') : ''}>Washing</option>
          <option value="return_collection,delivery" ${f.types === 'return_collection,delivery' ? raw('selected') : ''}>Returns & deliveries</option></select>
        <label class="check"><input type="checkbox" name="unassigned" ${f.unassigned ? raw('checked') : ''}> Unassigned only</label>
      </form>
    </div>
    <div data-cal>${loading()}</div>
    <p class="muted legend">
      ${['pickup', 'dropoff', 'washing', 'return_collection', 'delivery'].map((t) => html`<span class="ev ev-${t}">${TYPE_SHORT[t]}</span> `)}
      · <span class="ev ev-conflict">Conflict</span> · <span class="ev ev-unassigned">Unassigned</span>
      ${narrow ? '' : ' · Drag a not-started item to another day to move it.'}</p>`);

  on(root, 'click', '[data-view]', (e, el) => nav({ view: el.dataset.view }));
  on(root, 'click', '[data-go]', (e, el) => nav({ date: el.dataset.go }));
  on(root, 'change', '[data-filters]', (e) => {
    const v = formValues(e.target.form);
    nav({ person: v.person, category: v.category, types: v.types, unassigned: !!v.unassigned });
  });
  on(root, 'click', '[data-day]', (e, el) => { if (e.target.closest('a, button')) return; if (f.view !== 'day') nav({ view: 'day', date: el.dataset.day }); });

  const box = $('[data-cal]', root);
  let items;
  try {
    let q = sb.from('task_calendar').select('*')
      .gte('scheduled_at', zonedToDate(start, '00:00', tz()).toISOString())
      .lt('scheduled_at', zonedToDate(end, '00:00', tz()).toISOString())
      .neq('order_status', 'cancelled').neq('task_status', 'cancelled').order('scheduled_at');
    if (f.person) q = q.eq('assignee_id', f.person);
    if (f.category) q = q.eq('category_id', f.category);
    if (typeSet.length) q = q.in('task_type', typeSet);
    if (f.unassigned) q = q.is('assignee_id', null);
    items = await run(q.limit(2000));
  } catch (err) { setHtml(box, errorState(err)); return; }

  // conflicts: same assignee, driver tasks closer than the configured gap (different orders)
  const gap = (settings().min_minutes_between_tasks ?? 30) * 60000;
  const conflict = new Set();
  const byPerson = {};
  for (const t of items) if (t.assignee_id && t.task_type !== 'washing' && t.task_status !== 'completed') (byPerson[t.assignee_id] ||= []).push(t);
  for (const list of Object.values(byPerson)) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.order_id !== b.order_id && Math.abs(new Date(a.scheduled_at) - new Date(b.scheduled_at)) < gap) { conflict.add(a.task_id); conflict.add(b.task_id); }
    }
  }
  const dayOf = (t) => dateToZonedParts(t.scheduled_at, tz()).date;
  const byDay = {};
  for (const t of items) (byDay[dayOf(t)] ||= []).push(t);

  const item = (t, compact) => html`
    <a href="#/orders/${t.order_id}" class="ev ev-${t.task_type} ${t.task_status === 'completed' ? 'ev-done' : ''} ${conflict.has(t.task_id) ? 'ev-conflict' : ''} ${t.assignee_id ? '' : 'ev-unassigned'}"
      ${t.task_status === 'pending' && !narrow ? raw(`draggable="true" data-drag="${t.task_id}"`) : ''}
      title="${taskLabel(t.task_type, settings())} · ${orderNo(t.order_no)} · ${t.client_name} · ${t.assignee_name || 'Unassigned'}${conflict.has(t.task_id) ? ' · CONFLICT' : ''}">
      ${t.task_type === 'washing' ? '' : html`<span class="ev-time">${fmtTime(t.scheduled_at, tz())}</span>`}
      <span class="ev-text">${compact ? '' : TYPE_SHORT[t.task_type] + ' · '}${t.client_name}${compact ? '' : html` <small>${orderNo(t.order_no)} · ${t.assignee_name || 'Unassigned'}</small>`}</span>
      ${t.task_status === 'completed' ? '✓' : ''}${conflict.has(t.task_id) ? '⚠' : ''}
    </a>`;

  const today = todayInTz(tz());
  if (f.view === 'list' || f.view === 'day') {
    const dayList = Array.from({ length: days }, (_, i) => addDays(start, i)).filter((d) => f.view === 'day' || byDay[d]);
    setHtml(box, dayList.length ? html`<div class="cal-list">${dayList.map((d) => html`
      <section class="card cal-day-block ${d === today ? 'today' : ''}" data-drop="${d}">
        <header><h2>${fmtDate(d)}</h2><a class="btn btn-sm" href="#/orders/new?date=${d}">+ Order</a></header>
        ${(byDay[d] || []).length ? html`<div class="ev-list">${byDay[d].map((t) => item(t, false))}</div>` : emptyState('Nothing scheduled', '')}
      </section>`)}</div>` : emptyState('Nothing scheduled in the next two weeks', 'Use the arrows to look further ahead.'));
  } else {
    const cells = Array.from({ length: days }, (_, i) => addDays(start, i));
    setHtml(box, html`<div class="cal-grid ${f.view}">
      ${WEEKDAYS.map((w) => html`<div class="cal-head">${w}</div>`)}
      ${cells.map((d) => html`<div class="cal-cell ${d === today ? 'today' : ''} ${f.view === 'month' && d.slice(5, 7) !== f.date.slice(5, 7) ? 'other-month' : ''}" data-day="${d}" data-drop="${d}">
        <div class="cal-date"><span>${Number(d.slice(8))}</span><a href="#/orders/new?date=${d}" class="add" aria-label="New order on ${d}">+</a></div>
        ${(byDay[d] || []).slice(0, f.view === 'month' ? 4 : 50).map((t) => item(t, f.view === 'month'))}
        ${f.view === 'month' && (byDay[d] || []).length > 4 ? html`<button class="link-btn" data-go-day="${d}">+${byDay[d].length - 4} more</button>` : ''}
      </div>`)}
    </div>`);
  }
  on(box, 'click', '[data-go-day]', (e, el) => nav({ view: 'day', date: el.dataset.goDay }));

  // ---- drag & drop rescheduling (desktop; pending stages only) ----
  on(box, 'dragstart', '[data-drag]', (e, el) => { e.dataTransfer.setData('text/plain', el.dataset.drag); e.dataTransfer.effectAllowed = 'move'; });
  on(box, 'dragover', '[data-drop]', (e, el) => { e.preventDefault(); el.classList.add('drop-target'); });
  on(box, 'dragleave', '[data-drop]', (e, el) => el.classList.remove('drop-target'));
  on(box, 'drop', '[data-drop]', async (e, el) => {
    e.preventDefault(); el.classList.remove('drop-target');
    const id = e.dataTransfer.getData('text/plain');
    const t = items.find((x) => x.task_id === id);
    const day = el.dataset.drop;
    if (!t || dayOf(t) === day) return;
    const time = dateToZonedParts(t.scheduled_at, tz()).time;
    const ok = await confirmAction({ title: 'Move this stage?',
      message: `Move ${taskLabel(t.task_type, settings())} for ${orderNo(t.order_no)} (${t.client_name}) to ${fmtDate(day)} at the same time? Other stages are not changed.`,
      confirmLabel: 'Move' });
    if (!ok) return;
    try {
      await run(sb.from('order_tasks').update({ scheduled_at: zonedToDate(day, time, tz()).toISOString() }).eq('id', id));
      toast('Moved. The assignee has been notified.');
      nav({});
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) { toast(err.message, 'error'); }
  });
}
