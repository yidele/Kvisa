// Client profile: details, internal notes, addresses, recurring schedules, order history.
import { sb, rpc, run, tz, settings, state, categoryLabel, loadCategories } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import {
  pageHeader, loading, errorState, emptyState, toast, openModal, confirmAction, statusBadge, telLink,
} from '../components/ui.js';
import { personOptions } from '../components/orderActions.js';
import {
  WEEKDAYS, WEEKDAYS_LONG, orderNo, clientNo, fmtDateTime, fmtDate, findPossibleDuplicates, parseBagCount, todayInTz,
} from '../lib/format.js';
import { app } from '../lib/app.js';

// ---------- shared client form (also used from the order form) ----------
export function clientFormBody(c, cats) {
  const days = c.preferred_days || [];
  return html`
    <div class="row">
      <label class="field grow"><span>Name or household name *</span><input name="name" value="${c.name || ''}" required></label>
      <label class="field"><span>Category *</span><select name="category_id" required>
        ${cats.filter((x) => x.active || x.id === c.category_id).map((x) => html`<option value="${x.id}" ${x.id === (c.category_id || cats[0]?.id) ? raw('selected') : ''}>${x.label}</option>`)}</select></label>
    </div>
    <div class="row">
      <label class="field"><span>Primary contact</span><input name="primary_contact" value="${c.primary_contact || ''}"></label>
      <label class="field"><span>Phone</span><input name="phone" type="tel" value="${c.phone || ''}"></label>
      <label class="field"><span>Phone in Israel</span><input name="israel_phone" type="tel" value="${c.israel_phone || ''}"></label>
      <label class="field"><span>Email (optional)</span><input name="email" type="email" value="${c.email || ''}"></label>
    </div>
    <label class="field"><span>Pickup address</span><input name="pickup_address" value="${c.pickup_address || ''}"></label>
    <div class="row">
      <label class="field"><span>Default return recipient</span><input name="default_return_recipient" value="${c.default_return_recipient || ''}" placeholder="Same as client"></label>
      <label class="field"><span>Recipient phone</span><input name="default_return_phone" type="tel" value="${c.default_return_phone || ''}"></label>
    </div>
    <label class="field"><span>Default return address</span><input name="default_return_address" value="${c.default_return_address || ''}" placeholder="Same as pickup address"></label>
    <label class="field"><span>Delivery & access instructions</span><textarea name="access_instructions" rows="2">${c.access_instructions || ''}</textarea></label>
    <fieldset class="field"><legend>Preferred service days</legend><div class="chips">
      ${WEEKDAYS.map((d, i) => html`<label class="chip"><input type="checkbox" name="preferred_days" value="${i}" ${days.includes(i) ? raw('checked') : ''}><span>${d}</span></label>`)}
    </div></fieldset>
    <label class="field"><span>Internal notes (staff only — never shown to drivers or volunteers)</span>
      <textarea name="internal_notes" rows="2">${c._internal_notes || ''}</textarea></label>
    ${c.id ? html`<label class="check"><input type="checkbox" name="active" ${c.active !== false ? raw('checked') : ''}> Active</label>` : ''}`;
}

export function readClientForm(v) {
  if (!v.name || !v.name.trim()) throw new Error('Enter the client name.');
  if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) throw new Error('The email address does not look right.');
  const n = (x) => (x && String(x).trim() !== '' ? String(x).trim() : null);
  const out = {
    name: v.name.trim(), category_id: v.category_id, primary_contact: n(v.primary_contact), phone: n(v.phone), israel_phone: n(v.israel_phone), email: n(v.email),
    pickup_address: n(v.pickup_address), default_return_recipient: n(v.default_return_recipient),
    default_return_phone: n(v.default_return_phone), default_return_address: n(v.default_return_address),
    access_instructions: n(v.access_instructions),
    preferred_days: (v.preferred_days || []).map(Number),
  };
  if ('active' in v) out.active = !!v.active;
  return out;
}

export async function saveClient(id, data, internalNotes) {
  let row;
  if (id) row = await run(sb.from('clients').update(data).eq('id', id).select().single());
  else row = await run(sb.from('clients').insert(data).select().single());
  if (internalNotes !== undefined) {
    await run(sb.from('client_internal_notes').upsert({ client_id: row.id, notes: internalNotes || null }));
  }
  return row;
}

