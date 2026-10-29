// Order detail: stages, bag trail, exceptions, corrections, history.
import { sb, rpc, run, tz, settings, personName, categoryLabel, state } from '../lib/api.js';
import { html, raw, setHtml, $, on } from '../lib/dom.js';
import {
  pageHeader, statusBadge, taskStatusBadge, loading, errorState, emptyState, toast, openModal, confirmAction, telLink, mapLink,
} from '../components/ui.js';
import {
  assignModal, recordModal, problemModal, cancelOrder, reopenOrder, changeBagsModal, rescheduleModal,
  dispatchModal, cancelOfferAction, dispatchBadge,
} from '../components/orderActions.js';
import { renderAuditList } from './history.js';
import {
  orderNo, taskLabel, fmtDateTime, fmtDate, EVENT_LABELS, parseBagCount, nextActions, clientNo,
  DRIVER_STAGES, dispatchButtonLabel, RESPONSE_LABELS, DISPATCH_LABELS,
} from '../lib/format.js';

export async function render(root, { params }) {
  const id = params.id;
  let data = null;

  async function load() {
    const [ov, order, tasks, events, exceptions, assigns, audit, ...extra] = await Promise.all([
      run(sb.from('order_overview').select('*').eq('id', id).maybeSingle()),
      run(sb.from('orders').select('*, clients(name, client_no, phone, category_id)').eq('id', id).maybeSingle()),
      run(sb.from('order_tasks').select('*').eq('order_id', id).order('seq')),
      run(sb.from('handoff_events').select('*').eq('order_id', id).order('occurred_at').order('recorded_at')),
      run(sb.from('order_exceptions').select('*').eq('order_id', id).order('reported_at', { ascending: false })),
      run(sb.from('task_assignments').select('*, order_tasks!inner(order_id, task_type)').eq('order_tasks.order_id', id).order('assigned_at')),
      run(sb.from('audit_logs').select('*').eq('order_id', id).order('at', { ascending: false }).limit(200)),
      run(sb.from('task_dispatch').select('*').eq('order_id', id)),
      run(sb.from('task_offers').select('*').eq('order_id', id).order('created_at', { ascending: false })),
      run(sb.from('offer_recipients').select('*').eq('order_id', id)),
    ]);
    if (!order) throw new Error('Order not found (it may not exist, or you may not have access).');
    data = { ov, order, tasks, events, exceptions, assigns, audit, dispatch: extra[0], offers: extra[1], recipients: extra[2] };
  }

  function draw() {
    const { ov, order, tasks, events, exceptions, assigns, audit } = data;
    const s = settings();
    const open = order.status !== 'cancelled' && order.status !== 'completed';
    const reverted = new Set(events.filter((e) => e.event_type === 'event_reverted').map((e) => e.corrects_event_id));
    const corrections = events.filter((e) => e.event_type === 'count_correction');
    const effective = (e) => { const c = corrections.filter((x) => x.corrects_event_id === e.id).pop(); return c ? c.actual_bags : e.actual_bags; };
    const received = events.some((e) => e.event_type === 'received_by_washer' && !reverted.has(e.id));
    const openEx = exceptions.filter((x) => x.status === 'open');

    const dispatchSection = (t) => {
      const d = (data.dispatch || []).find((x) => x.task_id === t.id) || {};
      const offers = (data.offers || []).filter((f) => f.task_id === t.id);
      const canSend = open && !d.blocked_reason && !['available', 'in_progress', 'completed'].includes(d.dispatch_status);
      return html`<div class="dispatch-box">
        <div class="dispatch-head"><span>Driver dispatch</span>${dispatchBadge(d.dispatch_status)}</div>
        ${d.dispatch_status === 'available' ? html`<small class="muted">Sent ${fmtDateTime(d.offered_at, tz())} to ${d.offered_count} driver(s)${d.declined_count ? `, ${d.declined_count} declined` : ''}${d.expires_at ? ` · open until ${fmtDateTime(d.expires_at, tz())}` : ''}</small>` : ''}
        ${d.blocked_reason && open && t.status === 'pending' ? html`<small class="muted">${d.blocked_reason}</small>` : ''}
        <div class="btn-group">
          ${canSend ? html`<button class="btn btn-sm ${d.dispatch_status === 'not_dispatched' ? 'btn-primary' : ''}" data-act="dispatch" data-task="${t.id}" data-type="${t.task_type}">${['declined', 'expired', 'cancelled'].includes(d.dispatch_status) ? 'Resend' : dispatchButtonLabel(t.task_type)}</button>` : ''}
          ${d.dispatch_status === 'available' ? html`<button class="btn btn-sm" data-act="dispatch" data-task="${t.id}" data-type="${t.task_type}">Resend</button>
            <button class="btn btn-sm btn-danger-ghost" data-act="cancel-offer" data-offer="${d.offer_id}">Cancel offer</button>` : ''}
        </div>
        ${offers.length ? html`<details class="offer-log"><summary>Offer history (${offers.length})</summary>
          <ul class="list compact">${offers.map((f) => html`<li class="offer-item"><div>
            <strong>${DISPATCH_LABELS[f.status] || f.status}</strong> <small class="muted">${fmtDateTime(f.created_at, tz())}${f.accepted_at ? ' · accepted ' + fmtDateTime(f.accepted_at, tz()) : ''}${f.close_reason ? ' · ' + f.close_reason : ''}</small>
            <div class="chips">${(data.recipients || []).filter((r) => r.offer_id === f.id).map((r) => html`<span class="badge ${r.response === 'accepted' ? 'tone-done' : r.response === 'declined' ? 'tone-danger' : 'tone-neutral'}">${personName(r.person_id) || 'Driver'}: ${RESPONSE_LABELS[r.response] || r.response}</span>`)}</div>
          </div></li>`)}</ul></details>` : ''}
      </div>`;
    };

    const stageCard = (t) => {
      const prevDone = tasks.filter((x) => x.seq < t.seq).every((x) => x.status === 'completed');
      const acts = open && prevDone ? nextActions(t.task_type, t.status, received) : [];
      const laterStarted = tasks.some((x) => x.seq > t.seq && (x.status === 'completed' || x.status === 'in_progress'));
      const p = state.people?.find((x) => x.id === t.assignee_id);
      const moved = t.original_scheduled_at && t.scheduled_at && new Date(t.original_scheduled_at).getTime() !== new Date(t.scheduled_at).getTime();
      return html`
        <article class="stage card stage-${t.status}" id="stage-${t.task_type}">
          <header><span class="step-no">${t.seq}</span><h3>${taskLabel(t.task_type, s)}</h3>${taskStatusBadge(t.status)}</header>
          <dl class="kv">
            <div><dt>${t.task_type === 'washing' ? 'Volunteer' : 'Driver'}</dt>
              <dd>${p ? html`<a href="#/people/${p.id}">${p.full_name}</a> ${telLink(p.phone)}` : html`<span class="warn-text">Unassigned</span>`}</dd></div>
            <div><dt>${t.task_type === 'washing' ? 'Expected' : 'Scheduled'}</dt><dd>${fmtDateTime(t.scheduled_at, tz())}
              ${moved ? html`<small class="muted">(originally ${fmtDateTime(t.original_scheduled_at, tz())})</small>` : ''}</dd></div>
            ${t.task_type === 'washing' ? html`<div><dt>Location</dt><dd>${mapLink(t.from_address)}</dd></div>` : html`
              <div><dt>From</dt><dd>${mapLink(t.from_address)}</dd></div>
              <div><dt>To</dt><dd>${mapLink(t.to_address)}</dd></div>`}
            <div><dt>Bags</dt><dd>${t.actual_bags != null ? html`<strong>${t.actual_bags}</strong> recorded` : 'expected ' + (t.expected_bags ?? '—')}</dd></div>
            ${t.started_at && t.task_type === 'washing' ? html`<div><dt>Washing started</dt><dd>${fmtDateTime(t.started_at, tz())}</dd></div>` : ''}
            ${t.completed_at ? html`<div><dt>Completed</dt><dd>${fmtDateTime(t.completed_at, tz())}</dd></div>` : ''}
            ${t.instructions ? html`<div><dt>Instructions</dt><dd>${t.instructions}</dd></div>` : ''}
            ${t.notes ? html`<div><dt>Notes</dt><dd>${t.notes}</dd></div>` : ''}
          </dl>
          ${DRIVER_STAGES.includes(t.task_type) ? dispatchSection(t) : ''}
          <div class="stage-actions">
            ${acts.length ? html`<button class="btn btn-primary btn-sm" data-act="record" data-task="${t.id}">Record: ${acts[acts.length - 1].label}</button>` : ''}
            ${open && !prevDone && t.status === 'pending' ? html`<small class="muted">Waits for the earlier stage.</small>` : ''}
            ${open && t.status !== 'completed' ? html`<button class="btn btn-sm" data-act="assign" data-type="${t.task_type}">${t.assignee_id ? 'Reassign' : 'Assign'}</button>` : ''}
            ${open && t.status !== 'completed' ? html`<button class="btn btn-sm btn-ghost" data-act="problem" data-task="${t.id}">Report problem</button>` : ''}
            ${(t.status === 'completed' || t.status === 'in_progress') && !laterStarted && order.status !== 'cancelled'
              ? html`<button class="btn btn-sm btn-ghost" data-act="undo" data-task="${t.id}">Undo step…</button>` : ''}
          </div>
        </article>`;
    };

    const nameOf = (pid) => personName(pid) || (pid ? 'Unknown person' : '');
    setHtml(root, html`
      ${pageHeader(html`${orderNo(order.order_no)} <small class="muted">· ${order.clients?.name}</small>`, html`
        <a class="btn btn-primary" href="#/orders/${id}/edit">Edit order</a>
        ${open ? html`<button class="btn" data-act="assign">Assign</button>
          <button class="btn" data-act="reschedule">Change date</button>
          <button class="btn" data-act="bags">Bag count</button>` : ''}
        ${open && order.recurring_schedule_id ? html`<button class="btn" data-act="skip">Skip this occurrence</button>` : ''}
        ${open ? html`<button class="btn btn-danger-ghost" data-act="cancel">Cancel order</button>` : ''}
        ${order.status === 'cancelled' ? html`<button class="btn" data-act="reopen">Reopen order</button>` : ''}`)}
      <div class="status-bar">
        ${statusBadge(order.status)}
        ${ov?.is_overdue ? html`<span class="badge tone-warn">Overdue</span>` : ''}
        ${openEx.length ? html`<a href="#exceptions" class="badge tone-danger">${openEx.length} unresolved issue(s)</a>` : ''}
        <span><strong>Location:</strong> ${ov?.current_location || '—'}</span>
        <span><strong>Bags now:</strong> ${ov?.current_bags ?? order.expected_bags} <small class="muted">(expected ${order.expected_bags})</small></span>
        ${order.status === 'cancelled' ? html`<span><strong>Cancelled:</strong> ${order.cancel_reason}</span>` : ''}
      </div>
      ${order.source === 'kiosk' ? html`<div class="notice notice-info">Entered on the tablet by ${order.pickup_contact || 'the client'}${order.pickup_phone ? ` (${order.pickup_phone})` : ''} — labels were printed there.</div>` : ''}
      ${order.recurring_schedule_id ? html`<div class="notice notice-info">Recurring occurrence for ${fmtDate(order.occurrence_date)}.
        ${order.detached_from_series ? 'This occurrence was edited individually, so series changes no longer apply to it.' : 'Series changes apply to it until it is edited individually.'}
        <a href="#/clients/${order.client_id}?series=${order.recurring_schedule_id}">View series</a></div>` : ''}

      <div class="grid-2">
        <section class="card">
          <h2>Client & recipient</h2>
          <dl class="kv">
            <div><dt>Client</dt><dd><a href="#/clients/${order.client_id}">${order.clients?.name}</a> <small class="muted">${clientNo(order.clients?.client_no)} · ${categoryLabel(order.category_id)}</small></dd></div>
            <div><dt>Pickup contact</dt><dd>${order.pickup_contact || '—'} ${telLink(order.pickup_phone)}</dd></div>
            <div><dt>Pickup address</dt><dd>${mapLink(order.pickup_address)}</dd></div>
            <div><dt>Return recipient</dt><dd>${order.return_recipient || '—'} ${telLink(order.return_phone)}</dd></div>
            <div><dt>Return address</dt><dd>${mapLink(order.return_address)}</dd></div>
            <div><dt>Instructions</dt><dd>${order.delivery_instructions || '—'}</dd></div>
            <div><dt>Expected return</dt><dd>${fmtDate(order.expected_return_date)}</dd></div>
            ${order.bag_notes ? html`<div><dt>Bag notes</dt><dd>${order.bag_notes}</dd></div>` : ''}
            ${order.notes ? html`<div><dt>Order notes</dt><dd class="pre">${order.notes}</dd></div>` : ''}
          </dl>
        </section>
        <section class="card" id="exceptions">
          <h2>Exceptions & discrepancies</h2>
          ${exceptions.length ? html`<ul class="list">${exceptions.map((x) => html`
            <li class="exception ${x.status}">
              <div><span class="badge ${x.status === 'open' ? 'tone-danger' : 'tone-done'}">${x.status === 'open' ? 'Open' : 'Resolved'}</span>
                <strong>${x.kind.replace(/_/g, ' ')}</strong> <small class="muted">${fmtDateTime(x.reported_at, tz())}</small></div>
              <p>${x.description}</p>
              ${x.status === 'resolved' ? html`<p class="muted">Resolution: ${x.resolution} (${fmtDateTime(x.resolved_at, tz())})</p>`
                : html`<button class="btn btn-sm" data-act="resolve" data-ex="${x.id}">Resolve…</button>`}
            </li>`)}</ul>` : emptyState('No exceptions', 'Bag counts have matched at every handoff so far.')}
        </section>
      </div>

      <h2 class="section-title">Stages</h2>
      <div class="stages">${tasks.map(stageCard)}</div>

      <div class="grid-2">
        <section class="card">
          <h2>Bag trail</h2>
          ${events.length ? html`<ol class="timeline">${events.map((e) => {
            const isRev = reverted.has(e.id);
            const eff = effective(e);
            return html`<li class="${isRev ? 'reverted' : ''} ev-${e.event_type}">
              <div><strong>${EVENT_LABELS[e.event_type] || e.event_type}</strong>
                ${e.actual_bags != null && !['count_correction'].includes(e.event_type) ? html` — ${e.actual_bags} bag(s)${eff !== e.actual_bags ? html` <span class="badge tone-warn">corrected to ${eff}</span>` : ''}
                  ${e.expected_bags != null && e.expected_bags !== e.actual_bags ? html` <small class="warn-text">(expected ${e.expected_bags})</small>` : ''}` : ''}
                ${e.event_type === 'count_correction' ? html` — ${e.expected_bags} → ${e.actual_bags}` : ''}
                ${isRev ? html` <span class="badge tone-muted">undone</span>` : ''}</div>
              <small class="muted">${fmtDateTime(e.occurred_at, tz())}
                ${e.from_person_id || e.from_party ? html` · from ${nameOf(e.from_person_id) || e.from_party}` : ''}
                ${e.to_person_id || e.to_party ? html` · to ${nameOf(e.to_person_id) || e.to_party}` : ''}
                ${e.location ? html` · ${e.location}` : ''}</small>
              ${e.notes ? html`<div class="pre">${e.notes}</div>` : ''}
              ${!isRev && e.actual_bags != null && e.event_type !== 'count_correction'
                ? html`<button class="link-btn" data-act="correct" data-ev="${e.id}" data-count="${eff}">Correct count…</button>` : ''}
            </li>`;
          })}</ol>` : emptyState('No handoffs yet', 'Handoffs appear here as drivers and volunteers record them.')}
        </section>
        <section class="card">
          <h2>Assignment history</h2>
          ${assigns.length ? html`<ul class="list compact">${assigns.map((a) => html`
            <li><span><strong>${taskLabel(a.order_tasks.task_type, s)}</strong>: ${nameOf(a.person_id)}</span>
              <small class="muted">${fmtDateTime(a.assigned_at, tz())}${a.ended_at ? html` → replaced ${fmtDateTime(a.ended_at, tz())}` : html` · current`}</small></li>`)}</ul>`
            : emptyState('No assignments yet', '')}
        </section>
      </div>

      <section class="card">
        <h2>History</h2>
        ${renderAuditList(audit, { showOrder: false })}
      </section>`);
  }

  async function refresh() {
    try { await load(); draw(); } catch (err) { setHtml(root, errorState(err)); }
  }

  on(root, 'click', '[data-action=reload]', refresh);
  on(root, 'click', '[data-act]', async (e, el) => {
    const { order, tasks } = data;
    const task = el.dataset.task ? tasks.find((t) => t.id === el.dataset.task) : null;
    try {
      let changed;
      switch (el.dataset.act) {
        case 'assign': changed = await assignModal(order.id, el.dataset.type || null); break;
        case 'reschedule': changed = await rescheduleModal(order, tasks); break;
        case 'bags': changed = await changeBagsModal(order); break;
        case 'cancel': changed = await cancelOrder(order); break;
        case 'reopen': changed = await reopenOrder(order); break;
        case 'record': {
          const received = data.events.some((x) => x.event_type === 'received_by_washer'
            && !data.events.some((r) => r.event_type === 'event_reverted' && r.corrects_event_id === x.id));
          changed = await recordModal(task, { orderNoValue: order.order_no, washingReceived: received, currentBags: data.ov?.current_bags ?? order.expected_bags });
          break;
        }
        case 'problem': changed = await problemModal(task, order.order_no); break;
        case 'dispatch': changed = await dispatchModal(el.dataset.task, { orderNoValue: order.order_no, taskType: el.dataset.type }); break;
        case 'cancel-offer': changed = await cancelOfferAction(el.dataset.offer); break;
        case 'skip': {
          const r = await confirmAction({ title: 'Skip this occurrence?', message: 'Only this date is cancelled. The recurring series continues, and this date will not be generated again.',
            confirmLabel: 'Skip', reasonLabel: 'Reason', reasons: ['Skipped occurrence', 'Client away', 'Holiday'] });
          if (r) { await rpc('skip_occurrence', { p_order_id: order.id, p_reason: r.reason || 'Skipped occurrence' }); toast('Occurrence skipped.'); changed = true; }
          break;
        }
        case 'undo': {
          const r = await confirmAction({
            title: `Undo "${taskLabel(task.task_type, settings())}"?`,
            message: 'The recorded handoff stays in the history and is marked as undone. The stage goes back to "not started" so it can be recorded again.',
            confirmLabel: 'Undo step', danger: true, reasonLabel: 'Reason', reasonRequired: true, reasons: settings().correction_reasons || [],
          });
          if (r) { await rpc('reopen_task', { p_task_id: task.id, p_reason: r.reason }); toast('Step undone.'); changed = true; }
          break;
        }
        case 'correct': changed = await openModal({
          title: 'Correct bag count',
          body: html`<p class="muted">The original count stays in the history. The corrected count is used from now on.</p>
            <label class="field"><span>Correct number of bags</span><input name="bags" type="number" inputmode="numeric" min="0" step="1" value="${el.dataset.count}" required></label>
            <label class="field"><span>Reason *</span><select name="reason_pick">${(settings().correction_reasons || []).map((r) => html`<option>${r}</option>`)}</select>
              <input name="reason" placeholder="Details"></label>`,
          async onSubmit(v) {
            const p = parseBagCount(v.bags); if (!p.ok) throw new Error(p.error);
            const reason = [v.reason_pick, v.reason].filter(Boolean).join(' — ');
            if (!reason) throw new Error('A reason is required.');
            await rpc('correct_handoff_count', { p_event_id: el.dataset.ev, p_new_count: p.value, p_reason: reason });
            toast('Count corrected.'); return true;
          },
        }); break;
        case 'resolve': changed = await openModal({
          title: 'Resolve exception',
          body: html`<label class="field"><span>How was this resolved? *</span><textarea name="resolution" rows="3" required></textarea>
            <small class="hint">This explanation is kept permanently in the order history.</small></label>`,
          async onSubmit(v) {
            if (!v.resolution.trim()) throw new Error('Explain how it was resolved.');
            await rpc('resolve_exception', { p_exception_id: el.dataset.ex, p_resolution: v.resolution });
            toast('Exception resolved.'); return true;
          },
        }); break;
      }
      if (changed) refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  setHtml(root, loading());
  await refresh();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-overlay')) refresh(); }, 60000);
  return () => clearInterval(timer);
}
