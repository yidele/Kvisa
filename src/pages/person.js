// Person profile (driver and/or washing volunteer): details, roles, schedule, history, bulk reassignment.
import { sb, rpc, run, tz, settings, roles as myRoles, loadPeople, state, peopleWithRole } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast, openModal, telLink, taskStatusBadge } from '../components/ui.js';
import { WEEKDAYS, personNo, orderNo, taskLabel, fmtDateTime, parseBagCount } from '../lib/format.js';
import { app } from '../lib/app.js';

function personForm(p, presetRole) {
  const days = p.preferred_days || [];
  const r = p.roles || (presetRole ? [presetRole] : []);
  return html`
    <div class="row">
      <label class="field grow"><span>Full name *</span><input name="full_name" value="${p.full_name || ''}" required></label>
      <label class="field"><span>Phone</span><input name="phone" type="tel" value="${p.phone || ''}"></label>
      <label class="field"><span>Email</span><input name="email" type="email" value="${p.email || ''}"></label>
    </div>
    <fieldset class="field"><legend>Roles *</legend><div class="chips">
      <label class="chip"><input type="checkbox" name="roles" value="driver" ${r.includes('driver') ? raw('checked') : ''}><span>Driver</span></label>
      <label class="chip"><input type="checkbox" name="roles" value="washer" ${r.includes('washer') ? raw('checked') : ''}><span>Washing volunteer</span></label>
    </div></fieldset>
    <label class="field"><span>Address (washing location for volunteers)</span><input name="address" value="${p.address || ''}"></label>
    <label class="field"><span>Address note</span><input name="address_note" value="${p.address_note || ''}"></label>
    <div class="row">
      <label class="field grow"><span>Availability</span><input name="availability" value="${p.availability || ''}" placeholder="e.g. Weekday evenings"></label>
      <label class="field"><span>Max bags per day</span><input name="max_bags_per_day" type="number" min="0" step="1" value="${p.max_bags_per_day ?? ''}"></label>
    </div>
    <fieldset class="field"><legend>Preferred days</legend><div class="chips">
      ${WEEKDAYS.map((d, i) => html`<label class="chip"><input type="checkbox" name="preferred_days" value="${i}" ${days.includes(i) ? raw('checked') : ''}><span>${d}</span></label>`)}
    </div></fieldset>
    <div class="row">
      <label class="field"><span>Unavailable from</span><input type="date" name="unavailable_from" value="${p.unavailable_from || ''}"></label>
      <label class="field"><span>Unavailable until</span><input type="date" name="unavailable_until" value="${p.unavailable_until || ''}"></label>
    </div>
    <label class="field"><span>Notes</span><textarea name="notes" rows="2">${p.notes || ''}</textarea></label>
    ${p.id ? html`<label class="check"><input type="checkbox" name="active" ${p.active ? raw('checked') : ''}> Active</label>` : ''}`;
}

async function savePerson(id, v) {
  if (!v.full_name.trim()) throw new Error('Enter the name.');
  const rolesSel = v.roles || [];
  if (!rolesSel.length) throw new Error('Choose at least one role.');
  const max = parseBagCount(v.max_bags_per_day, { allowEmpty: true });
  if (!max.ok) throw new Error(max.error);
  if (v.unavailable_from && v.unavailable_until && v.unavailable_until < v.unavailable_from) throw new Error('"Unavailable until" is before "from".');
  const n = (x) => (x && String(x).trim() ? String(x).trim() : null);
  const row = {
    full_name: v.full_name.trim(), phone: n(v.phone), email: n(v.email), address: n(v.address), address_note: n(v.address_note),
    availability: n(v.availability), max_bags_per_day: max.value, preferred_days: (v.preferred_days || []).map(Number),
    unavailable_from: n(v.unavailable_from), unavailable_until: n(v.unavailable_until), notes: n(v.notes),
  };
  if (id) row.active = !!v.active;
  const saved = id ? await run(sb.from('people').update(row).eq('id', id).select().single())
    : await run(sb.from('people').insert(row).select().single());
  const existing = id ? await run(sb.from('person_roles').select('*').eq('person_id', id)) : [];
  for (const r of ['driver', 'washer']) {
    const want = rolesSel.includes(r);
    const has = existing.find((x) => x.role === r);
    if (want && !has) await run(sb.from('person_roles').insert({ person_id: saved.id, role: r }));
    else if (has && has.active !== want) await run(sb.from('person_roles').update({ active: want }).eq('person_id', saved.id).eq('role', r));
  }
  await loadPeople(true);
  return saved;
}

