# Kvisa — Setup, deployment, backups

## 1. What is already configured

| Piece | Status |
|---|---|
| Supabase project `kvisa` (ref `bianlispgajtcvgwhbqn`, region us-east-2, free plan) | Created; all migrations in `supabase/migrations/` applied |
| Row-level security on every table | On; verified by `kvisa_tests.run()` (59/59) and the Supabase security advisor |
| Test harness schema `kvisa_tests` | Installed (not exposed to the API) |
| WhatsApp / SMS job posts | Built; **needs you** — see §8 (migration 011, the `messaging` function, provider accounts) |
| GitHub repository / hosting | **Needs you** — see step 2 |
| Auth redirect URLs, email settings | **Needs you** — see step 3 |

## 2. Publish the site (one time)

1. Create an empty public repository named `kvisa` on GitHub and push this folder to it (Claude does the push once the repo exists).
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` now runs the tests (`.github/workflows/ci.yml`) and, if they pass, publishes the site to
   `https://<your-user>.github.io/kvisa/`.

No build step and no secret keys are involved: `src/config.js` contains only the Supabase URL and the
**publishable** key, which is designed to be public. All protection is in the database.

## 3. Supabase dashboard settings (one time, from a phone or tablet browser)

Open https://supabase.com/dashboard/project/bianlispgajtcvgwhbqn

1. **Authentication → URL Configuration**
   - Site URL: `https://<your-user>.github.io/kvisa/`
   - Redirect URLs: add `https://<your-user>.github.io/kvisa/**`
   (Needed for the email-confirmation and password-reset links.)
2. **Authentication → Sign In / Providers → Email**: keep *Confirm email* on (recommended) or turn it off if you
   prefer people to sign in immediately — sign-up is already restricted to invited emails either way.
3. **Authentication → Emails → SMTP** (recommended before inviting many people): the built-in mailer only sends a few
   emails per hour. Connect your own SMTP (e.g. a free Brevo/Resend account) for reliable confirmation/reset emails.
4. **Authentication → Attack Protection**: turn on *leaked password protection* if offered on your plan.

## 4. First sign-in

