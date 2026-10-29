// Unit tests for the messaging Edge Function helpers (WhatsApp via Whapi, SMS via Twilio).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWhapiWebhook, parseTwilioForm, twilioSignature, safeEqual,
  whapiSendRequest, twilioSendRequest, readSendResult, parseGroups, splitSms,
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