export async function render(root, { params, query }) {
  if (params.id === 'new') {
    const presetRole = query.get('role');
    setHtml(root, html`${pageHeader(presetRole === 'washer' ? 'New washing volunteer' : 'New driver', html`<a class="btn" href="#/${presetRole === 'washer' ? 'volunteers' : 'drivers'}">Back</a>`)}
      <form class="card form-section" novalidate>${personForm({}, presetRole)}
        <div class="form-error notice notice-error" role="alert" hidden></div>
        <div class="sticky-actions"><button class="btn btn-primary" type="submit">Save</button></div></form>`);
    const form = $('form', root);
    on(form, 'input', 'input,textarea', () => app.setDirty(true));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form); err.hidden = true;
      try {
        const v = formValues(form);
        const dup = (state.people || []).find((p) => p.full_name.toLowerCase() === v.full_name.trim().toLowerCase()
          || (v.phone && p.phone && p.phone.replace(/\D/g, '').endsWith(v.phone.replace(/\D/g, '').slice(-7))));
        if (dup && !form.dataset.dupOk) {
          form.dataset.dupOk = '1';
          throw new Error(`${dup.full_name} already exists. To give them another role, open their record instead. Press Save again to create a separate person anyway.`);
        }
        const p = await savePerson(null, v);
        app.setDirty(false); toast('Saved.'); app.navigate('/people/' + p.id);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return () => app.setDirty(false);
  }

  const id = params.id;
  async function draw() {
    await loadPeople(true);
    const p = state.people.find((x) => x.id === id);
    if (!p) throw new Error('Person not found.');
    const [open, done, account, invite] = await Promise.all([
      run(sb.from('task_calendar').select('*').eq('assignee_id', id).in('task_status', ['pending', 'in_progress']).neq('order_status', 'cancelled').order('scheduled_at')),
      run(sb.from('task_calendar').select('*').eq('assignee_id', id).eq('task_status', 'completed').order('completed_at', { ascending: false }).limit(100)),
      run(sb.from('profiles').select('id,email,active').eq('person_id', id).maybeSingle()),
      myRoles.admin ? run(sb.from('invites').select('*').eq('person_id', id).is('used_at', null).maybeSingle()) : Promise.resolve(null),
    ]);
    const bags = done.reduce((a, t) => a + (t.actual_bags || 0), 0);
    setHtml(root, html`
      ${pageHeader(html`${p.full_name} <small class="muted">${personNo(p.person_no)}</small>`,
        html`<button class="btn" data-act="edit">Edit</button>
          ${open.length ? html`<button class="btn" data-act="reassign">Reassign open tasks…</button>` : ''}`,
        `${p.roles.map((r) => (r === 'washer' ? 'Washing volunteer' : 'Driver')).join(' & ') || 'No active role'}${p.active ? '' : ' · INACTIVE'}`)}
      <div class="stats small">
        <div class="stat"><span class="stat-value">${open.length}</span><span class="stat-label">Open tasks</span></div>
        <div class="stat"><span class="stat-value">${done.length}</span><span class="stat-label">Completed tasks (last 100)</span></div>
        <div class="stat"><span class="stat-value">${bags}</span><span class="stat-label">Bags handled (in those)</span></div>
      </div>
      <div class="grid-2">
        <section class="card"><h2>Details</h2><dl class="kv">
          <div><dt>Phone</dt><dd>${telLink(p.phone) || '—'}</dd></div>
          <div><dt>Email</dt><dd>${p.email || '—'}</dd></div>
          <div><dt>Address</dt><dd>${p.address || '—'}${p.address_note ? html`<br><small>${p.address_note}</small>` : ''}</dd></div>
          <div><dt>Availability</dt><dd>${p.availability || '—'}</dd></div>
          <div><dt>Preferred days</dt><dd>${(p.preferred_days || []).map((d) => WEEKDAYS[d]).join(', ') || '—'}</dd></div>
          <div><dt>Max bags / day</dt><dd>${p.max_bags_per_day ?? '—'}</dd></div>
          <div><dt>Unavailable</dt><dd>${p.unavailable_from ? `${p.unavailable_from} → ${p.unavailable_until || p.unavailable_from}` : '—'}</dd></div>
          <div><dt>Notes</dt><dd class="pre">${p.notes || '—'}</dd></div>
          <div><dt>App login</dt><dd>${account ? html`${account.email} ${account.active ? '' : '(deactivated)'}`
            : invite ? html`Invited as ${invite.email} — waiting for them to create their account`
            : myRoles.admin ? html`<button class="btn btn-sm" data-act="invite">Invite to log in…</button>` : 'No login'}</dd></div>
        </dl></section>
        <section class="card"><h2>Upcoming & open tasks</h2>
          ${open.length ? html`<ul class="list">${open.map((t) => html`<li><a class="row-link" href="#/orders/${t.order_id}">
            <span><strong>${taskLabel(t.task_type, settings())}</strong> · ${orderNo(t.order_no)} · ${t.client_name}</span>
            <span>${taskStatusBadge(t.task_status)} <small>${fmtDateTime(t.scheduled_at, tz())}</small></span></a></li>`)}</ul>`
            : emptyState('Nothing assigned', '')}
        </section>
      </div>
      <section class="card"><h2>Completed</h2>
        ${done.length ? html`<ul class="list">${done.map((t) => html`<li><a class="row-link" href="#/orders/${t.order_id}">
          <span>${taskLabel(t.task_type, settings())} · ${orderNo(t.order_no)} · ${t.client_name}</span>
          <span><small>${t.actual_bags ?? '—'} bag(s) · ${fmtDateTime(t.completed_at, tz())}</small></span></a></li>`)}</ul>` : emptyState('No completed tasks yet', '')}
      </section>`);
    root._p = p; root._open = open;
  }

  on(root, 'click', '[data-action=reload]', () => draw().catch((e) => setHtml(root, errorState(e))));
  on(root, 'click', '[data-act]', async (e, el) => {
    const p = root._p;
    try {
      let changed;
      if (el.dataset.act === 'edit') {
        changed = await openModal({ title: 'Edit ' + p.full_name, wide: true, body: personForm(p),
          async onSubmit(v) { await savePerson(p.id, v); toast('Saved.'); return true; } });
      } else if (el.dataset.act === 'reassign') {
        const open = root._open;
        const kinds = [...new Set(open.map((t) => (t.task_type === 'washing' ? 'washer' : 'driver')))];
        changed = await openModal({
          title: `Reassign ${p.full_name}'s open tasks`, wide: true,
          body: html`<p class="muted">Previous assignments stay in each order's history.</p>
            ${kinds.map((k) => html`<label class="field"><span>Give ${k === 'washer' ? 'washing' : 'driving'} tasks to</span>
              <select name="to_${k}"><option value="">— Leave as is —</option>
                ${peopleWithRole(k).filter((x) => x.id !== p.id).map((x) => html`<option value="${x.id}">${x.full_name}</option>`)}
                <option value="__none">Unassign (dispatcher will choose later)</option></select></label>`)}
            <ul class="list compact">${open.map((t) => html`<li>${taskLabel(t.task_type, settings())} · ${orderNo(t.order_no)} · ${fmtDateTime(t.scheduled_at, tz())}</li>`)}</ul>`,
          async onSubmit(v) {
            let n = 0;
            for (const t of open) {
              const k = t.task_type === 'washing' ? 'washer' : 'driver';
              const to = v['to_' + k];
              if (!to) continue;
              await run(sb.from('order_tasks').update({ assignee_id: to === '__none' ? null : to }).eq('id', t.task_id));
              n++;
            }
            if (!n) throw new Error('Choose who should take the tasks.');
            toast(`${n} task(s) reassigned.`); return true;
          },
        });
      } else if (el.dataset.act === 'invite') {
        changed = await openModal({
          title: `Invite ${p.full_name} to log in`,
          body: html`<label class="field"><span>Email *</span><input name="email" type="email" value="${p.email || ''}" required></label>
            <fieldset class="field"><legend>Access</legend>
              ${p.roles.includes('driver') ? html`<label class="check"><input type="checkbox" name="r" value="driver" checked> Driver (own tasks only)</label>` : ''}
              ${p.roles.includes('washer') ? html`<label class="check"><input type="checkbox" name="r" value="volunteer" checked> Washing volunteer (own tasks only)</label>` : ''}
              <label class="check"><input type="checkbox" name="r" value="dispatcher"> Dispatcher</label></fieldset>
            <p class="muted">After saving, tell them to open Kvisa, choose “Create account”, and use this email.</p>`,
          async onSubmit(v) {
            await rpc('invite_user', { p_email: v.email, p_roles: v.r || [], p_person_id: p.id, p_full_name: p.full_name });
            toast('Invitation saved.'); return true;
          },
        });
      }
      if (changed) await draw();
    } catch (err) { toast(err.message, 'error'); }
  });
  try { await draw(); } catch (err) { setHtml(root, errorState(err)); }
}
