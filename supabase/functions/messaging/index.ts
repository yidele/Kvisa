// Kvisa messaging: sends queued WhatsApp/SMS messages and receives private replies.
//
//   POST …/messaging?hook=whatsapp&secret=…   Whapi.Cloud webhook (incoming WhatsApp)
//   POST …/messaging?hook=sms&secret=…        Twilio webhook (incoming SMS, signature checked)
//   POST …/messaging  { action }              from the app, signed in as admin/dispatcher:
//        send   – deliver everything waiting in message_outbox
//        status – which providers are connected
//        groups – list the WhatsApp groups of the connected number (admin)
//
// Deploy with JWT verification OFF (webhooks carry no Supabase token); every route checks
// its own credentials. Secrets: see docs/OPERATIONS.md §8.
import {
  parseWhapiWebhook, parseTwilioForm, twilioSignature, safeEqual,
  whapiSendRequest, twilioSendRequest, readSendResult, parseGroups, splitSms,
} from './lib.js';

const env = (k: string) => Deno.env.get(k) || '';
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const WEBHOOK_SECRET = env('MESSAGING_WEBHOOK_SECRET');
const PUBLIC_URL = env('MESSAGING_PUBLIC_URL') || `${SUPABASE_URL}/functions/v1/messaging`;
const WHAPI = { token: env('WHAPI_TOKEN'), apiUrl: env('WHAPI_API_URL') || 'https://gate.whapi.cloud' };
const TWILIO = { accountSid: env('TWILIO_ACCOUNT_SID'), authToken: env('TWILIO_AUTH_TOKEN'), from: env('TWILIO_FROM') };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function db(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------- sending ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendOne(row: any) {
  if (row.channel === 'whatsapp') {
    if (!WHAPI.token) return { ok: false, error: 'WhatsApp is not connected (WHAPI_TOKEN is not set)' };
    const { url, init } = whapiSendRequest(row, WHAPI);
    return readSendResult('whatsapp', await fetch(url, init));
  }
  if (!TWILIO.accountSid || !TWILIO.authToken || !TWILIO.from) return { ok: false, error: 'SMS is not connected (Twilio secrets are not set)' };
  let first: { ok: boolean; id?: string | null; error?: string } | null = null;
  for (const part of splitSms(row.body)) {
    const { url, init } = twilioSendRequest({ ...row, body: part }, TWILIO);
    const r = await readSendResult('sms', await fetch(url, init));
    if (!r.ok) return r;
    first ??= r;
  }
  return first ?? { ok: false, error: 'Empty message' };
}

async function flush() {
  const rows = (await db('outbox_claim', { p_limit: 100 })) || [];
  let sent = 0, failed = 0;
  for (const row of rows) {
    let r: { ok: boolean; id?: string | null; error?: string };
    try { r = await sendOne(row); } catch (e) { r = { ok: false, error: String((e as Error)?.message || e) }; }
    await db('outbox_finish', { p_id: row.id, p_ok: r.ok, p_provider_id: r.id ?? null, p_error: r.error ?? null });
    r.ok ? sent++ : failed++;
    if (row.channel === 'whatsapp') await sleep(400);   // keep WhatsApp traffic human-paced
  }
  return { sent, failed };
}

// ---------------- incoming ----------------
async function handleWhatsApp(req: Request) {
  const payload = await req.json().catch(() => null);
  for (const m of parseWhapiWebhook(payload)) {
    await db('message_inbound', { p_channel: 'whatsapp', p_from: m.from, p_body: m.body, p_provider_id: m.id });
  }
  await flush();
  return json({ ok: true });
}

async function handleSms(req: Request, url: URL) {
  const params = new URLSearchParams(await req.text());
  const expected = await twilioSignature(TWILIO.authToken, `${PUBLIC_URL}${url.search}`, params);
  if (!TWILIO.authToken || !safeEqual(req.headers.get('X-Twilio-Signature'), expected)) return new Response('Forbidden', { status: 403 });
  const m = parseTwilioForm(params);
  if (m) await db('message_inbound', { p_channel: 'sms', p_from: m.from, p_body: m.body, p_provider_id: m.id });
  await flush();
  return new Response('<Response></Response>', { headers: { 'Content-Type': 'text/xml' } });
}

// ---------------- from the app ----------------
async function staffContext(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_context`, {
    method: 'POST', headers: { apikey: ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!res.ok) return null;
  const ctx = await res.json();
  return ctx && ctx.active && (ctx.roles || []).some((r: string) => r === 'admin' || r === 'dispatcher') ? ctx : null;
}

async function handleApp(req: Request) {
  const ctx = await staffContext(req);
  if (!ctx) return json({ error: 'Only administrators and dispatchers can do this.' }, 403);
  const { action } = await req.json().catch(() => ({}));
  if (action === 'send') return json(await flush());
  if (action === 'status') return json({ whatsapp: !!WHAPI.token, sms: !!(TWILIO.accountSid && TWILIO.authToken && TWILIO.from), webhook: !!WEBHOOK_SECRET });
  if (action === 'groups') {
    if (!ctx.roles.includes('admin')) return json({ error: 'Only administrators can do this.' }, 403);
    if (!WHAPI.token) return json({ error: 'WhatsApp is not connected yet (WHAPI_TOKEN is not set).' }, 400);
    const res = await fetch(`${WHAPI.apiUrl.replace(/\/+$/, '')}/groups?count=500`, { headers: { Authorization: `Bearer ${WHAPI.token}`, Accept: 'application/json' } });
    if (!res.ok) return json({ error: `WhatsApp said: HTTP ${res.status}` }, 502);
    return json({ groups: parseGroups(await res.json()) });
  }
  return json({ error: 'Unknown action' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const hook = url.searchParams.get('hook');
  try {
    if (hook) {
      if (!WEBHOOK_SECRET || !safeEqual(url.searchParams.get('secret'), WEBHOOK_SECRET)) return new Response('Forbidden', { status: 403 });
      if (hook === 'whatsapp') return await handleWhatsApp(req);
      if (hook === 'sms') return await handleSms(req, url);
      return new Response('Not found', { status: 404 });
    }
    return await handleApp(req);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Check the function logs.' }, 500);
  }
});
