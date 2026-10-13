// Administrator settings. Every value here is stored in the database, not hard-coded.
import { sb, rpc, run, state, loadContext, loadCategories, loadPeople, peopleWithRole } from '../lib/api.js';
import { html, raw, setHtml, $, on, formValues } from '../lib/dom.js';
import { pageHeader, loading, errorState, emptyState, toast, confirmAction } from '../components/ui.js';
import { DEFAULT_STATUS_LABELS, DEFAULT_TASK_LABELS, ORDER_STATUSES, TASK_TYPES } from '../lib/format.js';

const NOTIFY = [
  ['assigned', 'New task assignments'], ['reassigned', 'Reassignments'], ['schedule_changed', 'Schedule changes & cancellations'],
  ['upcoming', 'Upcoming tasks'], ['overdue', 'Overdue tasks'], ['washing_completed', 'Washing completed'],
  ['return_ready', 'Return collection ready'], ['delivered', 'Delivery completed'], ['exception', 'Reported exceptions'],
];
const ROLE_LABELS = { admin: 'Administrator', dispatcher: 'Dispatcher', driver: 'Driver', volunteer: 'Washing volunteer' };

export async function render(root) {
  async function draw() {
    const [s, cats, users, uroles, invites] = await Promise.all([
      run(sb.from('organization_settings').select('*').eq('id', 1).single()),
      run(sb.from('client_categories').select('*').order('sort_order')),
      run(sb.from('profiles').select('*').order('email')),
      run(sb.from('user_roles').select('*')),
      run(sb.from('invites').select('*').is('used_at', null).order('created_at', { ascending: false })),
    ]);
    await loadPeople(true);
    const zones = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [s.time_zone]);
    const rolesOf = (uid) => uroles.filter((r) => r.user_id === uid && r.active).map((r) => r.role);
    const sec = (id, title, body, open) => html`<details class="card settings-section" id="${id}" ${open ? raw('open') : ''}>
      <summary><strong>${title}</strong></summary><div class="settings-body">${body}</div></details>`;

    setHtml(root, html`
      ${pageHeader('Settings', null, 'Only administrators can see this page.')}
      ${sec('org', 'Organization', html`<form data-save="org" novalidate>
        <div class="row">
          <label class="field grow"><span>Organization name</span><input name="org_name" value="${s.org_name}" required></label>
          <label class="field"><span>Phone</span><input name="org_phone" value="${s.org_phone || ''}"></label>
          <label class="field"><span>Email</span><input name="org_email" type="email" value="${s.org_email || ''}"></label>
        </div>
        <label class="field"><span>Address</span><input name="org_address" value="${s.org_address || ''}"></label>
        <label class="field"><span>Time zone (all dates and times are shown in this zone)</span><select name="time_zone">
          ${zones.map((z) => html`<option ${z === s.time_zone ? raw('selected') : ''}>${z}</option>`)}</select></label>
        <button class="btn btn-primary">Save</button></form>`, true)}
      ${sec('sched', 'Scheduling defaults & recurrence', html`<form data-save="sched" novalidate>
        <div class="row">
          <label class="field"><span>Default pickup time</span><input type="time" name="default_pickup_time" value="${String(s.default_pickup_time).slice(0, 5)}"></label>
          <label class="field"><span>Days until washing</span><input type="number" min="0" max="30" name="default_wash_days" value="${s.default_wash_days}"></label>
          <label class="field"><span>Days until return</span><input type="number" min="0" max="60" name="default_return_days" value="${s.default_return_days}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Recurring planning window (days ahead)</span><input type="number" min="1" max="180" name="planning_window_days" value="${s.planning_window_days}"></label>
          <label class="field"><span>Min. minutes between a driver's tasks</span><input type="number" min="0" max="600" name="min_minutes_between_tasks" value="${s.min_minutes_between_tasks}"></label>
          <label class="field"><span>Overdue after (minutes late)</span><input type="number" min="0" max="1440" name="overdue_grace_minutes" value="${s.overdue_grace_minutes}"></label>
          <label class="field"><span>“Coming up” reminder (hours before)</span><input type="number" min="0" max="168" name="upcoming_notice_hours" value="${s.upcoming_notice_hours}"></label>
        </div>
        <button class="btn btn-primary">Save</button></form>`)}
      ${sec('disc', 'Bag-count discrepancy rules', html`<form data-save="disc">
        <label class="check"><input type="checkbox" name="flag_collection_vs_expected" ${s.flag_collection_vs_expected ? raw('checked') : ''}>
          Flag a discrepancy when the bags collected differ from the number the client said</label>
        <label class="check"><input type="checkbox" name="require_discrepancy_resolution" ${s.require_discrepancy_resolution ? raw('checked') : ''}>
          An order cannot be completed while a bag-count discrepancy is unresolved</label>
        <p class="muted">Differences between later handoffs (e.g. driver delivered 4, washer received 3) are always flagged. Failed pickups and missing bags always block completion.</p>
        <button class="btn btn-primary">Save</button></form>`)}
      ${sec('notif', 'Notifications', html`<form data-save="notif">
        <p class="muted">In-app notifications (the bell). Email and SMS are not connected yet — no messages are sent outside the app.</p>
        <div class="chips">${NOTIFY.map(([k, l]) => html`<label class="chip"><input type="checkbox" name="notify_kinds" value="${k}" ${s.notify_kinds.includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</div>
        <button class="btn btn-primary">Save</button></form>`)}
      ${sec('cats', 'Client categories', html`<form data-save="cats">
        <div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Label</th><th>Order</th><th>Default pickup address</th><th>Default note</th><th>Active</th></tr></thead>
        <tbody>${cats.map((c) => html`<tr>
          <td><code>${c.id}</code></td>
          <td><input name="label_${c.id}" value="${c.label}" required></td>
          <td><input type="number" name="sort_${c.id}" value="${c.sort_order}" style="width:5em"></td>
          <td><input name="addr_${c.id}" value="${c.default_pickup_address || ''}"></td>
          <td><input name="note_${c.id}" value="${c.default_pickup_note || ''}"></td>
          <td><input type="checkbox" name="active_${c.id}" ${c.active ? raw('checked') : ''}></td></tr>`)}</tbody></table></div>
        <div class="row"><label class="field"><span>New category label</span><input name="new_label" placeholder="e.g. Elderly"></label></div>
        <button class="btn btn-primary">Save categories</button></form>`)}
      ${sec('labels', 'Status & stage names', html`<form data-save="labels">
        <p class="muted">Change how statuses and stages are named on screen. Their meaning stays the same.</p>
        <h3>Order statuses</h3><div class="grid-2">${ORDER_STATUSES.map((k) => html`<label class="field"><span>${DEFAULT_STATUS_LABELS[k]}</span>
          <input name="st_${k}" value="${s.status_labels?.[k] || ''}" placeholder="${DEFAULT_STATUS_LABELS[k]}"></label>`)}</div>
        <h3>Stages (task types)</h3><div class="grid-2">${TASK_TYPES.map((k) => html`<label class="field"><span>${DEFAULT_TASK_LABELS[k]}</span>
          <input name="tt_${k}" value="${s.task_type_labels?.[k] || ''}" placeholder="${DEFAULT_TASK_LABELS[k]}"></label>`)}</div>
        <button class="btn btn-primary">Save names</button></form>`)}
      ${sec('reasons', 'Cancellation & correction reasons', html`<form data-save="reasons"><div class="grid-2">
        <label class="field"><span>Cancellation reasons (one per line)</span><textarea name="cancellation_reasons" rows="6">${s.cancellation_reasons.join('\n')}</textarea></label>
        <label class="field"><span>Correction reasons (one per line)</span><textarea name="correction_reasons" rows="6">${s.correction_reasons.join('\n')}</textarea></label></div>
        <button class="btn btn-primary">Save</button></form>`)}
      ${sec('users', 'Users, roles & invitations', html`
        <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Roles</th><th>Linked person</th><th>Active</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr data-user="${u.id}">
          <td data-label="User"><strong>${u.full_name || ''}</strong><br><small>${u.email}</small></td>
          <td data-label="Roles"><div class="chips">${Object.entries(ROLE_LABELS).map(([r, l]) => html`<label class="chip sm"><input type="checkbox" name="role" value="${r}" ${rolesOf(u.id).includes(r) ? raw('checked') : ''}><span>${l}</span></label>`)}</div></td>
          <td data-label="Person"><select name="person"><option value="">— none —</option>
            ${(state.people || []).map((p) => html`<option value="${p.id}" ${p.id === u.person_id ? raw('selected') : ''}>${p.full_name}</option>`)}</select></td>
          <td data-label="Active"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''} ${u.id === state.ctx.user_id ? raw('disabled') : ''}></td>
          <td><button class="btn btn-sm" data-user-save="${u.id}">Save</button></td></tr>`)}</tbody></table></div>
        <h3>Invite someone</h3>
        <form data-save="invite" class="row wrap" novalidate>
          <label class="field"><span>Email *</span><input name="email" type="email" required></label>
          <label class="field"><span>Name</span><input name="full_name"></label>
          <fieldset class="field"><legend>Roles *</legend><div class="chips">${Object.entries(ROLE_LABELS).map(([r, l]) => html`<label class="chip sm"><input type="checkbox" name="roles" value="${r}"><span>${l}</span></label>`)}</div></fieldset>
          <label class="field"><span>Person record (required for drivers & volunteers)</span><select name="person_id"><option value="">— none —</option>
            ${(state.people || []).filter((p) => p.active).map((p) => html`<option value="${p.id}">${p.full_name} (${p.roles.join(', ')})</option>`)}</select></label>
          <button class="btn btn-primary">Invite</button>
        </form>
        <p class="muted">Invited people open Kvisa, choose “Create account” and sign up with that exact email. No email is sent automatically — tell them yourself.</p>
        ${invites.length ? html`<h3>Pending invitations</h3><ul class="list">${invites.map((i) => html`<li><span>${i.email} — ${i.roles.map((r) => ROLE_LABELS[r]).join(', ')}</span>
          <button class="btn btn-sm btn-danger-ghost" data-revoke="${i.email}">Revoke</button></li>`)}</ul>` : ''}`)}
      ${sec('backup', 'Backups & data', html`<p>The database is hosted on Supabase. See <strong>docs/OPERATIONS.md</strong> in the code repository for backup and recovery steps.
        Use Reports → “Export orders (CSV)” for a quick spreadsheet copy.</p>`)}
    `);
  }

  const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const intIn = (v, k, min, max, label) => {
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };

  on(root, 'submit', 'form[data-save]', async (e, form) => {
    e.preventDefault();
    const v = formValues(form);
    const btn = form.querySelector('button.btn-primary'); if (btn) btn.disabled = true;
    try {
      const upd = (patch) => run(sb.from('organization_settings').update(patch).eq('id', 1));
      switch (form.dataset.save) {
        case 'org':
          if (!v.org_name.trim()) throw new Error('Enter the organization name.');
          await upd({ org_name: v.org_name.trim(), org_phone: v.org_phone || null, org_email: v.org_email || null, org_address: v.org_address || null, time_zone: v.time_zone });
          break;
        case 'sched':
          await upd({ default_pickup_time: v.default_pickup_time || '10:00',
            default_wash_days: intIn(v, 'default_wash_days', 0, 30, 'Days until washing'),
            default_return_days: intIn(v, 'default_return_days', 0, 60, 'Days until return'),
            planning_window_days: intIn(v, 'planning_window_days', 1, 180, 'Planning window'),
            min_minutes_between_tasks: intIn(v, 'min_minutes_between_tasks', 0, 600, 'Minutes between tasks'),
            overdue_grace_minutes: intIn(v, 'overdue_grace_minutes', 0, 1440, 'Overdue minutes'),
            upcoming_notice_hours: intIn(v, 'upcoming_notice_hours', 0, 168, 'Reminder hours') });
          rpc('generate_recurring_orders').catch(() => {});
          break;
        case 'disc':
          await upd({ flag_collection_vs_expected: !!v.flag_collection_vs_expected, require_discrepancy_resolution: !!v.require_discrepancy_resolution });
          break;
        case 'notif': await upd({ notify_kinds: v.notify_kinds || [] }); break;
        case 'labels': {
          const st = {}; const tt = {};
          for (const k of ORDER_STATUSES) if (v['st_' + k]?.trim()) st[k] = v['st_' + k].trim();
          for (const k of TASK_TYPES) if (v['tt_' + k]?.trim()) tt[k] = v['tt_' + k].trim();
          await upd({ status_labels: st, task_type_labels: tt });
          break;
        }
        case 'reasons':
          if (!lines(v.cancellation_reasons).length || !lines(v.correction_reasons).length) throw new Error('Keep at least one reason in each list.');
          await upd({ cancellation_reasons: lines(v.cancellation_reasons), correction_reasons: lines(v.correction_reasons) });
          break;
        case 'cats': {
          const cats = await run(sb.from('client_categories').select('*'));
          for (const c of cats) {
            const label = (v['label_' + c.id] || '').trim();
            if (!label) throw new Error('Category labels cannot be empty.');
            await run(sb.from('client_categories').update({ label, sort_order: Number(v['sort_' + c.id]) || 0,
              default_pickup_address: v['addr_' + c.id] || null, default_pickup_note: v['note_' + c.id] || null,
              active: !!v['active_' + c.id] }).eq('id', c.id));
          }
          if (v.new_label?.trim()) {
            const id = v.new_label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'cat_' + Date.now();
            await run(sb.from('client_categories').insert({ id, label: v.new_label.trim(), sort_order: cats.length + 1 }));
          }
          await loadCategories(true);
          break;
        }
        case 'invite':
          await rpc('invite_user', { p_email: v.email, p_roles: v.roles || [], p_person_id: v.person_id || null, p_full_name: v.full_name || null });
          break;
      }
      await loadContext();
      toast('Saved.');
      await draw();
      const sec = form.dataset.save === 'invite' ? 'users' : form.dataset.save;
      root.querySelector('#' + sec)?.setAttribute('open', '');
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  on(root, 'click', '[data-user-save]', async (e, el) => {
    const tr = el.closest('tr');
    const roles = [...tr.querySelectorAll('input[name=role]:checked')].map((x) => x.value);
    const person = tr.querySelector('select[name=person]').value || null;
    const active = tr.querySelector('input[name=active]').checked;
    el.disabled = true;
    try {
      const u = (await run(sb.from('profiles').select('*').eq('id', el.dataset.userSave).single()));
      if ((u.person_id || null) !== person) await run(sb.from('profiles').update({ person_id: person }).eq('id', u.id));
      await rpc('set_user_roles', { p_user_id: u.id, p_roles: roles, p_reason: null });
      if (u.active !== active) await rpc('set_user_active', { p_user_id: u.id, p_active: active });
      toast('User saved.');
      await draw(); root.querySelector('#users')?.setAttribute('open', '');
    } catch (err) { toast(err.message, 'error'); el.disabled = false; }
  });

  on(root, 'click', '[data-revoke]', async (e, el) => {
    const ok = await confirmAction({ title: 'Revoke invitation?', message: `${el.dataset.revoke} will no longer be able to create an account.`, confirmLabel: 'Revoke', danger: true });
    if (!ok) return;
    try {
      await run(sb.from('invites').delete().eq('email', el.dataset.revoke));
      toast('Invitation revoked.');
      await draw(); root.querySelector('#users')?.setAttribute('open', '');
    } catch (err) { toast(err.message, 'error'); }
  });

  on(root, 'click', '[data-action=reload]', () => draw().catch((e) => setHtml(root, errorState(e))));
  try { await draw(); } catch (err) { setHtml(root, errorState(err)); }
}
