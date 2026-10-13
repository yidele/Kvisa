// Create / edit an order. Every stage is independently assignable.
// Editing never resets status, never clears assignments you didn't change,
// and never touches completed stages (those are corrected from the order page).
import { sb, rpc, run, tz, settings, state, loadPeople, categoryLabel } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, toast, openModal, statusBadge, taskStatusBadge } from '../components/ui.js';
import { personOptions, dtInputs, readDt, showConflicts, roleForTask } from '../components/orderActions.js';
import { clientFormBody, readClientForm, saveClient } from './client.js';
import {
  orderNo, taskLabel, parseBagCount, todayInTz, addDays, fmtDateTime, dateToZonedParts, findPossibleDuplicates,
} from '../lib/format.js';
import { app } from '../lib/app.js';

const ORDER_FIELDS = ['pickup_contact', 'pickup_phone', 'pickup_address', 'return_recipient', 'return_phone',
  'return_address', 'delivery_instructions', 'bag_notes', 'notes', 'expected_return_date'];

export async function render(root, { params, query }) {
  const editing = !!params.id;
  const s = settings();
  let order = null; let tasks = []; let clients = []; let addresses = []; let received = {};

  const load = async () => {
    clients = await run(sb.from('clients').select('*').eq('active', true).order('name'));
    if (editing) {
      [order, tasks] = await Promise.all([
        run(sb.from('orders').select('*').eq('id', params.id).single()),
        run(sb.from('order_tasks').select('*').eq('order_id', params.id).order('seq')),
      ]);
      const ev = await run(sb.from('handoff_effective').select('task_id,event_type,effective_bags,occurred_at').eq('order_id', params.id));
      received = Object.fromEntries(ev.map((e) => [e.event_type, e]));
      if (!clients.find((c) => c.id === order.client_id)) {
        clients.push(await run(sb.from('clients').select('*').eq('id', order.client_id).single()));
      }
    }
  };
  await load();

  const T = (type) => tasks.find((t) => t.task_type === type) || {};
  const done = (type) => T(type).status === 'completed';
  const lock = (type) => (done(type) ? raw('disabled') : '');
  const defaultClient = editing ? order.client_id : query.get('client') || '';
  const defaultDate = query.get('date') || todayInTz(tz());
  const defTime = (s.default_pickup_time || '10:00').slice(0, 5);

  const stageHead = (type) => html`
    <div class="stage-head"><h3>${taskLabel(type, s)}</h3>
      ${editing ? taskStatusBadge(T(type).status) : ''}
      ${done(type) ? html`<small class="muted">Completed ${fmtDateTime(T(type).completed_at, tz())} — locked. Use “Undo step” on the order page to correct it.</small>` : ''}</div>`;

  const dt = (name, type, fallbackDate, fallbackTime) => {
    if (editing) return dtInputs(name, T(type).scheduled_at);
    return html`<span class="dt"><input type="date" name="${name}_date" value="${fallbackDate}"><input type="time" name="${name}_time" value="${fallbackTime}"></span>`;
  };

  const v0 = (k, d = '') => (order && order[k] != null ? order[k] : d);

  setHtml(root, html`
    ${pageHeader(editing ? `Edit ${orderNo(order.order_no)}` : 'New order',
      editing ? html`${statusBadge(order.status)} <a class="btn" href="#/orders/${order.id}">Back to order</a>` : html`<a class="btn" href="#/dispatch">Back</a>`)}
    ${editing && order.recurring_schedule_id ? html`<div class="notice notice-info">
      This order is one occurrence (${order.occurrence_date}) of a recurring schedule. Changes here apply to <strong>this occurrence only</strong>.
      <a href="#/clients/${order.client_id}?series=${order.recurring_schedule_id}">Edit the whole series instead</a></div>` : ''}
    ${editing && order.status === 'cancelled' ? html`<div class="notice notice-warn">This order is cancelled. You can still correct its details.</div>` : ''}
    <form class="order-form" data-order-form novalidate>
      <section class="card form-section">
        <h2>Client and recipient</h2>
        <div class="row">
          <label class="field grow"><span>Client *</span>
            <select name="client_id" required ${editing && tasks.some((t) => t.status !== 'pending') ? raw('disabled') : ''}>
              <option value="">— Choose a client —</option>
              ${clients.map((c) => html`<option value="${c.id}" ${c.id === defaultClient ? raw('selected') : ''}>${c.name}${c.phone ? ' · ' + c.phone : ''}</option>`)}
            </select></label>
          <button type="button" class="btn" data-action="new-client">+ New client</button>
        </div>
        <p class="muted" data-category></p>
        <div class="row">
          <label class="field"><span>Pickup contact</span><input name="pickup_contact" value="${v0('pickup_contact')}"></label>
          <label class="field"><span>Contact phone</span><input name="pickup_phone" type="tel" value="${v0('pickup_phone')}"></label>
        </div>
        <label class="field"><span>Pickup address</span>
          <input name="pickup_address" list="addr-list" value="${v0('pickup_address')}" ${lock('pickup')}></label>
        <div class="row">
          <label class="field"><span>Return recipient</span><input name="return_recipient" value="${v0('return_recipient')}"
            placeholder="Defaults to the client"></label>
          <label class="field"><span>Recipient phone</span><input name="return_phone" type="tel" value="${v0('return_phone')}"></label>
        </div>
        <label class="field"><span>Return delivery address</span>
          <input name="return_address" list="addr-list" value="${v0('return_address')}" ${lock('delivery')} placeholder="Defaults to the client's return address"></label>
        <label class="field"><span>Delivery / access instructions</span><textarea name="delivery_instructions" rows="2">${v0('delivery_instructions')}</textarea></label>
        <datalist id="addr-list"></datalist>
      </section>

      <section class="card form-section">
        <h2>Bags</h2>
        <div class="row">
          <label class="field"><span>Expected bags *</span><input name="expected_bags" type="number" inputmode="numeric" min="0" max="500" step="1" value="${v0('expected_bags', 1)}" required></label>
          <label class="field grow"><span>Bag description / notes</span><input name="bag_notes" value="${v0('bag_notes')}"></label>
        </div>
        ${editing ? html`<dl class="counts">
          <div><dt>At collection</dt><dd>${received.collected_from_client?.effective_bags ?? '—'}</dd></div>
          <div><dt>Delivered to washer</dt><dd>${received.delivered_to_washer?.effective_bags ?? '—'}</dd></div>
          <div><dt>Received by washer</dt><dd>${received.received_by_washer?.effective_bags ?? '—'}</dd></div>
          <div><dt>Returned after washing</dt><dd>${received.wash_completed?.effective_bags ?? '—'}</dd></div>
          <div><dt>Delivered to recipient</dt><dd>${received.delivered_to_recipient?.effective_bags ?? '—'}</dd></div>
        </dl><p class="muted">Actual counts come from recorded handoffs and are never overwritten here.</p>` : ''}
      </section>

      <section class="card form-section">
        ${stageHead('pickup')}
        <div class="row">
          <label class="field"><span>Pickup date & time</span>${dt('pickup', 'pickup', defaultDate, defTime)}</label>
          <label class="field"><span>Driver</span><select name="pickup_driver" data-stage="pickup" ${lock('pickup')}>${personOptions('driver', T('pickup').assignee_id)}</select></label>
        </div>
        <label class="field"><span>Pickup notes</span><input name="pickup_notes" value="${T('pickup').notes || ''}" ${lock('pickup')}></label>
        <div class="stage-sub">
          ${stageHead('dropoff')}
          <div class="row">
            <label class="field"><span>Drop-off date & time</span>${dt('dropoff', 'dropoff', defaultDate, '')}</label>
            <label class="field"><span>Drop-off driver</span><select name="dropoff_driver" data-stage="dropoff" ${lock('dropoff')}>${personOptions('driver', editing ? T('dropoff').assignee_id : null)}</select>
              <small class="hint">Leave unassigned to use the pickup driver.</small></label>
          </div>
          <p class="muted">Destination: the washing volunteer's location (below).</p>
        </div>
      </section>

      <section class="card form-section">
        ${stageHead('washing')}
        <div class="row">
          <label class="field"><span>Washing volunteer</span><select name="washer" data-stage="washing" ${lock('washing')}>${personOptions('washer', T('washing').assignee_id)}</select></label>
          <label class="field"><span>Expected washing date</span>${editing ? dtInputs('washing', T('washing').scheduled_at)
            : html`<span class="dt"><input type="date" name="washing_date" value="${addDays(defaultDate, Number(s.default_wash_days ?? 2))}"><input type="time" name="washing_time" value="${defTime}"></span>`}</label>
        </div>
        <label class="field"><span>Washing location</span><input name="washing_location" value="${T('washing').from_address || ''}" ${lock('washing')}
          placeholder="Defaults to the volunteer's address"></label>
        <label class="field"><span>Special handling instructions</span><textarea name="washing_instructions" rows="2" ${lock('washing')}>${T('washing').instructions || ''}</textarea></label>
        ${editing ? html`<p class="muted">Received: ${fmtDateTime(received.received_by_washer?.occurred_at, tz())} · Washing completed: ${fmtDateTime(T('washing').completed_at, tz())}</p>` : ''}
      </section>

      <section class="card form-section">
        ${stageHead('return_collection')}
        <div class="row">
          <label class="field"><span>Collection date & time</span>${dt('return_collection', 'return_collection', addDays(defaultDate, Number(s.default_return_days ?? 3)), defTime)}</label>
          <label class="field"><span>Return driver</span><select name="return_driver" data-stage="return_collection" ${lock('return_collection')}>${personOptions('driver', T('return_collection').assignee_id)}</select></label>
        </div>
        <label class="field"><span>Collection address</span><input name="collection_address" value="${T('return_collection').from_address || ''}" ${lock('return_collection')}
          placeholder="Defaults to the washing location"></label>
      </section>

      <section class="card form-section">
        ${stageHead('delivery')}
        <div class="row">
          <label class="field"><span>Delivery date & time</span>${dt('delivery', 'delivery', addDays(defaultDate, Number(s.default_return_days ?? 3)), '')}</label>
          <label class="field"><span>Delivery driver</span><select name="delivery_driver" data-stage="delivery" ${lock('delivery')}>${personOptions('driver', editing ? T('delivery').assignee_id : null)}</select>
            <small class="hint">Chosen independently of the other drivers. Leave unassigned to use the return driver.</small></label>
        </div>
        <label class="field"><span>Expected return date</span><input type="date" name="expected_return_date" value="${v0('expected_return_date')}"></label>
        <label class="field"><span>Delivery confirmation notes</span><input name="delivery_notes" value="${T('delivery').notes || ''}" ${lock('delivery')}></label>
        ${editing && done('delivery') ? html`<p class="muted">Delivered ${fmtDateTime(T('delivery').completed_at, tz())}</p>` : ''}
      </section>

      <section class="card form-section">
        <h2>Internal order notes</h2>
        <textarea name="notes" rows="2">${v0('notes')}</textarea>
      </section>

      <div class="form-error notice notice-error" role="alert" hidden></div>
      <div class="sticky-actions">
        <a class="btn" href="${editing ? '#/orders/' + order.id : '#/dispatch'}" data-action="cancel-form">Cancel</a>
        <button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Create order'}</button>
      </div>
    </form>`);

  const form = $('[data-order-form]', root);
  const errBox = $('.form-error', root);

  const fillFromClient = (overwrite) => {
    const c = clients.find((x) => x.id === form.client_id.value);
    $('[data-category]', root).textContent = c ? `Category: ${categoryLabel(c.category_id)} · Client ID C-${String(c.client_no).padStart(4, '0')}` : '';
    if (!c) return;
    const set = (name, val) => { const el = form.elements[name]; if (el && !el.disabled && (overwrite || !el.value)) el.value = val || ''; };
    set('pickup_contact', c.primary_contact || c.name); set('pickup_phone', c.phone);
    set('pickup_address', c.pickup_address);
    set('return_recipient', c.default_return_recipient || c.primary_contact || c.name);
    set('return_phone', c.default_return_phone || c.phone);
    set('return_address', c.default_return_address || c.pickup_address);
    set('delivery_instructions', c.access_instructions);
    run(sb.from('client_addresses').select('label,address').eq('client_id', c.id).eq('active', true)).then((rows) => {
      addresses = rows;
      setHtml($('#addr-list', root), html`${[c.pickup_address, c.default_return_address, ...rows.map((r) => r.address)].filter(Boolean)
        .map((a) => html`<option value="${a}">`)}`);
    }).catch(() => {});
  };
  if (form.client_id.value) fillFromClient(false);
  on(form, 'change', 'select[name=client_id]', () => fillFromClient(true));
  on(form, 'input', 'input, select, textarea', () => app.setDirty(true));
  on(form, 'change', 'select[data-stage], input[type=date], input[type=time]', (e, el) => {
    const v = formValues(form);
    const map = { pickup: ['pickup_driver', 'pickup'], dropoff: ['dropoff_driver', 'dropoff'], washing: ['washer', 'washing'],
      return_collection: ['return_driver', 'return_collection'], delivery: ['delivery_driver', 'delivery'] };
    for (const [type, [sel, dtName]] of Object.entries(map)) {
      const selEl = form.elements[sel];
      if (!selEl || selEl.disabled) continue;
      const wrap = selEl.closest('label');
      showConflicts(wrap, v[sel] || null, readDt(v, dtName) || readDt(v, 'pickup'), editing ? T(type).id : null,
        type === 'washing' ? Number(v.expected_bags) || 0 : null);
    }
  });
  on(root, 'click', '[data-action=cancel-form]', (e) => {
    if (app.dirty && !confirm('Discard your changes?')) { e.preventDefault(); return; }
    app.setDirty(false);
  });
  on(root, 'click', '[data-action=new-client]', async () => {
    const created = await openModal({
      title: 'New client', body: clientFormBody({}, state.categories || []), wide: true, submitLabel: 'Create client',
      async onSubmit(v, f) {
        const data = readClientForm(v);
        const dups = findPossibleDuplicates(data, clients);
        if (dups.length && !f.dataset.dupOk) {
          f.dataset.dupOk = '1';
          throw new Error(`Possible duplicate: ${dups.map((d) => d.name + (d.phone ? ' (' + d.phone + ')' : '')).join(', ')}. Press "Create client" again to create anyway, or cancel and pick the existing client.`);
        }
        return saveClient(null, data, v.internal_notes);
      },
    });
    if (created) {
      clients.push(created);
      clients.sort((a, b) => a.name.localeCompare(b.name));
      const sel = form.client_id;
      sel.insertAdjacentHTML('beforeend', '');
      setHtml(sel, html`<option value="">— Choose a client —</option>${clients.map((c) => html`<option value="${c.id}" ${c.id === created.id ? raw('selected') : ''}>${c.name}${c.phone ? ' · ' + c.phone : ''}</option>`)}`);
      fillFromClient(true);
      toast('Client created.');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const v = formValues(form);
      const bags = parseBagCount(v.expected_bags);
      if (!bags.ok) throw new Error(bags.error);
      const clientId = v.client_id || order?.client_id;
      if (!clientId) throw new Error('Choose a client (or create a new one).');
      const pickupAt = readDt(v, 'pickup');
      if (!editing && !pickupAt) throw new Error('Choose a pickup date.');
      const returnAt = readDt(v, 'return_collection');
      if (pickupAt && returnAt && new Date(returnAt) < new Date(pickupAt)) throw new Error('Return collection cannot be before the pickup.');
      const deliveryAt = readDt(v, 'delivery');
      if (deliveryAt && returnAt && new Date(deliveryAt) < new Date(returnAt)) throw new Error('Final delivery cannot be before the return collection.');

      if (!editing) {
        const id = await rpc('create_order', { p: {
          client_id: clientId, expected_bags: bags.value, bag_notes: v.bag_notes, notes: v.notes,
          pickup_contact: v.pickup_contact, pickup_phone: v.pickup_phone, pickup_address: v.pickup_address,
          return_recipient: v.return_recipient, return_phone: v.return_phone, return_address: v.return_address,
          delivery_instructions: v.delivery_instructions,
          pickup_at: pickupAt, dropoff_at: readDt(v, 'dropoff'),
          expected_wash_date: v.washing_date || null, expected_return_date: v.expected_return_date || (returnAt ? v.return_collection_date : null),
          return_collection_at: returnAt, delivery_at: deliveryAt,
          pickup_driver_id: v.pickup_driver, dropoff_driver_id: v.dropoff_driver, washer_id: v.washer,
          return_driver_id: v.return_driver, delivery_driver_id: v.delivery_driver,
          washing_instructions: v.washing_instructions, pickup_notes: v.pickup_notes,
        } });
        // stage-level overrides not covered by create_order
        const created = await run(sb.from('order_tasks').select('*').eq('order_id', id));
        const ct = (t) => created.find((x) => x.task_type === t);
        if (v.washing_location) {
          await run(sb.from('order_tasks').update({ from_address: v.washing_location, to_address: v.washing_location }).eq('id', ct('washing').id));
          await run(sb.from('order_tasks').update({ to_address: v.washing_location }).eq('id', ct('dropoff').id));
          if (!v.collection_address) await run(sb.from('order_tasks').update({ from_address: v.washing_location }).eq('id', ct('return_collection').id));
        }
        if (v.collection_address) await run(sb.from('order_tasks').update({ from_address: v.collection_address }).eq('id', ct('return_collection').id));
        if (v.delivery_notes) await run(sb.from('order_tasks').update({ notes: v.delivery_notes }).eq('id', ct('delivery').id));
        app.setDirty(false);
        toast('Order created.');
        app.navigate('/orders/' + id);
        return;
      }

      // ---- edit: only send what changed ----
      const orderPatch = {};
      for (const k of ORDER_FIELDS) {
        if (!(k in v)) continue;
        const nv = v[k] === '' ? null : v[k];
        if ((order[k] ?? null) !== nv) orderPatch[k] = nv;
      }
      if (bags.value !== order.expected_bags) orderPatch.expected_bags = bags.value;
      if (v.client_id && v.client_id !== order.client_id) {
        const c = clients.find((x) => x.id === v.client_id);
        orderPatch.client_id = c.id; orderPatch.category_id = c.category_id;
      }
      if (Object.keys(orderPatch).length) await run(sb.from('orders').update(orderPatch).eq('id', order.id));

      const taskPatch = (type, fields) => {
        const t = T(type);
        if (!t.id || t.status === 'completed') return null;
        const patch = {};
        for (const [k, val] of Object.entries(fields)) {
          if (val === undefined) continue;
          const cur = t[k] ?? null;
          const same = k === 'scheduled_at' ? (cur && val && new Date(cur).getTime() === new Date(val).getTime()) || (!cur && !val) : cur === val;
          if (!same) patch[k] = val;
        }
        return Object.keys(patch).length ? [t.id, patch] : null;
      };
      const nul = (x) => (x === '' || x === undefined ? null : x);
      const patches = [
        taskPatch('pickup', { assignee_id: nul(v.pickup_driver), scheduled_at: pickupAt, notes: nul(v.pickup_notes),
          from_address: 'pickup_address' in orderPatch ? nul(v.pickup_address) : undefined }),
        taskPatch('dropoff', { assignee_id: nul(v.dropoff_driver), scheduled_at: readDt(v, 'dropoff'),
          from_address: 'pickup_address' in orderPatch ? nul(v.pickup_address) : undefined }),
        taskPatch('washing', { assignee_id: nul(v.washer), scheduled_at: readDt(v, 'washing'), instructions: nul(v.washing_instructions) }),
        taskPatch('return_collection', { assignee_id: nul(v.return_driver), scheduled_at: returnAt,
          to_address: 'return_address' in orderPatch ? nul(v.return_address) : undefined }),
        taskPatch('delivery', { assignee_id: nul(v.delivery_driver), scheduled_at: deliveryAt, notes: nul(v.delivery_notes),
          to_address: 'return_address' in orderPatch ? nul(v.return_address) : undefined }),
      ].filter(Boolean);
      // assignee changes first (they may move addresses), then the rest
      for (const [id, patch] of patches) {
        if ('assignee_id' in patch) await run(sb.from('order_tasks').update({ assignee_id: patch.assignee_id }).eq('id', id));
      }
      for (const [id, patch] of patches) {
        const { assignee_id, ...rest } = patch;
        if (Object.keys(rest).length) await run(sb.from('order_tasks').update(rest).eq('id', id));
      }
      // explicit washing-location / collection-address overrides
      const w = T('washing');
      if (w.id && w.status !== 'completed' && nul(v.washing_location) && v.washing_location !== w.from_address) {
        await run(sb.from('order_tasks').update({ from_address: v.washing_location, to_address: v.washing_location }).eq('id', w.id));
        if (T('dropoff').status !== 'completed') await run(sb.from('order_tasks').update({ to_address: v.washing_location }).eq('id', T('dropoff').id));
      }
      const rc = T('return_collection');
      if (rc.id && rc.status !== 'completed' && nul(v.collection_address) && v.collection_address !== rc.from_address) {
        await run(sb.from('order_tasks').update({ from_address: v.collection_address }).eq('id', rc.id));
      }
      if (!Object.keys(orderPatch).length && !patches.length) { toast('No changes to save.'); }
      else toast('Changes saved. History has been recorded.');
      app.setDirty(false);
      app.navigate('/orders/' + order.id);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      errBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally {
      btn.disabled = false;
    }
  });

  return () => app.setDirty(false);
}
