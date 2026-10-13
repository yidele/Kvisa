import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToDate, dateToZonedParts, addDays, startOfWeek, daysInMonth, weekdayOf, parseBagCount,
  findPossibleDuplicates, friendlyError, nextActions, statusLabel, orderNo, clientNo, todayInTz,
} from '../../src/lib/format.js';
import { toCsv, csvCell } from '../../src/lib/csv.js';

const NY = 'America/New_York';

test('wall-clock time in the org time zone converts to the right UTC instant (EDT and EST)', () => {
  assert.equal(zonedToDate('2026-07-01', '10:00', NY).toISOString(), '2026-07-01T14:00:00.000Z');
  assert.equal(zonedToDate('2026-12-01', '10:00', NY).toISOString(), '2026-12-01T15:00:00.000Z');
  assert.equal(zonedToDate('2026-03-08', '03:30', NY).toISOString(), '2026-03-08T07:30:00.000Z'); // after spring-forward
});

test('UTC instants display in the org time zone and round-trip', () => {
  assert.deepEqual(dateToZonedParts('2026-11-01T05:30:00Z', NY), { date: '2026-11-01', time: '01:30' });
  const d = zonedToDate('2026-10-13', '23:45', NY);
  assert.deepEqual(dateToZonedParts(d, NY), { date: '2026-10-13', time: '23:45' });
  assert.deepEqual(dateToZonedParts(zonedToDate('2026-10-13', '09:05', 'Asia/Jerusalem'), 'Asia/Jerusalem'), { date: '2026-10-13', time: '09:05' });
});

test('"today" is computed in the org zone, not UTC', () => {
  // 02:00 UTC on Oct 13 is still Oct 12 in New York
  assert.equal(todayInTz(NY, new Date('2026-10-13T02:00:00Z')), '2026-10-12');
});

test('calendar date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-10-12'), 1);          // Monday
  assert.equal(startOfWeek('2026-10-15'), '2026-10-11'); // Sunday
  assert.equal(daysInMonth('2028-02-10'), 29);
});

test('bag counts must be whole, non-negative numbers', () => {
  assert.deepEqual(parseBagCount('4'), { ok: true, value: 4 });
  assert.deepEqual(parseBagCount('0'), { ok: true, value: 0 });
  assert.equal(parseBagCount('-1').ok, false);
  assert.equal(parseBagCount('2.5').ok, false);
  assert.equal(parseBagCount('abc').ok, false);
  assert.equal(parseBagCount('').ok, false);
  assert.deepEqual(parseBagCount('', { allowEmpty: true }), { ok: true, value: null });
  assert.equal(parseBagCount('501').ok, false);
});

test('possible duplicate clients are detected by phone, name or address', () => {
  const existing = [
    { id: '1', name: 'Cohen Family', phone: '(718) 555-0101', pickup_address: '12 Main St' },
    { id: '2', name: 'Levi', phone: null, pickup_address: '40 Elm Ave' },
  ];
  assert.equal(findPossibleDuplicates({ name: 'Someone', phone: '7185550101' }, existing).length, 1);
  assert.equal(findPossibleDuplicates({ name: 'cohen family' }, existing).length, 1);
  assert.equal(findPossibleDuplicates({ name: 'New', pickup_address: '40 elm ave' }, existing).length, 1);
  assert.equal(findPossibleDuplicates({ name: 'Brand New', phone: '2125550000' }, existing).length, 0);
  assert.equal(findPossibleDuplicates({ id: '1', name: 'Cohen Family' }, existing).length, 0, 'editing self is not a duplicate');
});

test('database error codes become friendly messages', () => {
  assert.equal(friendlyError({ message: 'KVISA_FORBIDDEN: this task is not assigned to you' }), 'This task is not assigned to you');
  assert.match(friendlyError({ message: 'Database error saving new user' }), /not been invited/);
  assert.match(friendlyError({ message: 'new row violates row-level security policy' }), /permission/);
  assert.match(friendlyError(new Error('Failed to fetch')), /connection/);
});

test('next actions follow the stage rules', () => {
  assert.deepEqual(nextActions('pickup', 'pending').map((a) => a.event), ['task_started', 'collected_from_client']);
  assert.deepEqual(nextActions('washing', 'pending', false).map((a) => a.event), ['received_by_washer']);
  assert.deepEqual(nextActions('washing', 'in_progress', true).map((a) => a.event), ['wash_started', 'wash_completed']);
  assert.deepEqual(nextActions('delivery', 'completed'), []);
  assert.ok(nextActions('delivery', 'in_progress')[0].count, 'delivery records a bag count');
});

test('labels can be renamed in settings without changing meaning', () => {
  assert.equal(statusLabel('ready_for_return', {}), 'Ready for return collection');
  assert.equal(statusLabel('ready_for_return', { status_labels: { ready_for_return: 'Clean, waiting' } }), 'Clean, waiting');
  assert.equal(orderNo(1001), 'K-1001');
  assert.equal(clientNo(7), 'C-0007');
});

test('CSV export quotes properly and blocks formula injection', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell(null), '');
  const out = toCsv([{ a: 1, b: 'x' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', value: (r) => r.b.toUpperCase() }]);
  assert.equal(out, 'A,B\r\n1,X\r\n');
});
