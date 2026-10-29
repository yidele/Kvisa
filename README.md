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
| `tablet/` | The walk-up tablet app (its own page and install manifest; code in `src/tablet.js` and `src/pages/kiosk.js`). |
| `supabase/migrations/` | The database, in order. This is the source of truth for tables, rules and security. |
| `supabase/tests/business_rules.sql` | 59 database tests of the business rules (run inside a rolled-back transaction). |
| `supabase/tests/dispatch_offers.sql` | 30 database tests of driver job offers and address privacy. |
| `supabase/tests/kiosk.sql` | 15 database tests of the walk-up tablet. |
| `tests/unit/` | Unit tests for dates/time zones, validation, CSV (`npm test`). |
| `tests/e2e/` | Browser smoke tests of every page with a fake database (`npm run test:e2e`). |
| `docs/` | Operations & deployment, decisions, report definitions. |

## Who can do what

| Role | Can |
|---|---|
| Administrator | Everything, including Settings, users, roles, categories, reasons. |
| Dispatcher | Clients, orders, assignments, scheduling, recurring series, exceptions, history, reports. |
| Driver | Job offers (street names only) to accept or decline; full addresses only for jobs assigned to them; record pickups/deliveries; report problems. |
| Washing volunteer | Only their own washing tasks: confirm receipt, start/finish washing, report problems. |
| Tablet | Only the walk-up screen: a meshulach types name, phone and number of bags; the order opens and one label per bag prints. Cannot read anything. |

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
select * from kvisa_tests.run();          -- business rules; nothing is saved
select * from kvisa_tests.run_offers();   -- dispatch offers & address privacy
select * from kvisa_tests.run_kiosk();    -- walk-up tablet (install supabase/tests/kiosk.sql first)
```

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup, deployment, backups and recovery, and
[docs/DECISIONS.md](docs/DECISIONS.md) for the choices made where the specification left room.
