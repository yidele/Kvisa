// Unit tests for the messaging Edge Function helpers (WhatsApp via Whapi, SMS via Twilio).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWhapiWebhook, parseTwilioForm, twilioSignature, safeEqual,
  whapiSendRequest, twilioSendRequest, readSendResult, parseGroups, splitSms, verifyTwilioRequest, isTwilioOptOut,
  classifyTwilioResponse, sendSmsParts,
} from '../../supabase/functions/messaging/lib.js';

test('WhatsApp webhook: only private text messages from other people', () => {
  const got = parseWhapiWebhook({
    messages: [
      { id: 'a1', from_me: false, type: 'text', chat_id: '17185550101@s.whatsapp.net', from: '17185550101', text: { body: '2' } },
      { id: 'a2', from_me: true, type: 'text', chat_id: '17185550101@s.whatsapp.net', from: '17185550000', text: { body: 'Job 2 is yours' } },
      { id: 'a3', from_me: false, type: 'text', chat_id: '120363000000000001@g.us', from: '17185550102', text: { body: '3' } },
      { id: 'a4', from_me: false, type: 'image', chat_id: '17185550103@s.whatsapp.net', from: '17185550103', image: {} },
      { id: 'a5', from_me: false, type: 'text', chat_id: '17185550104@s.whatsapp.net', from: '17185550104', text: { body: '   ' } },
      { id: 'a6', from_me: false, type: 'text', chat_id: '123456789@lid', from: '123456789', text: { body: 'done' } },
    ],
  });
  assert.deepEqual(got, [
    { from: '17185550101', body: '2', id: 'a1' },
    { from: '123456789', body: 'done', id: 'a6' },
  ]);
  assert.deepEqual(parseWhapiWebhook(null), []);
  assert.deepEqual(parseWhapiWebhook({ statuses: [{ id: 'x' }] }), []);
});

test('SMS webhook fields', () => {
  const p = new URLSearchParams({ From: '+17185550101', Body: 'Done', MessageSid: 'SM123' });
  assert.deepEqual(parseTwilioForm(p), { from: '+17185550101', body: 'Done', id: 'SM123' });
  assert.equal(parseTwilioForm(new URLSearchParams({ Body: 'x' })), null);
});

