import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDropOff, checkTrack, stageOf, STAGES, labelPages, phoneDigits, TEXT, LANGS, LABEL_SIZES } from '../../src/lib/kiosk.js';
import { ORDER_STATUSES } from '../../src/lib/format.js';

const ok = { first: '  Moshe ', middle: '', last: 'Levi', phone: '718-555-0101', israel: '+972 52-123-4567', bags: 3 };

test('drop-off form accepts a normal request and tidies the names', () => {
  const r = checkDropOff({ ...ok, middle: ' Yosef  Dov ' }, 20, 'en');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { first: 'Moshe', middle: 'Yosef Dov', last: 'Levi', phone: '718-555-0101', israel: '+972 52-123-4567', bags: 3 });
});

test('the same number may be typed in both phone boxes; middle name is optional', () => {
  assert.equal(checkDropOff({ ...ok, israel: ok.phone }, 20, 'en').ok, true);
});

test('drop-off form explains each problem in the chosen language', () => {
  for (const lang of Object.keys(LANGS)) {
    const r = checkDropOff({ first: ' ', last: '', phone: '123', israel: '45', bags: 0 }, 20, lang);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, { first: TEXT[lang].errFirst, last: TEXT[lang].errLast, phone: TEXT[lang].errPhone,
      israel: TEXT[lang].errIsrael, bags: TEXT[lang].errBags(20) });
  }
  assert.equal(checkDropOff({ ...ok, bags: 21 }, 20, 'en').errors.bags, 'Number of bags must be from 1 to 20.');
  assert.equal(checkDropOff({ ...ok, bags: 2.5 }, 20, 'en').ok, false);
});

test('tracking needs a phone number and a first name', () => {
  assert.equal(checkTrack({ phone: '052-123-4567', first: ' Moshe ' }, 'en').value.first, 'Moshe');
  assert.deepEqual(Object.keys(checkTrack({ phone: '1', first: '' }, 'yi').errors), ['phone', 'first']);
});

test('every order status maps to one of the four simple steps (or a note)', () => {
  assert.equal(stageOf('requested'), 'pickup');
  assert.equal(stageOf('scheduled'), 'pickup');
  assert.equal(stageOf('awaiting_dropoff'), 'washing');
  assert.equal(stageOf('washing_in_progress'), 'washing');
  assert.equal(stageOf('ready_for_return'), 'return');
  assert.equal(stageOf('out_for_delivery'), 'return');
  assert.equal(stageOf('completed'), 'delivered');
  assert.equal(stageOf('exception'), 'attention');
  assert.equal(stageOf('cancelled'), 'cancelled');
  for (const st of ORDER_STATUSES) assert.ok([...STAGES, 'attention', 'cancelled'].includes(stageOf(st)), st);
});

test('Hebrew, English and Yiddish have exactly the same texts', () => {
  const keys = Object.keys(TEXT.en).sort();
  for (const lang of Object.keys(LANGS)) {
    assert.deepEqual(Object.keys(TEXT[lang]).sort(), keys, lang);
    for (const k of keys) assert.equal(typeof TEXT[lang][k], typeof TEXT.en[k], `${lang}.${k}`);
    for (const st of [...STAGES, 'attention', 'cancelled']) assert.ok(TEXT[lang]['stage_' + st], `${lang} stage_${st}`);
  }
  assert.equal(LANGS.he.dir, 'rtl'); assert.equal(LANGS.yi.dir, 'rtl'); assert.equal(LANGS.en.dir, 'ltr');
});

test('phone digits ignore spaces, dashes and plus signs', () => {
  assert.equal(phoneDigits('+1 (718) 555-0100'), '17185550100');
  assert.equal(phoneDigits(null), '');
});

test('one label per bag', () => {
  assert.deepEqual(labelPages(3), [{ index: 1, of: 3 }, { index: 2, of: 3 }, { index: 3, of: 3 }]);
  assert.equal(labelPages(0).length, 1);
});

test('every label size the database allows has a print size', () => {
  assert.deepEqual(Object.keys(LABEL_SIZES).sort(), ['2.25x1.25', '4x6', '62mm', 'letter']);
  for (const v of Object.values(LABEL_SIZES)) assert.ok(v.css && v.label);
});
