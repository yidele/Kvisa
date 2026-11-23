#!/usr/bin/env bash
# Build a throwaway database from the migrations and run every SQL test suite.
# Needs a local Postgres 15+ and a role that can create databases, e.g.:
#   sudo -u postgres bash scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${KVISA_TEST_DB:-kvisa_test}
dropdb --if-exists "$DB" && createdb "$DB"
run() { psql -q -X -v ON_ERROR_STOP=1 -d "$DB" "$@" > /dev/null 2> >(grep -v '^NOTICE' >&2 || true); }
run -f supabase/tests/local/supabase_stub.sql
for f in supabase/migrations/*.sql; do run -f "$f"; done
for f in supabase/tests/*.sql; do run -f "$f"; done
psql -X -A -t -d "$DB" -c "
  select case when ok then 'PASS ' else 'FAIL ' end || test || coalesce(case when not ok then ' — ' || detail end, '')
  from (select * from kvisa_tests.run() union all select * from kvisa_tests.run_offers()
        union all select * from kvisa_tests.run_messaging() union all select * from kvisa_tests.run_sms()
        union all select * from kvisa_tests.run_sms_parts()) t" | tee /tmp/kvisa_db_tests.txt

# Concurrency (needs two real sessions, so it lives here, not in a rolled-back SQL test):
# two senders deciding on parts for the SAME number at once, daily cap = 1 → only one may send.
# Synthetic data is committed into this throwaway database, which is dropped below.
psql -q -X -v ON_ERROR_STOP=1 -d "$DB" > /dev/null 2> >(grep -v '^NOTICE' >&2 || true) <<'SQL'
select kvisa_tests.sms_configure();
update organization_settings set sms_max_per_day = 1 where id = 1;
insert into people (id, full_name, phone) values ('00000000-0000-0000-0000-00000000c001', 'C Concurrent', '212-555-0161');
insert into person_roles (person_id, role) values ('00000000-0000-0000-0000-00000000c001', 'driver');
insert into sms_enrollments (person_id, phone_e164, disclosure_version, status, joined_at, confirmed_at)
  values ('00000000-0000-0000-0000-00000000c001', '12125550161', 'test-v1', 'active', now(), now());
insert into message_outbox (id, channel, to_kind, to_address, person_id, body, purpose) values
  ('00000000-0000-0000-0000-00000000c0a1', 'sms', 'person', '12125550161', '00000000-0000-0000-0000-00000000c001', 'synthetic A', 'reply'),
  ('00000000-0000-0000-0000-00000000c0b2', 'sms', 'person', '12125550161', '00000000-0000-0000-0000-00000000c001', 'synthetic B', 'reply');
update message_outbox set status = 'sending', locked_at = now() where id in ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000c0b2');
SQL
A=$(mktemp) ; B=$(mktemp)
psql -X -A -t -d "$DB" -c "begin" -c "select public.sms_part_begin('00000000-0000-0000-0000-00000000c0a1', 1, 1)" \
     -c "select pg_sleep(2)" -c "commit" > "$A" &
sleep 0.5
psql -X -A -t -d "$DB" -c "select public.sms_part_begin('00000000-0000-0000-0000-00000000c0b2', 1, 1)" > "$B"
wait
ra=$(grep -E '^(send|stop|skip)' "$A" || true); rb=$(grep -E '^(send|stop|skip)' "$B" || true)
rm -f "$A" "$B"
if [ "$ra" = "send" ] && [ "$rb" = "stop:daily text limit reached for this number" ]; then r=PASS; else r=FAIL; fi
echo "$r C1 Two senders at once on the same number: only one part gets under a cap of 1 (got: '$ra' / '$rb')" | tee -a /tmp/kvisa_db_tests.txt
dropdb "$DB"
fails=$(grep -c '^FAIL' /tmp/kvisa_db_tests.txt || true)
echo "$(grep -c '^PASS' /tmp/kvisa_db_tests.txt) passed, $fails failed"
[ "$fails" = 0 ]
