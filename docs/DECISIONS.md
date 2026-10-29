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
| Address autocomplete, GPS, email | Not included. Addresses link to Google Maps for navigation. | Spec allows; would need paid/secret API keys handled server-side. |
| Driver job offers | "Dispatch call" creates an offer for one stage, sent to all active drivers or chosen ones, optionally with a time limit. One open offer per stage (unique index) + a row lock make acceptance first-come-first-served. | Dispatch offers spec §1–5. |
| Address privacy | Drivers have no table access at all. Before accepting they can only call `my_offers()`, which returns street names (`street_only()`), stage, bags, time and the dispatcher's note. Exact addresses, contacts and access instructions come only from `my_tasks()`, which returns stages *currently* assigned to the caller — so reassigning revokes access immediately, and the change is logged (`offer.access_revoked`). | Spec §6: enforced in the database, not the UI. |
| When a stage can be dispatched | Pickup / drop-off: a washer is assigned and both addresses exist. Return collection / final delivery: washing is completed. | Spec §1, §3. |
| Automatic return dispatch | Off by default; an administrator can turn it on in Settings → Driver dispatch. | Spec §3. |
| Expiry | Offers past their time limit are closed automatically the next time anyone looks at offers. | No server cron on the free plan. |
| WhatsApp provider | Whapi.Cloud (a linked WhatsApp number), not Meta's official Business API. | The official API cannot post into an existing group of 60–70 people (its groups are invite-only and capped at 8) and can't tag. The owner already runs the workflow in a group. Ban risk accepted. Green-API was considered but does not support tagging. |
| SMS provider | Twilio. | Owner had no preference; the most common choice. Swapping providers only touches `supabase/functions/messaging/lib.js`. |
| Which number posts | The owner's own WhatsApp number. | People keep replying privately to the same number as today. Only known numbers sending a job number or DONE get automatic replies, so ordinary chats are untouched. |
| Job numbers | Unique among jobs still open; a new post continues after the highest open number and restarts at 1 when everything is covered. | Matches the 1, 2, 3 habit without two open jobs sharing a number. |
| Taking a job by message | Same atomic accept as the app (`respond_offer`, acting as that person). Any active driver may take an open-to-all posted job even if they weren't on the original recipient list. The other half of the same trip is assigned to them too if nobody has it. | Whoever sees the group post can answer. One driver normally carries the bags from client to washer, or washer to recipient. |
| DONE | Records the ready stage (and the other half of the same trip if theirs) with the order's current expected bag count. Differences are corrected by the dispatcher. | Owner: bag counts rarely change, and they will correct it manually. |
| Acting for people without a login | Server-only code sets `kvisa.as_person`; `my_person_id()` honours it only when nobody is signed in and the caller is not the anonymous role. | Lets replies use the existing checked workflow functions instead of copies. |
| Message delivery | Outbox table + Edge Function. Sends right after posting and after each incoming message; failures retry up to 3 times and can be resent from Messages. | Simple, works on the free plan, and nothing is lost if a provider is down. |
