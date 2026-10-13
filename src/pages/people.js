// Volunteers (washers) and Drivers. One person can have both roles.
import { sb, run, tz, loadPeople } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, telLink } from '../components/ui.js';
import { WEEKDAYS, personNo, fmtDateTime, todayInTz } from '../lib/format.js';
import { app } from '../lib/app.js';

export async function render(root, { props, query }) {
  const role = props.role; // 'washer' | 'driver'
  const title = role === 'washer' ? 'Washing volunteers' : 'Drivers';
  const show = query.get('show') || 'active';
  const q = (query.get('q') || '').toLowerCase();
  setHtml(root, html`
    ${pageHeader(title, html`<a class="btn btn-primary" href="#/people/new?role=${role}">+ Add ${role === 'washer' ? 'volunteer' : 'driver'}</a>`,
      'A person can be both a driver and a washing volunteer — they have one record with both roles.')}
    <form class="filters card" data-filters>
      <input type="search" name="q" value="${query.get('q') || ''}" placeholder="Search by name or phone" aria-label="Search">
      <select name="show" aria-label="Status">
        <option value="active" ${show === 'active' ? raw('selected') : ''}>Active</option>
        <option value="inactive" ${show === 'inactive' ? raw('selected') : ''}>Inactive</option>
        <option value="all" ${show === 'all' ? raw('selected') : ''}>All</option></select>
      <button class="btn" type="submit">Search</button>
    </form>
    <div data-list>${loading()}</div>`);
  on(root, 'submit', '[data-filters]', (e, form) => {
    e.preventDefault();
    const v = formValues(form); const p = new URLSearchParams();
    if (v.q) p.set('q', v.q); if (v.show !== 'active') p.set('show', v.show);
    app.navigate(`/${role === 'washer' ? 'volunteers' : 'drivers'}${p.toString() ? '?' + p : ''}`);
  });
  on(root, 'change', '[data-filters] select', (e, el) => el.form.requestSubmit());

  const box = $('[data-list]', root);
  try {
    const people = (await loadPeople(true)).filter((p) => p.roles.includes(role)
      && (show === 'all' || (show === 'active' ? p.active : !p.active))
      && (!q || p.full_name.toLowerCase().includes(q) || String(p.phone || '').includes(q)));
    const ids = people.map((p) => p.id);
    const tasks = ids.length ? await run(sb.from('task_calendar').select('assignee_id,task_type,task_status,order_status,scheduled_at,order_id')
      .in('assignee_id', ids).in('task_status', ['pending', 'in_progress']).neq('order_status', 'cancelled')) : [];
    let bagsAt = {};
    if (role === 'washer' && ids.length) {
      const at = await run(sb.from('order_overview').select('washer_id,current_bags')
        .in('washer_id', ids).in('status', ['awaiting_washing', 'washing_in_progress', 'ready_for_return']));
      for (const r of at) bagsAt[r.washer_id] = (bagsAt[r.washer_id] || 0) + (r.current_bags || 0);
    }
    const today = todayInTz(tz());
    if (!people.length) {
      setHtml(box, emptyState(`No ${title.toLowerCase()} found`, '', html`<a class="btn btn-primary" href="#/people/new?role=${role}">Add one</a>`));
      return;
    }
    setHtml(box, html`<div class="table-wrap card"><table class="table">
      <thead><tr><th>ID</th><th>Name</th><th>Contact</th><th>${role === 'washer' ? 'Washing location' : 'Address'}</th>
        <th>Availability</th><th>Open tasks</th>${role === 'washer' ? html`<th>Bags at location</th><th>Max / day</th>` : html`<th>Next task</th>`}<th>Roles</th></tr></thead>
      <tbody>${people.map((p) => {
        const mine = tasks.filter((t) => t.assignee_id === p.id && (role === 'washer' ? t.task_type === 'washing' : t.task_type !== 'washing'));
        const next = mine.filter((t) => t.scheduled_at).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
        const away = p.unavailable_from && today >= p.unavailable_from && today <= (p.unavailable_until || p.unavailable_from);
        return html`<tr class="${p.active ? '' : 'muted'}">
          <td data-label="ID">${personNo(p.person_no)}</td>
          <td data-label="Name"><a href="#/people/${p.id}"><strong>${p.full_name}</strong></a>${p.active ? '' : ' (inactive)'}
            ${away ? html` <span class="badge tone-warn">Unavailable until ${p.unavailable_until || p.unavailable_from}</span>` : ''}</td>
          <td data-label="Contact">${telLink(p.phone)}</td>
          <td data-label="Address">${p.address || '—'}</td>
          <td data-label="Availability">${p.availability || ''} ${(p.preferred_days || []).length ? html`<small class="muted">${p.preferred_days.map((d) => WEEKDAYS[d]).join(', ')}</small>` : ''}</td>
          <td data-label="Open tasks">${mine.length}</td>
          ${role === 'washer' ? html`<td data-label="Bags at location">${bagsAt[p.id] || 0}</td><td data-label="Max / day">${p.max_bags_per_day ?? '—'}</td>`
            : html`<td data-label="Next task">${next ? fmtDateTime(next.scheduled_at, tz()) : '—'}</td>`}
          <td data-label="Roles">${p.roles.map((r) => html`<span class="badge tone-neutral">${r === 'washer' ? 'Volunteer' : 'Driver'}</span> `)}</td>
        </tr>`;
      })}</tbody></table></div>`);
  } catch (err) { setHtml(box, errorState(err)); }
}