// ---------- recurring schedule form ----------
function seriesForm(rs, client) {
  const s = settings();
  const days = rs.weekdays || client.preferred_days || [];
  return html`
    <fieldset class="field"><legend>Repeats on *</legend><div class="chips">
      ${WEEKDAYS.map((d, i) => html`<label class="chip"><input type="checkbox" name="weekdays" value="${i}" ${days.includes(i) ? raw('checked') : ''}><span>${d}</span></label>`)}
    </div></fieldset>
    <div class="row">
      <label class="field"><span>Pickup time</span><input type="time" name="pickup_time" value="${(rs.pickup_time || s.default_pickup_time || '10:00').slice(0, 5)}"></label>
      <label class="field"><span>Expected bags</span><input type="number" name="expected_bags" min="0" step="1" value="${rs.expected_bags ?? 1}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Start date *</span><input type="date" name="start_date" value="${rs.start_date || todayInTz(tz())}" required></label>
      <label class="field"><span>End date (optional)</span><input type="date" name="end_date" value="${rs.end_date || ''}"></label>
    </div>
    <label class="field"><span>Pickup address</span><input name="pickup_address" value="${rs.pickup_address || ''}" placeholder="${client.pickup_address || ''}"></label>
    <div class="row">
      <label class="field"><span>Return recipient</span><input name="return_recipient" value="${rs.return_recipient || ''}" placeholder="${client.default_return_recipient || client.name}"></label>
      <label class="field"><span>Return address</span><input name="return_address" value="${rs.return_address || ''}" placeholder="${client.default_return_address || client.pickup_address || ''}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Default pickup driver</span><select name="default_pickup_driver_id">${personOptions('driver', rs.default_pickup_driver_id)}</select></label>
      <label class="field"><span>Default washer</span><select name="default_washer_id">${personOptions('washer', rs.default_washer_id)}</select></label>
      <label class="field"><span>Default delivery driver</span><select name="default_delivery_driver_id">${personOptions('driver', rs.default_delivery_driver_id)}</select></label>
    </div>
    <label class="field"><span>Notes</span><input name="notes" value="${rs.notes || ''}"></label>
    <p class="muted">Orders are created automatically for the next ${s.planning_window_days || 28} days only.</p>`;
}

function readSeries(v) {
  const weekdays = (v.weekdays || []).map(Number);
  if (!weekdays.length) throw new Error('Choose at least one weekday.');
  if (!v.start_date) throw new Error('Choose a start date.');
  if (v.end_date && v.end_date < v.start_date) throw new Error('The end date is before the start date.');
  const b = parseBagCount(v.expected_bags); if (!b.ok) throw new Error(b.error);
  const n = (x) => (x ? x : null);
  return {
    weekdays, pickup_time: v.pickup_time || null, start_date: v.start_date, end_date: n(v.end_date), expected_bags: b.value,
    pickup_address: n(v.pickup_address), return_recipient: n(v.return_recipient), return_address: n(v.return_address),
    default_pickup_driver_id: n(v.default_pickup_driver_id), default_washer_id: n(v.default_washer_id),
    default_delivery_driver_id: n(v.default_delivery_driver_id), notes: n(v.notes),
  };
}

