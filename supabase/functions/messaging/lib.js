// Pure helpers for the messaging Edge Function (no Deno or Node APIs, so they run under
// `node --test` too). Providers: Whapi.Cloud for WhatsApp, Twilio for SMS.

// ---------------- incoming ----------------

// Whapi "messages" webhook → private text messages from other people.
// Group chats, our own messages and non-text messages are skipped.
export function parseWhapiWebhook(payload) {
  const out = [];
  for (const m of payload?.messages || []) {
    if (!m || m.from_me) continue;
    const chat = String(m.chat_id || '');
    // private chats only: skip groups, channels and status updates. A sender hidden behind a
    // WhatsApp "@lid" id still comes through, and is logged as an unknown sender.
    if (!chat || /@(g\.us|newsletter|broadcast)$/.test(chat)) continue;
    const body = m.type === 'text' ? m.text?.body : m.type === 'reply' ? (m.reply?.buttons_reply?.title ?? m.text?.body) : null;
    if (typeof body !== 'string' || !body.trim()) continue;
    const from = String(m.from || chat.split('@')[0]).replace(/\D/g, '');
    if (!from || !m.id) continue;
    out.push({ from, body: body.slice(0, 2000), id: String(m.id) });
  }
  return out;
}

// Twilio inbound SMS (form fields) → { from, body, id }
export function parseTwilioForm(params) {
  const from = params.get('From'); const id = params.get('MessageSid') || params.get('SmsSid');
  if (!from || !id) return null;
  return { from, body: (params.get('Body') || '').slice(0, 2000), id };
}

// Twilio request signature: base64(HMAC-SHA1(authToken, url + each POST key+value sorted by key)).
export async function twilioSignature(authToken, url, params) {
  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function safeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------- outgoing ----------------

// Whapi: POST /messages/text { to, body, mentions? }. A group id is used as-is ("…@g.us");
// a person is their number in digits. Mentions are numbers without "+", and the body must
// contain "@<number>" for each, which WhatsApp shows as the person's name.
export function whapiSendRequest(row, { token, apiUrl = 'https://gate.whapi.cloud' }) {
  const body = { to: row.to_address, body: row.body };
  if (row.mentions?.length) body.mentions = row.mentions;
  return {
    url: apiUrl.replace(/\/+$/, '') + '/messages/text',
    init: { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
  };
}

// Twilio: POST /Accounts/{sid}/Messages.json  To, Body and From (a number) or MessagingServiceSid.
export function twilioSendRequest(row, { accountSid, authToken, from }) {
  const form = new URLSearchParams({ To: '+' + String(row.to_address).replace(/\D/g, ''), Body: row.body });
  if (/^MG[0-9a-f]{32}$/i.test(from || '')) form.set('MessagingServiceSid', from); else form.set('From', from);
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    init: { method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
  };
}

// Twilio refuses bodies over 1600 characters: split long posts at line breaks (then spaces).
export function splitSms(body, max = 1500) {
  const parts = [];
  let rest = String(body);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

// Provider response → { ok, id, error }
export async function readSendResult(channel, res) {
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || data?.error || text || res.statusText;
    return { ok: false, error: `HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 900) };
  }
  if (channel === 'whatsapp') {
    if (data && data.sent === false) return { ok: false, error: 'WhatsApp did not accept the message' };
    return { ok: true, id: data?.message?.id || data?.id || null };
  }
  return { ok: true, id: data?.sid || null };
}

// Whapi GET /groups → [{ id, name }]
export function parseGroups(data) {
  return (data?.groups || []).filter((g) => g?.id).map((g) => ({ id: String(g.id), name: String(g.name || g.subject || g.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
