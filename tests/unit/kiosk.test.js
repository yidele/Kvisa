import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKiosk, labelPages, phoneDigits, TEXT, LABEL_SIZES } from '../../src/lib/kiosk.js';

test('tablet form accepts a normal request and tidies the name', () => {
  const r = checkKiosk({ name: '  Moshe   Levi ', phone: '+972 52-123-4567', bags: 3 }, 20, 'en');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: 'Moshe Levi', phone: '+972 52-123-4567', bags: 3 });
});

test('tablet form explains each problem in the chosen language', () => {
  const he = checkKiosk({ name: 'A', phone: '123', bags: 0 }, 20, 'he');
  assert.equal(he.ok, false);
  assert.equal(he.errors.name, TEXT.he.errName);
  assert.equal(he.errors.phone, TEXT.he.errPhone);
  assert.equal(he.errors.bags, TEXT.he.errBags(20));
  const en = checkKiosk({ name: 'Abe', phone: '0521234567', bags: 21 }, 20, 'en');
  assert.deepEqual(Object.keys(en.errors), ['bags']);
  assert.match(en.errors.bags, /1 to 20/);
  assert.equal(checkKiosk({ name: 'Abe', phone: '0521234567', bags: 2.5 }, 20, 'en').ok, false);
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
