// Pure formatting / time-zone helpers. No DOM, no network — unit tested in tests/unit.

export const ORDER_STATUSES = [
  'requested', 'scheduled', 'pickup_in_progress', 'awaiting_dropoff', 'awaiting_washing',
  'washing_in_progress', 'ready_for_return', 'return_collection_in_progress',
  'out_for_delivery', 'completed', 'exception', 'cancelled',
];

export const DEFAULT_STATUS_LABELS = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  pickup_in_progress: 'Pickup in progress',
  awaiting_dropoff: 'Awaiting drop-off',
  awaiting_washing: 'Awaiting washing',
  washing_in_progress: 'Washing in progress',
  ready_for_return: 'Ready for return collection',
  return_collection_in_progress: 'Return collection in progress',
  out_for_delivery: 'Out for delivery',
  completed: 'Returned / Completed',
  exception: 'Exception',
  cancelled: 'Cancelled',
};

export const STATUS_TONE = {
  requested: 'neutral', scheduled: 'info', pickup_in_progress: 'progress', awaiting_dropoff: 'progress',
  awaiting_washing: 'wait', washing_in_progress: 'progress', ready_for_return: 'wait',
  return_collection_in_progress: 'progress', out_for_delivery: 'progress', completed: 'done',
  exception: 'danger', cancelled: 'muted',
};

export const TASK_TYPES = ['pickup', 'dropoff', 'washing', 'return_collection', 'delivery'];

export const DEFAULT_TASK_LABELS = {
  pickup: 'Pickup from client',
  dropoff: 'Drop-off to washer',
  washing: 'Washing',
  return_collection: 'Return collection',
  delivery: 'Final delivery',
};

export const TASK_STATUS_LABELS = {
  pending: 'Not started', in_progress: 'In progress', completed: 'Done', cancelled: 'Cancelled',
};

export const EVENT_LABELS = {
  task_started: 'Started',
  collected_from_client: 'Collected from client',
  delivered_to_washer: 'Delivered to washer',
  received_by_washer: 'Receipt confirmed by washer',
  wash_started: 'Washing started',
  wash_completed: 'Washing completed — ready for collection',
  collected_from_washer: 'Collected from washer',
  delivered_to_recipient: 'Delivered to recipient',
  count_correction: 'Bag count corrected',
  event_reverted: 'Step undone',
};

// What a person does next on a task, in order.
export function nextActions(taskType, taskStatus, washingReceived) {
  if (taskStatus === 'completed' || taskStatus === 'cancelled') return [];
  switch (taskType) {
    case 'pickup': return taskStatus === 'pending'
      ? [{ event: 'task_started', label: 'On my way', count: false }, { event: 'collected_from_client', label: 'Bags collected', count: true }]
      : [{ event: 'collected_from_client', label: 'Bags collected', count: true }];
    case 'dropoff': return taskStatus === 'pending'
      ? [{ event: 'task_started', label: 'On my way', count: false }, { event: 'delivered_to_washer', label: 'Delivered to washer', count: true }]
      : [{ event: 'delivered_to_washer', label: 'Delivered to washer', count: true }];
    case 'washing':
      if (!washingReceived) return [{ event: 'received_by_washer', label: 'Bags received', count: true }];
      return taskStatus === 'in_progress'
        ? [{ event: 'wash_started', label: 'Washing started', count: false }, { event: 'wash_completed', label: 'Washed — ready for pickup', count: true }]
        : [{ event: 'wash_completed', label: 'Washed — ready for pickup', count: true }];
    case 'return_collection': return taskStatus === 'pending'
      ? [{ event: 'task_started', label: 'On my way', count: false }, { event: 'collected_from_washer', label: 'Collected from washer', count: true }]
      : [{ event: 'collected_from_washer', label: 'Collected from washer', count: true }];
    case 'delivery': return taskStatus === 'pending'
      ? [{ event: 'task_started', label: 'On my way', count: false }, { event: 'delivered_to_recipient', label: 'Delivered', count: true }]
      : [{ event: 'delivered_to_recipient', label: 'Delivered', count: true }];
    default: return [];
  }
}

export function statusLabel(status, settings) {
  return (settings && settings.status_labels && settings.status_labels[status]) || DEFAULT_STATUS_LABELS[status] || status;
}