The very first account created becomes the **Administrator**. Open the site, choose **Create account**, and sign up.
After that, sign-up only works for emails an administrator has invited (Settings → Users, roles & invitations, or from a
driver/volunteer's profile → *Invite to log in*). Kvisa does not send invitation emails — tell people to open the site and
choose *Create account* with the invited email.

## 5. Environment / configuration values

| Name | Where | Value |
|---|---|---|
| `SUPABASE_URL` | `src/config.js` | `https://bianlispgajtcvgwhbqn.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `src/config.js` | the project's publishable key (public by design) |
| Organization time zone, defaults, reasons, labels | Settings page (stored in `organization_settings`) | editable by administrators |

Never put the `service_role`/secret key or the database password in this repository or in front-end code.

## 6. Database migrations

Migrations live in `supabase/migrations/` and are applied in file-name order. They have already been applied to the
live project. To change the database:

1. Add a new file, e.g. `supabase/migrations/008_<what>.sql` (never edit an applied migration).
2. Apply it with the Supabase connector (`apply_migration`), the Supabase CLI (`supabase db push`), or by pasting it into
   the SQL editor.
3. Run `select * from kvisa_tests.run();` and the Supabase **security advisor** afterwards.

To rebuild the database from scratch in a new project: apply every file in order, then install
`supabase/tests/business_rules.sql` and run the tests.

On any machine with Postgres, `npm run test:db` builds a throwaway database from the migrations and runs every SQL
test suite (GitHub runs this on every push).

## 7. Backups and recovery

**Automatic:** the Supabase free plan keeps daily backups only on paid plans. On the free plan you must export yourself:

- **Quick spreadsheet copy:** Reports → *Export orders (CSV)* and each report table's *CSV* button.
- **Full database dump (recommended weekly):** Supabase dashboard → **Database → Backups** (paid plans) or, from any
  computer with the Supabase CLI: `supabase db dump --db-url "<connection string>" -f kvisa-YYYY-MM-DD.sql` and
  `supabase db dump --data-only ... -f kvisa-data-YYYY-MM-DD.sql`. Keep copies off-site (e.g. Google Drive).
- **Free-plan pausing:** Supabase pauses free projects after about a week with no activity. Daily use prevents this;
  if paused, open the dashboard and press *Restore*. Data is kept.

**Recovery:**
1. Create a new Supabase project (or restore the existing one from a dashboard backup on paid plans).
2. Apply the migrations in order (section 6), or restore the schema dump.
3. Restore the data dump with `psql "<connection string>" -f kvisa-data-YYYY-MM-DD.sql`
   (temporarily disable the append-only triggers if your dump re-inserts history:
   `alter table audit_logs disable trigger t_append_only;` … re-enable afterwards).
4. Update `src/config.js` with the new project URL and publishable key, push, and update Auth URL settings.

**History is append-only:** audit entries and handoff events cannot be changed or deleted, even by the database owner,
without first disabling those triggers. Do that only during a documented restore.

## 8. WhatsApp group posts and text messages

In-app notifications (the bell) are always on. On top of that the dispatcher can **post open jobs** to the WhatsApp
group and/or by SMS, and drivers answer by private message:

| Someone sends privately | What happens |
|---|---|
| `2` (or `#2`, `1, 3`) | They get job 2 if it is still open, first come first served, the same as accepting in the app. The second half of the trip (drop-off to the washer, or final delivery) is assigned to them too if nobody has it. They get the details back privately, and the group gets **“2 covered @them”** with them tagged. If it is taken: “Sorry, job 2 is already covered.” |
| `done` | Their ready stage is recorded with the bag count the order expects: pickup + drop-off for a driver, receipt + washing finished for a washer, return pickup + delivery. If they have more than one open job they are asked which (`done 2`, or `done K-1001`). |
| anything else | Nothing automatic: it stays a normal chat for you to answer. It is listed on the **Messages** page. |

Only numbers saved on a person’s profile (Drivers / Volunteers) are recognised; other people get no automatic reply.
If the dispatcher assigns a posted job directly, the offer closes and the group also gets “N covered …”.
Job numbers are unique among the jobs still open; once everything earlier is covered, numbering starts again at 1.

Every message sent or received is listed on **Messages**, where failed sends can be sent again.

### How it is built

- The database queues each outgoing message in `message_outbox` and logs each incoming one in `message_inbox`
  (migration `011_messaging.sql`; tests: `select * from kvisa_tests.run_messaging();`).
- The Supabase Edge Function **`messaging`** (`supabase/functions/messaging/`) sends the queue and receives the
  webhooks. Provider keys are Edge Function secrets — never in this repository or the browser.
- WhatsApp goes through **Whapi.Cloud**, which links a normal WhatsApp number the way WhatsApp Web does. That is
  what lets it post into your existing 60–70 person group and tag people. Meta’s official Business API cannot do that.
  **Risk:** WhatsApp does not officially allow linked automation, so the number can be banned. At a few posts a day,
  only to your own group and to people who wrote first, the risk is low but not zero.
- SMS goes through **Twilio**.

### Setup (one time)

1. **Apply the migration** `supabase/migrations/011_messaging.sql` (see §6).
2. **Deploy the function** with JWT verification **off** (webhooks don’t carry a Supabase login; the function checks
   its own secret, Twilio’s signature, and the dispatcher’s login itself):
   `supabase functions deploy messaging --no-verify-jwt` (or Dashboard → Edge Functions → Deploy, “Verify JWT” off).
3. **WhatsApp (Whapi.Cloud):** create an account and a channel, then open the QR code and scan it from the phone
   whose number posts in the group (WhatsApp → Linked devices → Link a device). Copy the channel’s **API token**.
4. **Secrets** (Dashboard → Edge Functions → Secrets):

   | Name | Value |
   |---|---|
   | `MESSAGING_WEBHOOK_SECRET` | any long random text (e.g. 40 letters and digits) — it goes in the webhook URLs below |
   | `WHAPI_TOKEN` | the Whapi channel API token |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | from the Twilio console |
   | `TWILIO_FROM` | your Twilio number (`+1…`) or a Messaging Service SID (`MG…`) |
   | `WHAPI_API_URL` | optional; only if Whapi gives you a different API address than `https://gate.whapi.cloud` |

5. **Webhooks** (replace `SECRET` with `MESSAGING_WEBHOOK_SECRET`):
   - Whapi → channel settings → Webhooks: `https://bianlispgajtcvgwhbqn.supabase.co/functions/v1/messaging?hook=whatsapp&secret=SECRET`, event **messages → POST**.
   - Twilio → Phone Numbers → your number → Messaging → “A message comes in”: Webhook, HTTP POST,
     `https://bianlispgajtcvgwhbqn.supabase.co/functions/v1/messaging?hook=sms&secret=SECRET` (exactly this URL —
     Twilio’s signature is checked against it).
6. **In Kvisa → Settings → WhatsApp & text messages:** the top line should say *WhatsApp: connected*. Press
   **Load my groups**, pick the group, tick the channels you want, and save.
7. Make sure every driver and washer has their **mobile number** on their profile (add `+` and the country code for a
   foreign number).
8. **Test:** post one job to the group, reply `1` from a driver’s phone, then `done`.

Notes:
- **Twilio trial (test mode):** texts only go to numbers you verified in Twilio, and start with “Sent from your
  Twilio trial account”. Upgrade the account to text everyone.
- **WhatsApp stays linked** while the phone uses WhatsApp at least every couple of weeks. If it unlinks, scan the QR again.
- **Address privacy:** once a full address is sent by WhatsApp/SMS it cannot be taken back the way the app takes it away on
  reassignment. To send street names only (the driver opens the app for the address), turn off “Send the full address”
  in Settings.

## 9. Monitoring

- Supabase dashboard → **Logs** for API/database errors.
- Supabase dashboard → **Advisors** (security & performance) after any schema change.
- GitHub → **Actions** for test results of each change.
