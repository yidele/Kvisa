// Clients list with search by name, phone, address or client ID.
import { sb, run, state, categoryLabel } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, pager, telLink } from '../components/ui.js';
import { clientNo, WEEKDAYS, normalizePhone } from '../lib/format.js';
import { app } from '../lib/app.js';

const PAGE = 50;

export async function render(root, { query }) {
  const f = { q: query.get('q') || '', category: query.get('category') || '', show: query.get('show') || 'active',
    page: Math.max(1, Number(query.get('page') || 1)) };
  const nav = (patch) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...f, ...patch })) if (v && !(k === 'page' && v === 1) && !(k === 'show' && v === 'active')) p.set(k, v);
    app.navigate('/clients' + (p.toString() ? '?' + p : ''));
  };
  setHtml(root, html`
    ${pageHeader('Clients', html`<a class="btn btn-primary" href="#/clients/new">+ Add client</a>`)}
    <form class="filters card" data-filters>
      <input type="search" name="q" value="${f.q}" placeholder="Name, phone, address or C-0001" aria-label="Search clients">
      <select name="category" aria-label="Category"><option value="">All categories</option>
        ${(state.categories || []).map((c) => html`<option value="${c.id}" ${c.id === f.category ? raw('selected') : ''}>${c.label}</option>`)}</select>
      <select name="show" aria-label="Status">
        <option value="active" ${f.show === 'active' ? raw('selected') : ''}>Active</option>
        <option value="inactive" ${f.show === 'inactive' ? raw('selected') : ''}>Inactive</option>
        <option value="all" ${f.show === 'all' ? raw('selected') : ''}>All</option></select>
      <button class="btn" type="submit">Search</button>
      ${f.q || f.category || f.show !== 'active' ? html`<a class="btn btn-ghost" href="#/clients">Clear</a>` : ''}
    </form>
    <div data-list>${loading()}</div>`);
  on(root, 'submit', '[data-filters]', (e, form) => { e.preventDefault(); nav({ ...formValues(form), page: 1 }); });
  on(root, 'change', '[data-filters] select', (e, el) => el.form.requestSubmit());
  on(root, 'click', '[data-action=page]', (e, el) => nav({ page: Number(el.dataset.page) }));

  const box = $('[data-list]', root);
  try {
    let q = sb.from('clients').select('*', { count: 'exact' });
    if (f.show === 'active') q = q.eq('active', true);
    if (f.show === 'inactive') q = q.eq('active', false);
    if (f.category) q = q.eq('category_id', f.category);
    if (f.q) {
      const term = f.q.trim();
      const idm = term.match(/^c-?0*(\d+)$/i);
      const digits = normalizePhone(term);
      if (idm) q = q.eq('client_no', Number(idm[1]));
      else {
        const like = `%${term.replace(/[%,()]/g, ' ')}%`;
        const ors = [`name.ilike.${like}`, `pickup_address.ilike.${like}`, `default_return_address.ilike.${like}`, `primary_contact.ilike.${like}`];
        if (digits.length >= 3) ors.push(`phone.ilike.%${digits.slice(-4)}%`);
        q = q.or(ors.join(','));
      }
    }
    q = q.order('name').range((f.page - 1) * PAGE, f.page * PAGE - 1);
    const { data, count } = await run(q);
    if (!data.length) {
      setHtml(box, emptyState(f.q ? 'No clients match' : 'No clients yet', f.q ? 'Try a different search.' : 'Add your first client.',
        html`<a class="btn btn-primary" href="#/clients/new">Add client</a>`));
      return;
    }
    setHtml(box, html`<div class="table-wrap card"><table class="table">
      <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Contact</th><th>Pickup address</th><th>Days</th><th></th></tr></thead>
      <tbody>${data.map((c) => html`<tr class="${c.active ? '' : 'muted'}">
        <td data-label="ID">${clientNo(c.client_no)}</td>
        <td data-label="Name"><a href="#/clients/${c.id}"><strong>${c.name}</strong></a>${c.active ? '' : ' (inactive)'}</td>
        <td data-label="Category">${categoryLabel(c.category_id)}</td>
        <td data-label="Contact">${c.primary_contact || ''} ${telLink(c.phone)}</td>
        <td data-label="Address">${c.pickup_address || '—'}</td>
        <td data-label="Days">${(c.preferred_days || []).map((d) => WEEKDAYS[d]).join(', ')}</td>
        <td class="actions"><a class="btn btn-sm" href="#/orders/new?client=${c.id}">New order</a></td>
      </tr>`)}</tbody></table></div>${pager(f.page, PAGE, count)}`);
  } catch (err) { setHtml(box, errorState(err)); }
}
