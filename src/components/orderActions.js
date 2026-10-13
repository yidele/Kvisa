// Order actions shared by the Dispatcher table, order page and calendar.
import { sb, rpc, run, tz, settings, peopleWithRole, personName, state } from '../lib/api.js';
import { html, raw, setHtml, $, $$, on } from '../lib/dom.js';
import { openModal, confirmAction, toast } from './ui.js';
import {
  taskLabel, orderNo, dateToZonedParts, zonedToDate, nextActions, parseBagCount, fmtDateTime, EVENT_LABELS,
  DISPATCH_LABELS, DISPATCH_TONE, dispatchButtonLabel,
} from '../lib/format.js';

export function roleForTask(type) { return type === 'washing' ? 'washer' : 'driver'; }

export function personOptions(role, selectedId) {
  const list = peopleWithRole(role);
  const sel = selectedId && !list.find((p) => p.id === selectedId) ? (state.people || []).find((p) => p.id === selectedId) : null;
  return html`<option value="">— Unassigned —</option>
    ${sel ? html`<option value="${sel.id}" selected>${sel.full_name} (inactive)</option>` : ''}
    ${list.map((p) => html`<option value="${p.id}" ${p.id === selectedId ? raw('selected') : ''}>${p.full_name}</option>`)}`;
}

export function dtInputs(name, value) {
  const p = dateToZonedParts(value, tz());
  return html`<span class="dt"><input type="date" name="${name}_date" value="${p.date}" aria-label="Date">
    <input type="time" name="${name}_time" value="${p.time}" aria-label="Time"></span>`;
}

export function readDt(values, name) {
  const d = values[`${name}_date`]; const t = values[`${name}_time`];
  if (!d) return null;
  return zonedToDate(d, t || '00:00', tz()).toISOString();
}

// Shows assignment conflict warnings under a select as the dispatcher changes it.
export async function showConflicts(container, personId, atIso, excludeTaskId, bags) {
  const box = container.querySelector('.conflicts') || container.appendChild(Object.assign(document.createElement('div'), { className: 'conflicts' }));
  if (!personId || !atIso) { box.innerHTML = ''; return; }
  try {
    const rows = await rpc('assignment_conflicts', { p_person: personId, p_at: atIso, p_exclude_task: excludeTaskId || null, p_bags: bags ?? null });
    setHtml(box, rows.length ? html`<div class="notice notice-warn">${rows.map((r) => html`<div>⚠ ${r.message}</div>`)}</div>` : '');
  } catch { box.innerHTML = ''; }
}

export async function loadTasks(orderId) {
  return run(sb.from('order_tasks').select('*').eq('order_id', orderId).order('seq'));
}

// ---------------------------------------------------------------- assign / reassign
export async function assignModal(orderId, onlyType) {
  const [order, tasks] = await Promise.all([
    run(sb.from('orders').select('id,order_no,status,expected_bags').eq('id', orderId).single()),
    loadTasks(orderId),
  ]);
  const editable = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled' && (!onlyType || t.task_type === onlyType));
  if (!editable.length) { toast('All stages of this order are already done.', 'warn'); return null; }
  const body = html`
    <p class="muted">Each stage is assigned independently. Only stages you change are saved.</p>
    ${editable.map((t) => html`
      <fieldset class="stage-edit" data-task="${t.id}" data-type="${t.task_type}">
        <legend>${taskLabel(t.task_type, settings())}</legend>
        <div class="row">
          <label class="field"><span>${t.task_type === 'washing' ? 'Washing volunteer' : 'Driver'}</span>
            <select name="a_${t.id}" data-assignee>${personOptions(roleForTask(t.task_type), t.assignee_id)}</select></label>
          <label class="field"><span>${t.task_type === 'washing' ? 'Expected washing date' : 'Date & time'}</span>${dtInputs('s_' + t.id, t.scheduled_at)}</label>
        </div>
      </fieldset>`)}
    <label class="field"><span>Reason / note (optional, saved in history)</span><input name="reason"></label>`;
  return openModal({
    title: `Assign — ${orderNo(order.order_no)}`, body, wide: true, submitLabel: 'Save assignments',
    onMount(form) {
      on(form, 'change', 'select[data-assignee], input[type=date], input[type=time]', (e, el) => {
        const fs = el.closest('fieldset');
        const v = Object.fromEntries(new FormData(form));
        const id = fs.dataset.task;
        showConflicts(fs, v['a_' + id], readDt(v, 's_' + id), id, fs.dataset.type === 'washing' ? order.expected_bags : null);
      });
    },
    async onSubmit(v) {
      let changed = 0;
      for (const t of editable) {
        const assignee = v['a_' + t.id] || null;
        const when = readDt(v, 's_' + t.id);
        const patch = {};
        if (assignee !== (t.assignee_id || null)) patch.assignee_id = assignee;
        if (when !== null && new Date(when).getTime() !== new Date(t.scheduled_at || 0).getTime()) patch.scheduled_at = when;
        if (Object.keys(patch).length) {
          await run(sb.from('order_tasks').update(patch).eq('id', t.id));
          changed++;
        }
      }
      if (!changed) throw new Error('Nothing was changed.');
      toast(`Saved ${changed} change(s).`);
      return true;
    },
  });
}