export async function render(root, { params, query }) {
  const isNew = params.id === 'new';
  const cats = await loadCategories();

  if (isNew) {
    const all = await run(sb.from('clients').select('id,name,phone,pickup_address').order('name'));
    setHtml(root, html`${pageHeader('New client', html`<a class="btn" href="#/clients">Back</a>`)}
      <form class="card form-section" data-client-form novalidate>${clientFormBody({}, cats)}
        <div class="notice notice-warn" data-dups hidden></div>
        <div class="form-error notice notice-error" role="alert" hidden></div>
        <div class="sticky-actions"><a class="btn" href="#/clients" data-cancel>Cancel</a><button class="btn btn-primary" type="submit">Create client</button></div>
      </form>`);
    const form = $('[data-client-form]', root);
    let dupConfirmed = false;
    on(form, 'input', 'input,textarea,select', () => { app.setDirty(true); dupConfirmed = false; });
    on(form, 'change', 'select[name=category_id]', (e, el) => {
      const c = cats.find((x) => x.id === el.value);
      if (c?.default_pickup_address && !form.pickup_address.value) form.pickup_address.value = c.default_pickup_address;
      if (c?.default_pickup_note && !form.access_instructions.value) form.access_instructions.value = c.default_pickup_note;
    });
    on(root, 'click', '[data-cancel]', (e) => { if (app.dirty && !confirm('Discard this new client?')) e.preventDefault(); else app.setDirty(false); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form); err.hidden = true;
      try {
        const v = formValues(form);
        const data = readClientForm(v);
        const dups = findPossibleDuplicates(data, all);
        const box = $('[data-dups]', form);
        if (dups.length && !dupConfirmed) {
          setHtml(box, html`<strong>Possible duplicate:</strong> ${dups.map((d, i) => html`${i ? ', ' : ''}<a href="#/clients/${d.id}">${d.name}</a>${d.phone ? ' (' + d.phone + ')' : ''}`)}.
            If this really is a different client, press “Create client” again.`);
          box.hidden = false; dupConfirmed = true; return;
        }
        const row = await saveClient(null, data, v.internal_notes);
        app.setDirty(false);
        toast('Client created.');
        app.navigate('/clients/' + row.id);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return () => app.setDirty(false);
  }

  const id = params.id;
  async function draw() {
    const [c, notes, addrs, series, orders] = await Promise.all([
      run(sb.from('clients').select('*').eq('id', id).maybeSingle()),
      run(sb.from('client_internal_notes').select('notes').eq('client_id', id).maybeSingle()),
      run(sb.from('client_addresses').select('*').eq('client_id', id).order('created_at')),
      run(sb.from('recurring_schedules').select('*').eq('client_id', id).order('created_at')),
      run(sb.from('order_overview').select('id,order_no,status,pickup_at,current_bags,expected_bags,completed_at,recurring_schedule_id,occurrence_date').eq('client_id', id).order('pickup_at', { ascending: false }).limit(200)),
    ]);
    const orderIds = orders.map((o) => o.id);
    const delivered = orderIds.length ? await run(sb.from('handoff_effective').select('effective_bags,order_id')
      .eq('event_type', 'delivered_to_recipient').in('order_id', orderIds)) : [];
    if (!c) throw new Error('Client not found.');
    c._internal_notes = notes?.notes || '';
    const outstanding = orders.filter((o) => !['completed', 'cancelled'].includes(o.status));
    const totalBags = delivered.reduce((a, r) => a + (r.effective_bags || 0), 0);
    const focusSeries = query.get('series');

    setHtml(root, html`
      ${pageHeader(html`${c.name} <small class="muted">${clientNo(c.client_no)}</small>`, html`
        <a class="btn btn-primary" href="#/orders/new?client=${c.id}">+ New order</a>
        <button class="btn" data-act="edit">Edit client</button>`,
        `${categoryLabel(c.category_id)}${c.active ? '' : ' · INACTIVE'}`)}
      <div class="stats small">
        <div class="stat"><span class="stat-value">${totalBags}</span><span class="stat-label">Bags delivered back (all time)</span></div>
        <div class="stat"><span class="stat-value">${outstanding.length}</span><span class="stat-label">Outstanding orders</span></div>
        <div class="stat"><span class="stat-value">${orders.length}</span><span class="stat-label">Orders</span></div>
      </div>
      <div class="grid-2">
        <section class="card"><h2>Details</h2>
          <dl class="kv">
            <div><dt>Primary contact</dt><dd>${c.primary_contact || '—'} ${telLink(c.phone)}</dd></div>
            ${c.israel_phone ? html`<div><dt>Phone in Israel</dt><dd>${telLink(c.israel_phone)}</dd></div>` : ''}
            ${c.email ? html`<div><dt>Email</dt><dd><a href="mailto:${c.email}">${c.email}</a></dd></div>` : ''}
            <div><dt>Pickup address</dt><dd>${c.pickup_address || '—'}</dd></div>
            <div><dt>Return to</dt><dd>${c.default_return_recipient || 'Client'} — ${c.default_return_address || 'same address'} ${telLink(c.default_return_phone)}</dd></div>
            <div><dt>Instructions</dt><dd>${c.access_instructions || '—'}</dd></div>
            <div><dt>Preferred days</dt><dd>${(c.preferred_days || []).map((d) => WEEKDAYS[d]).join(', ') || '—'}</dd></div>
            <div><dt>Internal notes</dt><dd class="pre">${c._internal_notes || '—'}</dd></div>
          </dl>
        </section>
        <section class="card"><h2>Other addresses</h2>
          ${addrs.length ? html`<ul class="list">${addrs.map((a) => html`<li class="${a.active ? '' : 'muted'}">
            <span><strong>${a.label}</strong>: ${a.address}${a.instructions ? html`<br><small>${a.instructions}</small>` : ''}${a.active ? '' : ' (inactive)'}</span>
            <button class="btn btn-sm" data-act="addr" data-id="${a.id}">Edit</button></li>`)}</ul>` : emptyState('No other addresses', 'Add work, relative or alternate delivery addresses.')}
          <button class="btn btn-sm" data-act="addr">+ Add address</button>
        </section>
      </div>
      <section class="card" id="series"><h2>Recurring schedules</h2>
        ${series.length ? html`<ul class="list">${series.map((rs) => html`<li class="${rs.id === focusSeries ? 'highlight' : ''}">
          <span><strong>Every ${rs.weekdays.map((d) => WEEKDAYS_LONG[d]).join(' & ')}</strong> at ${rs.pickup_time.slice(0, 5)} · ${rs.expected_bags} bag(s)
            <br><small class="muted">From ${fmtDate(rs.start_date)}${rs.end_date ? ' to ' + fmtDate(rs.end_date) : ' (no end date)'} · ${rs.status}</small></span>
          <span class="btn-group">
            <button class="btn btn-sm" data-act="series" data-id="${rs.id}">Edit series</button>
            ${rs.status === 'active' ? html`<button class="btn btn-sm" data-act="series-status" data-id="${rs.id}" data-status="paused">Pause</button>`
              : rs.status === 'paused' ? html`<button class="btn btn-sm" data-act="series-status" data-id="${rs.id}" data-status="active">Resume</button>` : ''}
            ${rs.status !== 'cancelled' ? html`<button class="btn btn-sm btn-danger-ghost" data-act="series-status" data-id="${rs.id}" data-status="cancelled">End series</button>` : ''}
          </span></li>`)}</ul>` : emptyState('No recurring schedule', 'Set one up for clients with regular pickups (e.g. every Sunday).')}
        <button class="btn btn-sm" data-act="series">+ Add recurring schedule</button>
      </section>
      <section class="card"><h2>Order history</h2>
        ${orders.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Order</th><th>Pickup</th><th>Status</th><th>Bags</th><th></th></tr></thead>
          <tbody>${orders.map((o) => html`<tr><td data-label="Order"><a href="#/orders/${o.id}">${orderNo(o.order_no)}</a>${o.recurring_schedule_id ? ' ↻' : ''}</td>
            <td data-label="Pickup">${fmtDateTime(o.pickup_at, tz())}</td><td data-label="Status">${statusBadge(o.status)}</td>
            <td data-label="Bags">${o.current_bags}</td><td><a class="btn btn-sm" href="#/orders/${o.id}/edit">Edit</a></td></tr>`)}</tbody></table></div>`
          : emptyState('No orders yet', '', html`<a class="btn btn-primary" href="#/orders/new?client=${c.id}">Create first order</a>`)}
      </section>`);
    root._client = c; root._series = series; root._addrs = addrs;
    if (focusSeries) $('#series', root)?.scrollIntoView({ behavior: 'smooth' });
  }

  on(root, 'click', '[data-action=reload]', () => draw().catch((e) => setHtml(root, errorState(e))));
  on(root, 'click', '[data-act]', async (e, el) => {
    const c = root._client;
    try {
      let changed;
      if (el.dataset.act === 'edit') {
        const all = await run(sb.from('clients').select('id,name,phone,pickup_address'));
        changed = await openModal({
          title: 'Edit client', wide: true, body: html`${clientFormBody(c, cats)}
            <p class="muted">Changing addresses here does not change addresses on stages that are already completed.</p>`,
          async onSubmit(v, form) {
            const data = readClientForm(v);
            const dups = findPossibleDuplicates({ ...data, id: c.id }, all);
            if (dups.length && !form.dataset.dupOk) {
              form.dataset.dupOk = '1';
              throw new Error(`Looks similar to: ${dups.map((d) => d.name).join(', ')}. Save again to keep these details.`);
            }
            await saveClient(c.id, data, v.internal_notes);
            toast('Client saved.'); return true;
          },
        });
      } else if (el.dataset.act === 'addr') {
        const a = root._addrs.find((x) => x.id === el.dataset.id) || { active: true };
        changed = await openModal({
          title: a.id ? 'Edit address' : 'Add address',
          body: html`<label class="field"><span>Label</span><input name="label" value="${a.label || ''}" placeholder="e.g. Daughter's home"></label>
            <label class="field"><span>Address *</span><input name="address" value="${a.address || ''}" required></label>
            <label class="field"><span>Instructions</span><input name="instructions" value="${a.instructions || ''}"></label>
            ${a.id ? html`<label class="check"><input type="checkbox" name="active" ${a.active ? raw('checked') : ''}> Active</label>` : ''}`,
          async onSubmit(v) {
            if (!v.address.trim()) throw new Error('Enter the address.');
            const row = { label: v.label.trim() || 'Other', address: v.address.trim(), instructions: v.instructions || null };
            if (a.id) await run(sb.from('client_addresses').update({ ...row, active: !!v.active }).eq('id', a.id));
            else await run(sb.from('client_addresses').insert({ ...row, client_id: c.id }));
            return true;
          },
        });
      } else if (el.dataset.act === 'series') {
        const rs = root._series.find((x) => x.id === el.dataset.id) || {};
        changed = await openModal({
          title: rs.id ? 'Edit recurring series' : 'New recurring schedule', wide: true,
          body: html`${seriesForm(rs, c)}${rs.id ? html`
            <fieldset class="field"><legend>Apply to</legend>
              <label class="check"><input type="radio" name="apply" value="future" checked> This series <strong>and</strong> its future occurrences that haven't been edited individually or started</label>
              <label class="check"><input type="radio" name="apply" value="series"> Only the series rule (already-created orders stay as they are)</label>
            </fieldset>
            <p class="muted">To change a single date, open that order and edit it — that changes only that occurrence.</p>` : ''}`,
          async onSubmit(v) {
            const data = readSeries(v);
            if (rs.id) {
              const res = await rpc('update_recurring_series', { p_schedule_id: rs.id, p: { ...data, weekdays: data.weekdays }, p_apply_to_future: v.apply === 'future' });
              toast(`Series saved. ${res.updated} future order(s) updated, ${res.cancelled} removed, ${res.generated} created.`);
            } else {
              const row = await run(sb.from('recurring_schedules').insert({ ...data, client_id: c.id }).select().single());
              const n = await rpc('generate_recurring_orders', { p_schedule_id: row.id });
              toast(`Recurring schedule created. ${n} order(s) scheduled in the planning window.`);
            }
            return true;
          },
        });
      } else if (el.dataset.act === 'series-status') {
        const st = el.dataset.status;
        const r = await confirmAction({
          title: st === 'active' ? 'Resume series?' : st === 'paused' ? 'Pause series?' : 'End series?',
          message: st === 'active' ? 'Orders will be created again within the planning window.'
            : 'Future orders from this series that have not started (and were not edited individually) will be cancelled. History is kept.',
          confirmLabel: st === 'active' ? 'Resume' : st === 'paused' ? 'Pause' : 'End series', danger: st === 'cancelled',
          reasonLabel: st === 'active' ? null : 'Reason',
        });
        if (r) { await rpc('set_series_status', { p_schedule_id: el.dataset.id, p_status: st, p_cancel_future: true, p_reason: r.reason || null }); toast('Series updated.'); changed = true; }
      }
      if (changed) await draw();
    } catch (err) { toast(err.message, 'error'); }
  });

  try { await draw(); } catch (err) { setHtml(root, errorState(err)); }
}