export function taskLabel(type, settings) {
  return (settings && settings.task_type_labels && settings.task_type_labels[type]) || DEFAULT_TASK_LABELS[type] || type;
}

export function orderNo(n) { return n == null ? '' : `K-${n}`; }
export function clientNo(n) { return n == null ? '' : `C-${String(n).padStart(4, '0')}`; }
export function personNo(n) { return n == null ? '' : `P-${String(n).padStart(4, '0')}`; }

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------
// Time zones. All timestamps are stored in UTC; everything is shown and
// entered in the organization time zone (Settings → Time zone).
// ------------------------------------------------------------------

function partsInTz(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour === 24 ? 0 : +out.hour, minute: +out.minute, second: +out.second,
  };
}

// Offset (ms) of tz from UTC at the given instant.
export function tzOffsetMs(date, tz) {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

// 'YYYY-MM-DD' + 'HH:MM' wall-clock in tz → Date (UTC instant)
export function zonedToDate(dateStr, timeStr, tz) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  let off = tzOffsetMs(new Date(guess), tz);
  let result = guess - off;
  const off2 = tzOffsetMs(new Date(result), tz);
  if (off2 !== off) result = guess - off2;
  return new Date(result);
}

// Date/ISO → { date: 'YYYY-MM-DD', time: 'HH:MM' } in tz
export function dateToZonedParts(value, tz) {
  if (!value) return { date: '', time: '' };
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return { date: '', time: '' };
  const p = partsInTz(d, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

export function todayInTz(tz, now = new Date()) { return dateToZonedParts(now, tz).date; }

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(dateStr) { return addDays(dateStr, -weekdayOf(dateStr)); }

export function startOfMonth(dateStr) { return dateStr.slice(0, 8) + '01'; }

export function daysInMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function fmtDateTime(value, tz, opts = {}) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: opts.weekday === false ? undefined : 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', ...(opts.year ? { year: 'numeric' } : {}),
  }).format(d);
}

export function fmtTime(value, tz) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export function fmtDate(value, tz) {
  if (!value) return '—';
  // plain 'YYYY-MM-DD' dates are calendar dates, not instants
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value));
}

export function relativeTime(value, now = new Date()) {
  if (!value) return '';
  const diff = (new Date(value).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------
export function parseBagCount(raw, { allowEmpty = false, max = 500 } = {}) {
  const s = String(raw ?? '').trim();
  if (s === '') return allowEmpty ? { ok: true, value: null } : { ok: false, error: 'Enter the number of bags.' };
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Bag count must be a whole number (0 or more).' };
  const n = Number(s);
  if (n > max) return { ok: false, error: `Bag count cannot be more than ${max}.` };
  return { ok: true, value: n };
}

export function normalizePhone(p) { return String(p || '').replace(/\D/g, ''); }

// Possible duplicate clients: same phone digits, or very similar names / addresses.
export function findPossibleDuplicates(candidate, clients) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = norm(candidate.name);
  const phone = normalizePhone(candidate.phone);
  const addr = norm(candidate.pickup_address);
  return clients.filter((c) => {
    if (candidate.id && c.id === candidate.id) return false;
    if (phone.length >= 7 && normalizePhone(c.phone).endsWith(phone.slice(-7))) return true;
    if (name.length >= 3 && norm(c.name) === name) return true;
    if (addr.length >= 6 && norm(c.pickup_address) === addr) return true;
    return false;
  });
}

// ------------------------------------------------------------------
// Friendly error messages from database errors
// ------------------------------------------------------------------
export function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  const msg = String(err.message || err.error_description || err.msg || err);
  const m = msg.match(/KVISA_[A-Z_]+:\s*(.*)$/s);
  if (m) {
    const text = m[1].trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  if (/Database error saving new user/i.test(msg) || /KVISA_NOT_INVITED/.test(msg)) {
    return 'This email has not been invited yet. Ask an administrator to invite you first.';
  }
  if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox for the link.';
  if (/permission denied|42501|row-level security/i.test(msg)) return 'You do not have permission to do that.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
  if (/JWT expired/i.test(msg)) return 'Your session expired. Please sign in again.';
  if (/duplicate key/i.test(msg)) return 'That record already exists.';
  return msg;
}