// ---------------------------------------------------------------- record a handoff
export async function recordModal(task, { orderNoValue, washingReceived, currentBags, preferEvent } = {}) {
  const actions = nextActions(task.task_type, task.status, washingReceived);
  if (!actions.length) { toast('This stage is already done.', 'warn'); return null; }
  const now = dateToZonedParts(new Date(), tz());
  const body = html`
    <label class="field"><span>What happened?</span>
      <select name="event" data-event>${actions.map((a, i) => html`<option value="${a.event}" data-count="${a.count ? 1 : 0}" ${(preferEvent ? a.event === preferEvent : i === actions.length - 1) ? raw('selected') : ''}>${a.label}</option>`)}</select></label>
    <label class="field" data-count-field><span>Number of bags</span>
      <input name="bags" type="number" inputmode="numeric" min="0" max="500" step="1" value="${currentBags ?? ''}" required>
      <small class="hint">Expected: ${currentBags ?? '—'}. If the count is different, an exception is opened for the dispatcher.</small></label>
    <label class="field"><span>When</span><span class="dt">
      <input type="date" name="when_date" value="${now.date}"><input type="time" name="when_time" value="${now.time}"></span></label>
    <label class="field"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>`;
  return openModal({
    title: `${taskLabel(task.task_type, settings())}${orderNoValue ? ' — ' + orderNo(orderNoValue) : ''}`,
    body, submitLabel: 'Record',
    onMount(form) {
      const sync = () => {
        const opt = form.event.selectedOptions[0];
        const needs = opt && opt.dataset.count === '1';
        $('[data-count-field]', form).hidden = !needs;
        form.bags.disabled = !needs;
      };
      form.event.addEventListener('change', sync); sync();
    },
    async onSubmit(v) {
      const action = actions.find((a) => a.event === v.event);
      let bags = null;
      if (action.count) {
        const p = parseBagCount(v.bags);
        if (!p.ok) throw new Error(p.error);
        bags = p.value;
      }
      const when = readDt(v, 'when');
      const res = await rpc('record_handoff', {
        p_task_id: task.id, p_event: v.event, p_actual_bags: bags, p_notes: v.notes || null, p_occurred_at: when,
      });
      if (res.exception_id) toast('Recorded. The bag count differs from what was expected, so the dispatcher has been alerted.', 'warn');
      else toast(EVENT_LABELS[v.event] ? `${EVENT_LABELS[v.event]} — saved.` : 'Saved.');
      return res;
    },
  });
}

// ---------------------------------------------------------------- report a problem
export async function problemModal(task, orderNoValue) {
  const body = html`
    <label class="field"><span>Problem</span><select name="kind">
      ${task.task_type === 'pickup' ? html`<option value="failed_pickup">Pickup failed (no one home / bags not ready)</option>` : ''}
      <option value="missing_bags">Bags missing or unaccounted for</option>
      <option value="delay">Running late / delayed</option>
      <option value="bag_discrepancy">Bag count looks wrong</option>
      <option value="other">Something else</option></select></label>
    <label class="field"><span>Details *</span><textarea name="description" rows="3" required></textarea></label>
    <label class="field"><span>Bags involved (optional)</span><input name="bags" type="number" inputmode="numeric" min="0" step="1"></label>`;
  return openModal({
    title: `Report a problem${orderNoValue ? ' — ' + orderNo(orderNoValue) : ''}`, body, submitLabel: 'Send to dispatcher',
    async onSubmit(v) {
      if (!v.description.trim()) throw new Error('Please describe the problem.');
      const b = parseBagCount(v.bags, { allowEmpty: true });
      if (!b.ok) throw new Error(b.error);
      await rpc('report_problem', { p_task_id: task.id, p_kind: v.kind, p_description: v.description, p_bags: b.value });
      toast('Problem reported. The dispatchers have been notified.');
      return true;
    },
  });
}

