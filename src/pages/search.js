// Global search across orders, clients and people (staff only).
import { sb, run, state, categoryLabel } from '../lib/api.js';
import { html, setHtml } from '../lib/dom.js';
import { pageHeader, emptyState, statusBadge, errorState } from '../components/ui.js';
import { orderNo, clientNo, personNo, normalizePhone } from '../lib/format.js';

export async function render(root, { query }) {
  const q = (query.get('q') || '').trim();
  const input = document.querySelector('.global-search input');
  if (input) input.value = q;
  if (!q) { setHtml(root, emptyState('Type something to search', 'Order numbers, client names, phone numbers, addresses or people.')); return; }
  try {
    const like = `%${q.replace(/[%,()]/g, ' ')}%`;
    const num = Number(q.replace(/^[kKcCpP]-?/, ''));
    const digits = normalizePhone(q);
    const clientOr = [`name.ilike.${like}`, `pickup_address.ilike.${like}`, `primary_contact.ilike.${like}`];
    if (digits.length >= 3) clientOr.push(`phone.ilike.%${digits.slice(-4)}%`);
    if (/^c-?\d+$/i.test(q)) clientOr.push(`client_no.eq.${num}`);
    const [orders, clients] = await Promise.all([
      Number.isInteger(num) && num > 0 && /^(k-?)?\d+$/i.test(q)
        ? run(sb.from('order_overview').select('id,order_no,client_name,status').eq('order_no', num))
        : run(sb.from('order_overview').select('id,order_no,client_name,status').ilike('client_name', like).order('order_no', { ascending: false }).limit(20)),
      run(sb.from('clients').select('id,client_no,name,phone,category_id,active').or(clientOr.join(',')).limit(30)),
    ]);
    const ql = q.toLowerCase();
    const people = (state.people || []).filter((p) => p.full_name.toLowerCase().includes(ql)
      || (digits.length >= 3 && normalizePhone(p.phone).includes(digits)) || (/^p-?\d+$/i.test(q) && p.person_no === num));
    setHtml(root, html`
      ${pageHeader(`Search: “${q}”`)}
      <div class="grid-2">
        <section class="card"><h2>Orders</h2>${orders.length ? html`<ul class="list">${orders.map((o) => html`
          <li><a class="row-link" href="#/orders/${o.id}"><span>${orderNo(o.order_no)} · ${o.client_name}</span>${statusBadge(o.status)}</a></li>`)}</ul>` : emptyState('No orders', '')}</section>
        <section class="card"><h2>Clients</h2>${clients.length ? html`<ul class="list">${clients.map((c) => html`
          <li><a class="row-link" href="#/clients/${c.id}"><span>${c.name} <small class="muted">${clientNo(c.client_no)} · ${categoryLabel(c.category_id)}${c.active ? '' : ' · inactive'}</small></span><small>${c.phone || ''}</small></a></li>`)}</ul>` : emptyState('No clients', '')}</section>
        <section class="card"><h2>Drivers & volunteers</h2>${people.length ? html`<ul class="list">${people.map((p) => html`
          <li><a class="row-link" href="#/people/${p.id}"><span>${p.full_name} <small class="muted">${personNo(p.person_no)} · ${p.roles.join(', ')}</small></span><small>${p.phone || ''}</small></a></li>`)}</ul>` : emptyState('No people', '')}</section>
      </div>`);
  } catch (err) { setHtml(root, errorState(err)); }
}
