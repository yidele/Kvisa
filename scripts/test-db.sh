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
        union all select * from kvisa_tests.run_messaging()) t" | tee /tmp/kvisa_db_tests.txt
dropdb "$DB"
fails=$(grep -c '^FAIL' /tmp/kvisa_db_tests.txt || true)
echo "$(grep -c '^PASS' /tmp/kvisa_db_tests.txt) passed, $fails failed"
[ "$fails" = 0 ]
