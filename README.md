# 1041GR Daily Report

Daily field reporting for project 1041GR (grave relocation, Shanta Gold Kenya; held in the tracker as 1041GRV2). Field teams fill in one report per team per day on a phone or tablet. It works without signal and sends when there is signal.

- **Live site:** https://pgs-1041gr-daily.henk-a62.workers.dev
- **Owner:** Henk Steyn (COO), PGS Heritage (Pty) Ltd
- **Build notes and decisions:** Claude Project "1041GR Daily reporting"

Operational reporting only: no family, next-of-kin or grave personal data. The form asks teams to use grave and household reference numbers, not names.

## How it is built

| Part | Where it runs | In this repository |
|---|---|---|
| The app (one page, works offline, installs to the home screen) | Cloudflare Worker `pgs-1041gr-daily` (static assets, free plan) | `site/` |
| Database, sign-in, row-level security, change history, photo storage | Supabase project `pgs-1041gr-reporting` (`alevpanognwhxmrnnrfy`, EU Frankfurt), PGS Heritage org | `supabase/db/` |
| Personal sign-in links (until email sign-in via Resend is verified) | Supabase Edge Function `signin-link` | `supabase/functions/signin-link/` |

## Folders

- `site/index.html`, `site/app.js`, `site/app.css`: the app. `site/sw.js`: keeps the app on the phone for offline use. `site/supabase.js`: Supabase JS library (v2.119.0, UMD). `site/xlsx.mini.min.js`: SheetJS 0.18.5, loaded only for the Excel download.
- `supabase/db/`: database changes in the order applied. Supabase's own migration history is the authoritative copy; files 04 and 05 are summaries.
- `supabase/functions/signin-link/`: lets an admin create a one-time sign-in link for an invited person.

## What the app does

- Report sections follow the template: key statistics (planned, up to previous day, today, cumulative, red/amber/green), key information / new comments, activities completed and planned, emerging issues, quotes and photos.
- Running totals are calculated from earlier reports plus any "total before the app" (Admin → Key statistics).
- Yesterday's planned activities become today's completed list.
- Office: Summary tab with the Grave Relocation Programme daily summary (all teams, printable), cumulative per team, and an Excel download of all reports.
- Change history on every report, written by the database.
- Roles: Field (own team), Supervisor (all teams, can lock), Admin (people, teams, key statistics). Only invited emails can sign in. Phones must sign in again after 14 days without use.

## Secrets

None are stored here. The publishable key in `site/app.js` is meant to be public; row-level security protects the data. The service role key exists only inside Supabase.

## Deploying

- **The app:** Cloudflare Workers Builds deploys `site/` automatically on every push to `main` (deploy command `npx wrangler deploy`). When changing `site/`, bump `VERSION` in `site/sw.js` and `APP_VERSION` in `site/app.js`, so phones offer "A new version is ready".
- **Database and function:** deployed to Supabase; changes are recorded here afterwards.

## History

| Version | Date | What changed |
|---|---|---|
| 1.3.2 | 17 Nov 2026 | Sign-in links made on the old address now open the new one |
| 1.3.1 | 17 Nov 2026 | Moved to GitHub and a Cloudflare Worker; the old pages.dev address shows a "moved" notice |
| 1.3.0 | 17 Nov 2026 | Daily summary; totals before the app; "up to previous day" column; key statistics from the 16 Nov daily summary |
| 1.2.0 | 6 Nov 2026 | Cancel; change history; Excel download; sign in again after 14 days without use |
| 1.1.0 | 6 Nov 2026 | PGS Heritage logo and colours |
| 1.0.0 | 6 Nov 2026 | First version (Cloudflare Pages direct upload, pgs-1041gr-daily.pages.dev) |