// ---------------------------------------------------------------- cancel / reopen
export async function cancelOrder(order) {
  const r = await confirmAction({
    title: `Cancel ${orderNo(order.order_no)}?`,
    message: 'The order and all of its history are kept. Assigned people are notified. You can reopen it later.',
    confirmLabel: 'Cancel order', danger: true, reasonLabel: 'Reason', reasonRequired: true,
    reasons: settings().cancellation_reasons || [],
  });
  if (!r) return false;
  await rpc('cancel_order', { p_order_id: order.id, p_reason: r.reason });
  toast('Order cancelled.');
  return true;
}

export async function reopenOrder(order) {
  const r = await confirmAction({
    title: `Reopen ${orderNo(order.order_no)}?`, message: 'The order returns to the stage it was at.',
    confirmLabel: 'Reopen', reasonLabel: 'Reason', reasonRequired: true,
  });
  if (!r) return false;
  await rpc('reopen_order', { p_order_id: order.id, p_reason: r.reason });
  toast('Order reopened.');
  return true;
}

// ---------------------------------------------------------------- bag count / reschedule
export async function changeBagsModal(order) {
  return openModal({
    title: `Expected bags — ${orderNo(order.order_no)}`,
    body: html`<label class="field"><span>Expected number of bags</span>
      <input name="bags" type="number" inputmode="numeric" min="0" max="500" step="1" value="${order.expected_bags}" required></label>
      <p class="muted">This is the count expected at pickup. Counts recorded at handoffs are never overwritten.</p>`,
    async onSubmit(v) {
      const p = parseBagCount(v.bags);
      if (!p.ok) throw new Error(p.error);
      await run(sb.from('orders').update({ expected_bags: p.value }).eq('id', order.id));
      // keep not-yet-started stages in step
      await run(sb.from('order_tasks').update({ expected_bags: p.value }).eq('order_id', order.id)
        .in('task_type', ['pickup', 'dropoff', 'washing']).eq('status', 'pending'));
      toast('Bag count updated.');
      return true;
    },
  });
}

export async function rescheduleModal(order, tasks) {
  const t = tasks.find((x) => x.status === 'pending' || x.status === 'in_progress');
  if (!t) { toast('No open stage to reschedule.', 'warn'); return null; }
  return openModal({
    title: `Change date — ${orderNo(order.order_no)}`,
    body: html`<p>Next open stage: <strong>${taskLabel(t.task_type, settings())}</strong>
        (currently ${fmtDateTime(t.scheduled_at, tz())})</p>
      <label class="field"><span>New date & time</span>${dtInputs('when', t.scheduled_at)}</label>
      <label class="check"><input type="checkbox" name="shift" checked> Move the later stages by the same amount</label>`,
    async onSubmit(v) {
      const when = readDt(v, 'when');
      if (!when) throw new Error('Choose a date.');
      const delta = new Date(when).getTime() - new Date(t.scheduled_at || when).getTime();
      await run(sb.from('order_tasks').update({ scheduled_at: when }).eq('id', t.id));
      if (v.shift && delta) {
        for (const later of tasks.filter((x) => x.seq > t.seq && x.status === 'pending' && x.scheduled_at)) {
          await run(sb.from('order_tasks').update({ scheduled_at: new Date(new Date(later.scheduled_at).getTime() + delta).toISOString() }).eq('id', later.id));
        }
      }
      toast('Rescheduled.');
      return true;
    },
  });
}

export { personName };

// ---------------------------------------------------------------- driver job offers

export function dispatchBadge(status) {
  if (!status) return '';
  return html`<span class="badge tone-${DISPATCH_TONE[status] || 'neutral'}" title="Driver dispatch">${DISPATCH_LABELS[status] || status}</span>`;
}