test('Twilio signature matches the documented example', async () => {
  const params = new URLSearchParams({ CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' });
  const sig = await twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params);
  assert.equal(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.ok(safeEqual(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!safeEqual(sig, '0/KCTR6DLpKmkAf8muzZqo1nDgQ'));
  assert.ok(!safeEqual('', ''));
  assert.ok(!safeEqual(null, null));
});

test('WhatsApp send: group post with a tagged driver', () => {
  const { url, init } = whapiSendRequest(
    { to_address: '120363000000000001@g.us', body: '2 covered @17185550101', mentions: ['17185550101'] },
    { token: 'tok', apiUrl: 'https://gate.whapi.cloud/' });
  assert.equal(url, 'https://gate.whapi.cloud/messages/text');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(init.body), { to: '120363000000000001@g.us', body: '2 covered @17185550101', mentions: ['17185550101'] });
  const plain = whapiSendRequest({ to_address: '17185550101', body: 'hi', mentions: [] }, { token: 't' });
  assert.deepEqual(JSON.parse(plain.init.body), { to: '17185550101', body: 'hi' });
});

test('SMS send: number or messaging service', () => {
  const a = twilioSendRequest({ to_address: '17185550101', body: 'Job 1' }, { accountSid: 'AC1', authToken: 'secret', from: '+15550001111' });
  assert.equal(a.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
  assert.equal(a.init.headers.Authorization, 'Basic ' + btoa('AC1:secret'));
  const form = new URLSearchParams(a.init.body);
  assert.equal(form.get('To'), '+17185550101');
  assert.equal(form.get('From'), '+15550001111');
  assert.equal(form.get('Body'), 'Job 1');
  const b = twilioSendRequest({ to_address: '17185550101', body: 'x' }, { accountSid: 'AC1', authToken: 's', from: 'MG' + 'a'.repeat(32) });
  assert.equal(new URLSearchParams(b.init.body).get('MessagingServiceSid'), 'MG' + 'a'.repeat(32));
  assert.equal(new URLSearchParams(b.init.body).get('From'), null);
});

test('provider responses become sent / failed', async () => {
  const r = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  assert.deepEqual(await readSendResult('whatsapp', r(200, { sent: true, message: { id: 'wamid.1' } })), { ok: true, id: 'wamid.1' });
  assert.deepEqual(await readSendResult('whatsapp', r(200, { sent: false })), { ok: false, error: 'WhatsApp did not accept the message' });
  assert.deepEqual(await readSendResult('sms', r(201, { sid: 'SM1' })), { ok: true, id: 'SM1' });
  const bad = await readSendResult('sms', r(400, { code: 21608, message: 'The number is unverified. Trial accounts cannot send messages to unverified numbers' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^HTTP 400: The number is unverified/);
  assert.match((await readSendResult('whatsapp', r(401, 'Unauthorized'))).error, /^HTTP 401: Unauthorized/);
});

test('group list for the settings picker', () => {
  assert.deepEqual(parseGroups({ groups: [{ id: '2@g.us', name: 'Volunteers' }, { id: '1@g.us', name: 'Drivers' }, { name: 'no id' }] }),
    [{ id: '1@g.us', name: 'Drivers' }, { id: '2@g.us', name: 'Volunteers' }]);
  assert.deepEqual(parseGroups(null), []);
});

test('long texts are split at line breaks under the SMS limit', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}. Pickup from client — Main Street → Maple Avenue — Tue Oct 30, 10:00 AM — 4 bags`);
  const body = 'Jobs available:\n\n' + lines.join('\n');
  const parts = splitSms(body);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(parts.join('\n').replace(/\s+/g, ' '), body.replace(/\s+/g, ' '));
  assert.ok(parts.slice(1).every((p) => /^\d+\. Pickup/.test(p)), 'each part starts on a whole job line');
  assert.deepEqual(splitSms('short'), ['short']);
  assert.ok(splitSms('x'.repeat(3200)).every((p) => p.length <= 1500));
});

test('SMS webhook is accepted only with a valid signature for our account', async () => {
  const cfg = { authToken: 'synthetic-token', accountSid: 'AC00000000000000000000000000000000', publicUrl: 'https://example.test/functions/v1/messaging' };
  const search = '?hook=sms&secret=x';
  const params = new URLSearchParams({ AccountSid: cfg.accountSid, From: '+12125550141', Body: 'JOIN 123456', MessageSid: 'SM1' });
  const good = await twilioSignature(cfg.authToken, cfg.publicUrl + search, params);
  assert.equal(await verifyTwilioRequest(cfg, search, params, good), true);
  assert.equal(await verifyTwilioRequest(cfg, search, params, null), false, 'missing signature');
  assert.equal(await verifyTwilioRequest(cfg, '?hook=sms&secret=y', params, good), false, 'different URL');
  const tampered = new URLSearchParams(params); tampered.set('Body', 'STOP');
  assert.equal(await verifyTwilioRequest(cfg, search, tampered, good), false, 'tampered body');
  const otherAcct = new URLSearchParams(params); otherAcct.set('AccountSid', 'AC11111111111111111111111111111111');
  const otherSig = await twilioSignature(cfg.authToken, cfg.publicUrl + search, otherAcct);
  assert.equal(await verifyTwilioRequest(cfg, search, otherAcct, otherSig), false, 'another account');
  assert.equal(await verifyTwilioRequest({ ...cfg, authToken: '' }, search, params, good), false, 'no auth token configured');
  assert.equal(await verifyTwilioRequest({ ...cfg, accountSid: '' }, search, params, good), false, 'no account configured');
});

test('Twilio opt-out refusal (21610) is recognised', async () => {
  const r = await readSendResult('sms', new Response(JSON.stringify({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }), { status: 400 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 21610);
  assert.equal(isTwilioOptOut(r), true);
  assert.equal(isTwilioOptOut({ ok: false, code: 21608 }), false);
  assert.equal(isTwilioOptOut({ ok: true, id: 'SM1' }), false);
});

// ---- per-part sending (synthetic; fake database + fake Twilio) ----
const longBody = Array.from({ length: 50 }, (_, i) => `${i + 1}. Synthetic pickup line — Main St → Maple Ave — Tue 10:00 AM — 2 bags`).join('\n');
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function harness(beginAnswers, twilioAnswers) {
  const log = { begin: [], sent: [], finish: [] };
  return {
    log,
    deps: {
      begin: async (n, count) => { log.begin.push([n, count]); return beginAnswers.shift() ?? 'send'; },
      send: async (text) => { log.sent.push(text); const a = twilioAnswers.shift(); if (a instanceof Error) throw a; return a; },
      finish: async (n, outcome, id, error) => { log.finish.push([n, outcome, id]); },
    },
  };
}

test('Twilio answers are classified without guessing', async () => {
  assert.deepEqual(await classifyTwilioResponse(reply(201, { sid: 'SM1' })), { outcome: 'accepted', id: 'SM1' });
  assert.equal((await classifyTwilioResponse(reply(200, { status: 'queued' }))).outcome, 'unknown', '2xx without SID');
  assert.equal((await classifyTwilioResponse(reply(200, 'not json'))).outcome, 'unknown');
  assert.equal((await classifyTwilioResponse(reply(500, 'oops'))).outcome, 'unknown');
  assert.equal((await classifyTwilioResponse(reply(503, 'busy'))).outcome, 'unknown');
  assert.equal((await classifyTwilioResponse(reply(408, 'timeout'))).outcome, 'unknown');
  const refused = await classifyTwilioResponse(reply(400, { code: 21610, message: 'unsubscribed' }));
  assert.equal(refused.outcome, 'failed'); assert.equal(refused.code, 21610);
  assert.equal((await classifyTwilioResponse(reply(429, { code: 20429, message: 'Too Many Requests' }))).outcome, 'failed');
});

test('STOP between parts: the database refuses part 2, so only part 1 reaches Twilio', async () => {
  assert.ok(splitSms(longBody).length >= 3);
  const h = harness(['send', 'stop:the recipient opted out'], [reply(201, { sid: 'SM1' })]);
  const r = await sendSmsParts({ body: longBody }, h.deps);
  assert.deepEqual(r, { settled: true, stopped: 'stop:the recipient opted out' });
  assert.equal(h.log.sent.length, 1);
  assert.deepEqual(h.log.begin.map((b) => b[0]), [1, 2], 'asked before each part');
  assert.deepEqual(h.log.finish, [[1, 'accepted', 'SM1']]);
});

test('Part 1 accepted, part 2 refused → message fails; the retry skips part 1 and sends part 2 only', async () => {
  const count = splitSms(longBody).length;
  const h1 = harness([], [reply(201, { sid: 'SM1' }), reply(400, { code: 21211, message: 'synthetic refusal' })]);
  const r1 = await sendSmsParts({ body: longBody }, h1.deps);
  assert.equal(r1.ok, false); assert.equal(r1.code, 21211);
  assert.deepEqual(h1.log.finish.map((f) => f[1]), ['accepted', 'failed']);
  assert.equal(h1.log.sent.length, 2, 'stops after the refused part');
  const parts = splitSms(longBody);
  const h2 = harness(['skip', ...Array(count - 1).fill('send')], parts.slice(1).map((_, i) => reply(201, { sid: 'SMr' + i })));
  const r2 = await sendSmsParts({ body: longBody }, h2.deps);
  assert.equal(r2.ok, true);
  assert.equal(h2.log.sent[0], parts[1], 'retry starts with part 2');
  assert.ok(!h2.log.sent.includes(parts[0]), 'part 1 is never resent');
});

test('Network error / timeout / 5xx: recorded as unclear, no further parts, no automatic resend', async () => {
  for (const answer of [new TypeError('fetch failed'), reply(504, 'gateway timeout'), reply(200, {})]) {
    const h = harness([], [answer, reply(201, { sid: 'never' })]);
    const r = await sendSmsParts({ body: longBody }, h.deps);
    assert.deepEqual(r, { settled: true, stopped: 'needs_review' });
    assert.equal(h.log.sent.length, 1, 'nothing after the unclear part');
    assert.equal(h.log.finish[0][1], 'unknown');
  }
});

test('A short message is one part and is asked about once', async () => {
  const h = harness([], [reply(201, { sid: 'SMone' })]);
  assert.deepEqual(await sendSmsParts({ body: 'KVISA: synthetic short text' }, h.deps), { ok: true, id: 'SMone' });
  assert.deepEqual(h.log.begin, [[1, 1]]);
});
