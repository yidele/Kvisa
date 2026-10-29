# Kvisa — Setup, deployment, backups

## 1. What is already configured

| Piece | Status |
|---|---|
| Supabase project `kvisa` (ref `bianlispgajtcvgwhbqn`, region us-east-2, free plan) | Created; all migrations in `supabase/migrations/` applied |
| Row-level security on every table | On; verified by `kvisa_tests.run()` (59/59) and the Supabase security advisor |
| Test harness schema `kvisa_tests` | Installed (not exposed to the API) |
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
3. Run `select * from kvisa_tests.run();` (plus `run_offers()` and `run_kiosk()`) and the Supabase **security advisor** afterwards.

To rebuild the database from scratch in a new project: apply every file in order, then install
`supabase/tests/business_rules.sql` and run the tests.

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

## 8. Walk-up tablet for meshulachim

1. **Settings → Client categories:** fill in *Default pickup address* for Meshilach (where the bags are dropped off).
   Tablet orders use it as the pickup address. (If blank, the organization address is used.)
2. **Settings → Tablet:** check the category, the most bags per request, and the **label size** of your printer.
3. **Settings → Users → Invite someone:** an email you control (e.g. `tablet@yourdomain`), role **Tablet** only, no person record.
4. On the tablet, open the Kvisa site, choose *Create account* with that email, then sign in. It opens straight into the
   walk-up screen and stays signed in.
5. **Lock the tablet to that page.** Android: install *Fully Kiosk Browser*, set the Kvisa site as the start page and turn
   on kiosk mode (or use Android *App pinning* with Chrome). iPad: *Settings → Accessibility → Guided Access*.
   Windows: Chrome with `--kiosk --kiosk-printing` prints labels with no dialog at all.
6. **Printer:** connect the label printer to the tablet (Wi-Fi/Bluetooth/USB) and print one test label from the screen.
   On Android and iPad the browser shows a print dialog: tap *Print* once per request.
7. **To leave tablet mode:** tap the **K** logo 5 times and type the tablet account's password.

Staff can preview the screen from Settings → Tablet → *Open the tablet screen* (tap the logo 5 times to come back).
Every tablet request appears in the Dispatcher as a normal *Requested* order and in the bell as "New tablet request".

## 9. Notifications

In-app notifications (the bell) are live. Email/SMS are **not** connected; nothing is sent outside the app.
The table `notification_outbox` is ready for a future server-side sender (e.g. a Supabase Edge Function using
Resend or Twilio, with the provider key stored as an Edge Function secret — never in front-end code).

## 10. Monitoring

- Supabase dashboard → **Logs** for API/database errors.
- Supabase dashboard → **Advisors** (security & performance) after any schema change.
- GitHub → **Actions** for test results of each change.