// Offer a driver stage to drivers. Drivers see only the street-to-street route until they accept.
export async function dispatchModal(taskId, { orderNoValue, taskType } = {}) {
  const pv = await rpc('dispatch_preview', { p_task_id: taskId });
  if (pv.blocked) { toast(pv.blocked, 'warn'); return null; }
  const drivers = peopleWithRole('driver');
  const s = settings();
  const def = s.default_offer_minutes ?? '';
  const minuteOpts = [['', 'No time limit'], ['30', '30 minutes'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['1440', '24 hours']];
  if (def && !minuteOpts.find((o) => o[0] === String(def))) minuteOpts.push([String(def), `${def} minutes`]);
  const body = html`
    <div class="route-preview" aria-label="What drivers will see">
      <small class="muted">Drivers will see (before accepting):</small>
      <div class="route"><strong>${pv.from_street}</strong> <span aria-hidden="true">→</span> <strong>${pv.to_street}</strong></div>
      <small class="muted">House numbers, apartments, contacts and access instructions are revealed only to the driver who accepts.</small>
    </div>
    ${pv.assignee_id ? html`<div class="notice notice-warn">This stage is assigned to <strong>${personName(pv.assignee_id)}</strong>.
      <label class="check"><input type="checkbox" name="replace"> Remove them and offer it to drivers instead</label></div>` : ''}
    <fieldset class="field"><legend>Offer to</legend>
      <label class="check"><input type="radio" name="who" value="all" checked> All active drivers (${drivers.length})</label>
      <label class="check"><input type="radio" name="who" value="some"> Only the drivers I choose</label>
      <div class="chips" data-some hidden>${drivers.map((p) => html`<label class="chip sm"><input type="checkbox" name="drivers" value="${p.id}"><span>${p.full_name}</span></label>`)}</div>
    </fieldset>
    <label class="field"><span>Offer stays open for</span><select name="minutes">
      ${minuteOpts.map(([v, l]) => html`<option value="${v}" ${String(def) === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <label class="field"><span>Note for drivers (optional)</span><input name="note" maxlength="200" placeholder="e.g. 2 heavy bags">
      <small class="hint">Shown before accepting — don't type addresses or phone numbers here.</small></label>`;
  return openModal({
    title: `${dispatchButtonLabel(taskType)}${orderNoValue ? ' — ' + orderNo(orderNoValue) : ''}`, body, submitLabel: 'Send to drivers', guardUnsaved: false,
    onMount(form) {
      on(form, 'change', 'input[name=who]', () => { $('[data-some]', form).hidden = form.who.value !== 'some'; });
    },
    async onSubmit(v, form) {
      if (pv.assignee_id && !v.replace) throw new Error('Tick "Remove them and offer it to drivers instead", or cancel and use Reassign.');
      const chosen = [...form.querySelectorAll('input[name=drivers]:checked')].map((x) => x.value);
      if (v.who === 'some' && !chosen.length) throw new Error('Choose at least one driver.');
      if (/\b\d{1,6}[a-z]?\s+(\w+\s+){0,3}(st|street|ave|avenue|rd|road|blvd|ln|lane|dr|drive|pl|place|ct|court|pkwy|parkway|way|terrace|ter)\b/i.test(v.note || '') || /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(v.note || '')) {
        if (!form.dataset.noteOk) { form.dataset.noteOk = '1'; throw new Error('The note looks like it contains an address or phone number, which drivers would see before accepting. Remove it, or press Send again to keep it.'); }
      }
      await rpc('dispatch_task', {
        p_task_id: taskId, p_person_ids: v.who === 'some' ? chosen : null,
        p_expires_minutes: v.minutes ? Number(v.minutes) : null, p_note: v.note || null, p_replace_assignee: !!v.replace,
      });
      toast('Sent. Drivers can now accept it from their phones.');
      return true;
    },
  });
}

export async function cancelOfferAction(offerId) {
  const r = await confirmAction({ title: 'Cancel this offer?', message: 'Drivers will no longer see it. You can dispatch again or assign someone directly.',
    confirmLabel: 'Cancel offer', danger: true, reasonLabel: 'Reason (optional)' });
  if (!r) return false;
  await rpc('cancel_offer', { p_offer_id: offerId, p_reason: r.reason || null });
  toast('Offer cancelled.');
  return true;
}
