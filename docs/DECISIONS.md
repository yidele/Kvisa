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
| Driver job offers | "Dispatch call" creates an offer for one stage, sent to all active drivers or chosen ones, optionally with a time limit. One open offer per stage (unique index) + a row lock make acceptance first-come-first-served. | Dispatch offers spec §1–5. |
| Address privacy | Drivers have no table access at all. Before accepting they can only call `my_offers()`, which returns street names (`street_only()`), stage, bags, time and the dispatcher's note. Exact addresses, contacts and access instructions come only from `my_tasks()`, which returns stages *currently* assigned to the caller — so reassigning revokes access immediately, and the change is logged (`offer.access_revoked`). | Spec §6: enforced in the database, not the UI. |
| When a stage can be dispatched | Pickup / drop-off: a washer is assigned and both addresses exist. Return collection / final delivery: washing is completed. | Spec §1, §3. |
| Automatic return dispatch | Off by default; an administrator can turn it on in Settings → Driver dispatch. | Spec §3. |
| Expiry | Offers past their time limit are closed automatically the next time anyone looks at offers. | No server cron on the free plan. |
| Walk-up tablet login | A separate **Tablet** role whose only power is `kiosk_submit()`. No table policy grants it anything, so a person at the tablet cannot see other clients or orders even with developer tools. | The tablet is unattended in a public room. |
| Matching returning meshulachim | The tablet asks for a phone here and a phone in Israel (the same number may be typed twice). Either typed number is matched against either saved number by the last 9 digits, so `052-123-4567` and `+972 52-123-4567` are the same. A match on the Israeli number wins, since the American number often changes between visits. The newest numbers are saved on the client (older ones stay in the history); the saved name is not overwritten. An inactive client who comes back is reactivated. | One record per person, even with a new American number each visit. |
| Track my laundry | On the tablet: phone (either number) + first name. Shows orders from the last 120 days (finished ones for 14 days) as four steps — dropped off, being washed, washed, brought back — refreshed every 20 seconds. No addresses or people are returned. | What the meshulach needs to know, nothing more. |
| Tablet order details | Pickup address = the tablet category's default pickup address, else the organization address. Pickup time = now, or today's default pickup time if that is later. Status starts at *Requested*; staff get a "New tablet request" notification. | The bags are already at the drop-off point. |
| Double taps / lost replies | The tablet sends a request key; the same key always returns the same order. | Flaky Wi-Fi must never create two orders. |
| Abuse limit | At most 30 tablet requests per 10 minutes. | Cheap protection for an unattended screen. |
| Labels | Printed from the browser, one page per bag, page size from Settings (4×6, 62 mm Brother, small Dymo, or full page). | Works with any printer the tablet can print to; no extra software. |
| Tablet app | A separate page (`tablet/`) with its own sign-in and an install manifest, sharing the database and code with the main app. A Tablet login that opens the main site is sent there. Administrators and dispatchers may also sign in to it to try it. | Can be opened or installed on its own and locked to one screen. |
| Leaving tablet mode | Tap the K logo 5 times, then type the signed-in account's password. | Guests can't get out; the office can. |
| Languages | The tablet opens on a welcome screen with Hebrew, English and Yiddish; every screen has the same text in all three (a unit test checks this). Labels are in English for the office. | The meshulachim are from Israel. |
