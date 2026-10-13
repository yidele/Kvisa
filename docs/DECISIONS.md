# Decisions made where the specification left room

| Topic | Decision | Why |
|---|---|---|
| Relationship to Nekius Dispatch | Separate app, separate database. Nekius Dispatch is untouched. | Owner's choice. |
| Front-end technology | Plain ES modules (no build), small in-house view helpers, Supabase JS from a pinned CDN URL. | No packages could be installed in the build workspace; a no-build app is fully testable here, publishes straight from GitHub, and can be maintained from a phone/tablet. |
| Where rules live | In Postgres: row-level security, triggers and checked functions (`record_handoff`, `create_order`, …). | Spec requires server-side enforcement; one place for every rule; works the same from any client. |
| Order status | Derived automatically from the five stage records and open exceptions (`recompute_order_status`). Never typed in. | Spec: "do not rely on one status field". Status cannot drift from reality. |
| Fixing mistakes | *Undo step* (adds an "event reverted" record and reopens the stage) and *Correct count* (adds a correction record). Originals stay. | Spec: preserve original events, record corrections separately. |
| Discrepancies | Any handoff whose count differs from the previous recorded count opens a `bag_discrepancy` exception. Collection vs. the client's expected count is flagged too (setting). | Spec §9. |
| Completion | Order completes only when final delivery is recorded **and** no blocking exception is open. Failed pickup / missing bags always block; bag discrepancies block unless an admin turns that rule off. | Spec §8/§7. |
| "Exception" status | Used when delivery is done but issues are open, or when a failed-pickup / missing-bags problem is open. Other issues are shown as flags without hiding the stage. | Keeps progress visible while still surfacing problems. |
| Current location | Derived from the latest non-undone handoff event (view `order_overview`). | Spec §9. |
| Drop-off destination | The washer's address; when the washer is changed, not-yet-done drop-off/return-collection legs that pointed at the old washer move to the new one. Explicit overrides are kept. | Avoids stale addresses without silently changing manual entries. |
| Recurring orders | Generated idempotently for a planning window (default 28 days) when staff open the app and when a series changes. A unique index on (schedule, date) prevents duplicates. | Spec §10. No server cron needed on the free plan. |
| Editing one occurrence | Any direct edit of a generated order marks it *detached*; series edits skip detached and already-started occurrences. | Spec §10 explicit choice. |
| Skipping an occurrence | The occurrence is cancelled with a reason; it keeps its date slot so it is never regenerated. | Spec §10. |
| People | One `people` record per human with `person_roles` (driver, washer). App logins (`profiles`) link to a person. | Spec §12–13, §18. |
| Sign-up | Invite-only; the first account becomes Administrator. | Matches the owner's earlier requirement and the spec's security goals. |
| Deletion | Orders, stages, handoffs, exceptions and audit entries cannot be deleted. Clients/people/categories are deactivated. Roles are deactivated, not removed. | Spec §18–19. |
| Driver/volunteer data access | No direct table access to orders/clients; they use `my_tasks()` which returns only their tasks and only what's needed. Volunteers see the client's first name and order number, not their address/phone. | Least privilege (spec §3, §19). |
| Time zone | All timestamps stored in UTC; shown/entered in the org time zone (Settings). Default America/New_York. | Spec §16. |
| Live updates | Pages refresh every 60 seconds and after each change (no websockets). | Simple and reliable on the free plan. |
| Address autocomplete, GPS, email/SMS | Not included. Addresses link to Google Maps for navigation. | Spec allows; would need paid/secret API keys handled server-side. |
