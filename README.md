# Kvisa — Laundry Dispatch

Kvisa coordinates clothing pickup, volunteer washing and return delivery.
Every order has five independently assigned stages — **pickup → drop-off to washer → washing → return collection → final delivery** —
with a bag count recorded at every handoff, so you always know where the bags are and how many there should be.

- **Live site:** `https://yidele.github.io/kvisa/` (after the one-time setup in [docs/OPERATIONS.md](docs/OPERATIONS.md))
- **Database:** Supabase project `kvisa` (Postgres + Auth + row-level security)
- **App:** plain modern JavaScript modules — no build step. GitHub runs the tests and publishes the site.

## What's in here

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `src/` | The web app (ES modules). `src/pages/` has one file per screen. |
| `supabase/migrations/` | The database, in order. This is the source of truth for tables, rules and security. |
| `supabase/tests/business_rules.sql` | 59 database tests of the business rules (run inside a rolled-back transaction). |
| `tests/unit/` | Unit tests for dates/time zones, validation, CSV (`npm test`). |
| `tests/e2e/` | Browser smoke tests of every page with a fake database (`npm run test:e2e`). |
| `docs/` | Operations & deployment, decisions, report definitions. |

## Who can do what

| Role | Can |
|---|---|
| Administrator | Everything, including Settings, users, roles, categories, reasons. |
| Dispatcher | Clients, orders, assignments, scheduling, recurring series, exceptions, history, reports. |
| Driver | Only their own tasks: addresses, contacts, bag counts; record pickups/deliveries; report problems. |
| Washing volunteer | Only their own washing tasks: confirm receipt, start/finish washing, report problems. |

Permissions are enforced **in the database** (row-level security and checked functions), not just by hiding buttons.
A driver who edits a URL or calls the API directly still cannot read client records, internal notes, other people's tasks, history or settings.

## Running the tests

```bash
npm test              # unit tests (Node 20+)
npm run check         # syntax check every module
npm run test:e2e      # browser smoke tests (needs Python Playwright + Chromium)
```

Database tests (in the Supabase SQL editor, or via the Supabase connector):

```sql
-- once, to install the test harness:
--   paste supabase/tests/business_rules.sql
select * from kvisa_tests.run();   -- nothing is saved; everything is rolled back
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup, deployment, backups and recovery, and
[docs/DECISIONS.md](docs/DECISIONS.md) for the choices made where the specification left room.
