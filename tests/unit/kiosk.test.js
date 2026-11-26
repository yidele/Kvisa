import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDropOff, checkLookup, labelPages, phoneDigits, TEXT, LANGS, LABEL_SIZES } from '../../src/lib/kiosk.js';

const ok = { first: '  Moshe ', middle: '', last: 'Levi', phone: '718-555-0101', israel: '+972 52-123-4567', bags: 3 };

test('drop-off form accepts a normal request and tidies the names', () => {
  const r = checkDropOff({ ...ok, middle: ' Yosef  Dov ' }, 20, 'en');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { first: 'Moshe', middle: 'Yosef Dov', last: 'Levi', phone: '718-555-0101', israel: '+972 52-123-4567', bags: 3 });
});

test('the phone in Israel is optional and taken in any format; middle name is optional', () => {
  assert.equal(checkDropOff({ ...ok, israel: '' }, 20, 'en').ok, true);
  assert.equal(checkDropOff({ ...ok, israel: '12' }, 20, 'en').ok, true);
  assert.equal(checkDropOff({ ...ok, israel: ok.phone }, 20, 'en').ok, true);
});

test('drop-off form explains each problem in the chosen language', () => {
  for (const lang of Object.keys(LANGS)) {
    const r = checkDropOff({ first: ' ', last: '', phone: '123', israel: '', bags: 0 }, 20, lang);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, { first: TEXT[lang].errFirst, last: TEXT[lang].errLast, phone: TEXT[lang].errPhone, bags: TEXT[lang].errBags(20) });
  }
  assert.equal(checkDropOff({ ...ok, bags: 21 }, 20, 'en').errors.bags, 'Number of bags must be from 1 to 20.');
  assert.equal(checkDropOff({ ...ok, bags: 2.5 }, 20, 'en').ok, false);
});

test('"I have an ID number" takes the ID (with or without K-) and exactly 4 phone digits', () => {
  assert.deepEqual(checkLookup({ id: 'K-1106', last4: '4567' }, 'en').value, { id: 1106, last4: '4567' });
  assert.deepEqual(checkLookup({ id: ' 1106 ', last4: '45-67' }, 'en').value, { id: 1106, last4: '4567' });
  assert.deepEqual(Object.keys(checkLookup({ id: '', last4: '456' }, 'yi').errors), ['id', 'last4']);
});

test('Hebrew, English and Yiddish have exactly the same texts', () => {
  const keys = Object.keys(TEXT.en).sort();
  for (const lang of Object.keys(LANGS)) {
    assert.deepEqual(Object.keys(TEXT[lang]).sort(), keys, lang);
    for (const k of keys) assert.equal(typeof TEXT[lang][k], typeof TEXT.en[k], `${lang}.${k}`);
    assert.equal(TEXT[lang].infoSteps.length, TEXT.en.infoSteps.length, `${lang} infoSteps`);
    assert.equal(TEXT[lang].infoTimes.length, TEXT.en.infoTimes.length, `${lang} infoTimes`);
    for (const st of ['waiting', 'picked_up', 'cancelled', 'returned']) assert.ok(TEXT[lang]['state_' + st], `${lang} state_${st}`);
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

test('Hebrew numerals and the Hebrew date on the receipt', async () => {
  const { gematria, hebrewDate } = await import('../../src/lib/kiosk.js');
  assert.equal(gematria(1), 'א׳');
  assert.equal(gematria(15), 'ט״ו');
  assert.equal(gematria(16), 'ט״ז');
  assert.equal(gematria(5787), 'תשפ״ז');
  assert.equal(hebrewDate('2026-11-26T15:00:00Z'), 'ט״ז כסלו תשפ״ז');
});
