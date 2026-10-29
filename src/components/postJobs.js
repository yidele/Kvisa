// "Post jobs": number the open driver stages and post them to the WhatsApp group and/or by SMS.
// Drivers reply privately with a number; the server does the rest (see migration 011).
import { sb, rpc, run, tz, settings, messaging } from '../lib/api.js';
import { html, raw, setHtml, $, on } from '../lib/dom.js';
import { openModal, toast } from './ui.js';
import { taskLabel, orderNo, fmtDateTime } from '../lib/format.js';

const READY = ['not_dispatched', 'declined', 'expired', 'cancelled'];

export async function postJobsModal() {
  const s = settings();
  const disp = await run(sb.from('task_dispatch').select('*').is('assignee_id', null).is('blocked_reason', null).in('dispatch_status', READY));
  const ready = new Set(disp.filter((d) => !d.assignee_id && !d.blocked_reason && READY.includes(d.dispatch_status)).map((d) => d.task_id));
  const cal = ready.size ? await run(sb.from('task_calendar').select('*').in('task_id', [...ready])) : [];
  const jobs = cal.filter((c) => ready.has(c.task_id) && c.order_status !== 'cancelled' && c.task_status === 'pending')
    .sort((a, b) => String(a.scheduled_at || '9').localeCompare(String(b.scheduled_at || '9')) || a.order_no - b.order_no);
  const waReady = s.wa_enabled && s.wa_group_id;
  const smsReady = s.sms_enabled;
  const minuteOpts = [['', 'No time limit'], ['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['720', '12 hours'], ['1440', '24 hours']];
  const def = String(s.default_offer_minutes ?? '');
  if (def && !minuteOpts.find((o) => o[0] === def)) minuteOpts.push([def, `${def} minutes`]);

  const body = jobs.length ? html`
    <fieldset class="field"><legend>Jobs to post (${jobs.length} ready)</legend>
      <div class="post-jobs">${jobs.map((j) => html`<label class="check">
        <input type="checkbox" name="task" value="${j.task_id}" checked>
        <span><strong>${orderNo(j.order_no)}</strong> · ${taskLabel(j.task_type, s)} · ${j.client_name}
          <small class="muted">${j.scheduled_at ? fmtDateTime(j.scheduled_at, tz()) : 'No time set'} · ${j.expected_bags ?? '?'} bags</small></span></label>`)}</div>
    </fieldset>
    <label class="field"><span>First line of the message</span>
      <textarea name="intro" rows="2" maxlength="500">${s.msg_post_intro || ''}</textarea></label>
    <fieldset class="field"><legend>Post to</legend>
      <label class="check"><input type="checkbox" name="ch_whatsapp" ${waReady ? raw('checked') : raw('disabled')}>
        <span>WhatsApp group${s.wa_group_name ? html` <strong>${s.wa_group_name}</strong>` : ''}
        ${waReady ? '' : html`<small class="muted">— not set up (Settings → WhatsApp & text messages)</small>`}</span></label>
      <label class="check"><input type="checkbox" name="ch_sms" ${smsReady ? raw('checked') : raw('disabled')}>
        <span>Text message (SMS) to each driver
        ${smsReady ? '' : html`<small class="muted">— not set up (Settings → WhatsApp & text messages)</small>`}</span></label>
      <small class="hint">Untick both to offer the jobs in the app only.</small>
    </fieldset>
    <label class="field"><span>Jobs stay open for</span><select name="minutes">
      ${minuteOpts.map(([v, l]) => html`<option value="${v}" ${def === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <div class="field"><span>Message preview</span><pre class="msg-preview" data-preview aria-live="polite">…</pre>
      <small class="hint">Street names only. The full address goes privately to the driver who takes the job.</small></div>`
    : html`<p>No jobs are ready to post right now.</p>
      <p class="muted">A stage shows up here when it is unassigned and ready: pickups need a washing volunteer first,
        returns need washing to be finished.</p>`;

  return openModal({
    title: 'Post jobs', body, wide: true, submitLabel: 'Post', hideSubmit: !jobs.length, guardUnsaved: false,
    onMount(form) {
      if (!jobs.length) return;
      let timer = null; let seq = 0;
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const box = $('[data-preview]', form);
          const ids = [...form.querySelectorAll('input[name=task]:checked')].map((x) => x.value);
          if (!ids.length) { box.textContent = 'Choose at least one job.'; return; }
          const my = ++seq;
          try {
            const pv = await rpc('job_post_preview', { p_task_ids: ids, p_intro: form.intro.value || null });
            if (my === seq) box.textContent = pv?.body || '';
          } catch (err) { if (my === seq) box.textContent = err.message; }
        }, 250);
      };
      on(form, 'change', 'input[name=task]', refresh);
      on(form, 'input', 'textarea[name=intro]', refresh);
      refresh();
    },
    async onSubmit(v, form) {
      const ids = [...form.querySelectorAll('input[name=task]:checked')].map((x) => x.value);
      if (!ids.length) throw new Error('Choose at least one job.');
      const channels = [v.ch_whatsapp && 'whatsapp', v.ch_sms && 'sms'].filter(Boolean);
      const r = await rpc('post_jobs', { p_task_ids: ids, p_intro: v.intro || null, p_channels: channels,
        p_expires_minutes: v.minutes ? Number(v.minutes) : null });
      const where = [r.whatsapp && 'the WhatsApp group', r.sms && `${r.sms} driver${r.sms === 1 ? '' : 's'} by text`].filter(Boolean);
      const nums = r.first_no === r.last_no ? `job ${r.first_no}` : `jobs ${r.first_no}–${r.last_no}`;
      if (!where.length) { toast(`Offered ${nums} in the app.`); return true; }
      try {
        const sent = await messaging('send');
        if (sent?.failed) toast(`Posted ${nums}, but ${sent.failed} message(s) failed. See Messages.`, 'warn');
        else toast(`Posted ${nums} to ${where.join(' and ')}.`);
      } catch (err) {
        toast(`Saved ${nums}, but sending failed: ${err.message}. See Messages to retry.`, 'error');
      }
      return true;
    },
  });
}
