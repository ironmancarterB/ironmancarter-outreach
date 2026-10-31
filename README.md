# IronmanCarter Sponsorship Outreach

A local-first command center for researching sponsors, managing the sponsorship CRM and (in later phases)
sending approved outreach through Gmail. It runs entirely on this Mac.

**Current phase: 4 (Gmail drafts).** The app can connect your Gmail account and turn approved pitches into **Gmail
drafts**. It contains **no email-sending code** and no paid AI. Autopilot, live sending, sending tiers and paid AI are locked.

## Launch it

Requires Node.js 24 or newer (this Mac has Node 26).

```bash
npm install
```

```bash
npm run dev
```

Then open **http://localhost:5180**. Press `Ctrl + C` in Terminal to stop.

`npm run dev` starts three processes: the API on `127.0.0.1:5181`, the dashboard on `localhost:5180`, and the
research worker (no port; it reads public websites when a research batch is queued). The API and dashboard
listen on this computer only. (Your creator dashboard keeps using 5173.)

### Single-process mode

```bash
npm run build
```

```bash
npm start
```

Then open **http://localhost:5181**.

## Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs the automated test suite (uses in-memory databases; never touches `data/`). |
| `npm run typecheck` | TypeScript check across server, dashboard and tests. |
| `npm run db:migrate` | Applies database migrations (also automatic on server start). |
| `npm run media-kit:import -- "/path/kit.pdf" --label "Name" --default` | Imports a media kit PDF from the command line. |

## Brand discovery (Phase 2)

Brand Discovery → **Run research** queues 20/50/100/200/500 brands from the candidate pool. Categories with
higher priority go first; categories with the same priority take turns; each is capped by its research quota.
Batches are never padded: if fewer candidates exist, the shortfall is recorded.

For each brand the worker:

1. Skips it if the domain (or the domain it redirects to) is already in the CRM.
2. Fetches robots.txt and obeys it for every request, including redirects. A server error on robots.txt means "do not crawl".
3. Visits the homepage and up to 7 partnership/contact pages, one request per site every 1.5 s, HTML only, no logins,
   no JavaScript, no bypassing of bot protection (a 403 is recorded as "blocked").
4. Records creator-partnership evidence (creator/affiliate/ambassador programs, influencer partnerships, esports sponsorships)
   with the page URL, the exact quoted sentence and the fetch time.
5. Keeps only business mailboxes published on the brand's own domain (partnerships@, influencers@, press@, hello@ …),
   marked verified with the page they appeared on. Personal-name, support/legal/careers and other-domain addresses are never stored.
6. Scores fit (audience, evidence, recurring potential, product, contact quality, integration) with a written explanation.
7. Adds the company at stage Discovered, **awaiting your review**. Only approved companies can move into outreach stages.

Contact-form-only brands go to the **Manual contact queue**. Research contacts start with jurisdiction "unknown", so they
always need your review before any future automated email. **Re-check sources** on a company re-fetches each source page
and marks addresses that disappeared as failed.

The candidate pool starts with ~210 real brands across the eight categories (names and official websites only, in
`packages/db/brandSeeds.ts`). Add more under Brand Discovery → Candidates. With the Ollama provider selected, campaign
concepts are drafted locally from the recorded facts; otherwise a per-category template is used.

## Pitches and approval (Phase 3)

1. Approve companies in **Brand Discovery → Review queue**. Only approved companies can be drafted.
2. **Email Drafts → Ready to draft** lists approved companies, best first (published creator partnerships, then fit and
   contact quality). Choose **Draft email** (verified mailbox) or **Draft manual message** (creator portal / contact form).
3. The pitch editor shows the proposed recipient and its verification, the subject and body (editable), the media kit
   attachment reference, every check, missing information, and the evidence behind each personalized sentence.
4. **Save draft**, **Regenerate** (with a package, rates, custom deliverables or your own collaboration idea), **Approve** or
   **Reject**. Editing an approved pitch withdraws the approval. Regenerating keeps the old version in history.

How pitches are written:

- Only from verified facts: recorded research evidence (with its quoted text), your creator analytics marked "may be quoted",
  your packages, and the default media kit. Missing information is flagged, never filled in.
- Programs are classified from evidence: **paid sponsorships** (a source mentions payment), **creator partnerships (pay not
  stated)**, **affiliate only** (the pitch asks about a paid sponsorship instead) or **none found**.
- Prices appear only when you tick "include rate" for a package or type custom rate wording.
- Checks block approval for invented numbers, promises about results, implied past relationships, references to budgets,
  unrequested prices, foreign email addresses or links, placeholders, misleading subjects, a missing signature, an ineligible
  recipient, and category guardrails (no anonymity/security guarantees for VPNs; no minors or health/performance claims for
  energy drinks). Generic mass-email phrasing and lengths outside 100–150 words are warnings.
- With the **mock** provider (default) pitches come from the template. With **Ollama** selected, the local model writes a draft
  citing numbered facts; it is used only if every citation is real and it passes the checks, otherwise the template is used
  and the reason is shown. No other provider is ever tried. (Thinking models such as gemma4 run with thinking turned off.)

Manual submissions: the app stores the verified creator portal / form URL (pages research fetched are marked verified; URLs you
add must be on the brand's own domain), drafts a tailored message, and tracks status and follow-up dates. **You** open the page
and submit; "I submitted it" records it and sets a one-week follow-up. Forms are never filled in or submitted automatically.

The email attachment is the default media kit version (file and checksum verified). Phase 4 attaches it to Gmail drafts.

## Gmail drafts (Phase 4)

Approved email pitches can become drafts in your Gmail **Drafts** folder, with the default media kit attached. The app cannot
send them: it has no send code, the Gmail client refuses any send endpoint, and approving a pitch is not permission to send.

### One-time setup (free; about 10 minutes)

Google requires every app that uses the Gmail API to have its own OAuth client. It costs nothing and needs no billing account.

1. Open https://console.cloud.google.com/projectcreate signed in as `ironmancarterbusiness@gmail.com` and create a project.
2. **APIs & Services → Library → Gmail API → Enable.**
3. **Google Auth Platform → Get started** (the OAuth consent screen): app name, support email, audience **External**, contact email.
4. **Audience → Test users → Add** `ironmancarterbusiness@gmail.com`.
5. **Data access → Add or remove scopes →** `https://www.googleapis.com/auth/gmail.compose` (only this one).
6. **Clients → Create client → Desktop app → Create → Download JSON.**
7. In the app: **Settings → Gmail**, paste the JSON, **Save OAuth client**, then **Connect**. Sign in on Google's page, approve, and the
   page confirms the connection. Google may warn that the app is unverified; that is expected for your own private app.

### How it works

- **Sign-in:** Google's OAuth for installed apps (loopback redirect to `127.0.0.1:5181`, PKCE, single-use state). You type your
  password only on Google's own page; the app never sees it.
- **Permission:** only `gmail.compose`, the narrowest scope that can create drafts (Google documents `drafts.create` as needing
  `mail.google.com`, `gmail.modify` or `gmail.compose`). Google's own description of it is "Manage drafts and send emails". The app
  uses it only for drafts and the account address. Connections that grant anything else are discarded and revoked.
- **Only one account:** the app refuses any account other than **Settings → Business → Gmail sending account** and revokes its access.
  To move to a business-domain mailbox later: disconnect, change that setting, connect the new account.
- **Secrets:** the OAuth client and refresh token are stored in the **macOS Keychain** (service "IronmanCarter Outreach"), never in the
  database, `.env`, the project folder or Git. Access tokens live in memory only. **Disconnect** revokes access at Google and deletes the token.
- **Creating a draft:** Email Drafts → open an approved email pitch → **Create Gmail draft** (with a confirmation). The app re-runs every
  pitch check, confirms the recipient isn't suppressed, and confirms the media kit file still matches its recorded SHA-256.
- **Verification:** after creating a draft, the app reads it back from Gmail in raw form and checks the recipient, subject, sender, body and
  the attachment's file name, size and SHA-256 against media kit v1. The result is shown on the pitch.
- **Duplicates:** one live Gmail draft per pitch and per company (database-enforced). A regenerated pitch updates the existing draft
  (same Gmail draft ID) instead of creating another. If you changed the draft in Gmail, updating needs your explicit go-ahead.
- **Lost responses are never retried:** if Google doesn't answer (timeout, network or server error), or the app stops mid-request, the draft is
  marked **status uncertain**. **Check Gmail** searches your drafts for the draft's unique reference, which the app writes into the
  message's MIME boundary (Gmail replaces any Message-ID an app sets, but keeps the boundary). If it isn't found, only you can mark it
  "not created", which allows a new attempt. After creation the app records the Message-ID Gmail assigned, for matching replies later.
- **Sync with Gmail** checks that each draft still exists and whether you changed it in Gmail. A draft that disappeared was sent or deleted by
  you in Gmail; telling those apart requires read access to Sent Mail (Phase 5).
- **Audit trail:** every Gmail API call is logged (Settings → Gmail → activity), and every draft event goes to the audit log.
- **Test draft:** Settings → Gmail → **Create test draft to myself** makes one draft ("TEST - IronmanCarter Sponsorship Outreach") addressed
  to your own account, with the media kit, so you can test without involving any brand. Verified live on 2026-10-31.
- **Later phases:** `email_threads`, `email_messages` and `follow_ups` tables are in place; the draft's Gmail thread is recorded now so
  replies and follow-ups can be matched later.

### Limitations

- **Weekly reconnect in Testing mode.** Google expires refresh tokens after 7 days for apps whose consent screen is in "Testing" status. The app
  then shows "Reconnect needed". Publishing the app to "In production" removes the 7-day limit but shows an "unverified app" warning on sign-in
  (allowed for personal use; full verification of this restricted scope requires a paid security assessment and is not needed here).
- **No reply detection yet.** Reading replies and Sent Mail needs a read scope (`gmail.readonly` or `gmail.metadata`), which will be requested
  in Phase 5 with your approval.
- **Gmail API quota** is free and far above what this app uses.
- **Open in Gmail** uses Gmail's `#drafts?compose=<message id>` web link with your account selected.

## Where things live

| Path | Contents |
|---|---|
| `apps/web/` | React + Vite + Tailwind dashboard (12 sections). |
| `apps/server/` | Fastify API. `settingsPolicy.ts` decides which settings can change and which are locked. |
| `packages/db/` | SQLite (Node's built-in `node:sqlite`), migrations in `migrations/`, defaults in `seed.ts`. |
| `packages/core/` | Pure rules: pipeline stages, normalization and deduplication keys, fit scoring, eligibility, CSV. |
| `packages/crm/` | Companies, contacts, tags, notes, suppression list, CSV import/export, overview numbers, creator analytics. |
| `packages/mediakit/` | Media kit versions (copied into `data/media-kit/`, never modified or deleted). |
| `packages/ai/` | AI router with mock, Ollama and (locked) Anthropic providers, budget guard, cache and usage ledger. |
| `packages/research/` | Polite fetcher + robots.txt, page extraction, evidence detection, scoring, research pipeline, batches, durable worker queue. |
| `apps/worker/` | The research worker process (`npm run worker`). Safe to stop any time; interrupted work resumes. |
| `packages/pitch/` | Fact gathering, program classification, template writer, local-AI writer, checks, evidence validation, approvals, manual applications, packages. |
| `packages/gmail/` | Google OAuth + draft-only Gmail client (`google.ts`), Keychain secret storage, MIME builder/parser, connection and draft services. |
| `scripts/` | Command-line import, migrations, and the one-off media kit email fix. |
| `tests/` | Vitest suites. |
| `data/` | **Git-ignored.** `outreach.db`, media kit versions, and `media-kit/originals/` (your untouched original PDF plus the corrected copy). Gmail tokens are not here; they are in the macOS Keychain. |

## Media kit

- Your original `~/Downloads/Content Media Kit Final.pdf` was never modified. A byte-identical backup is in
  `data/media-kit/originals/Content Media Kit Final (original, incorrect email).pdf`.
- The corrected copy changes only the contact email (`Ironmancaerterbusiness@…` → `ironmancarterbusiness@gmail.com`).
  Every byte before that one text object is identical to the original, and page 1 renders pixel-identical.
- It is imported as **v1, the default attachment**. Upload new versions from the Media Kit page.

## AI and costs

| | Billing | Status |
|---|---|---|
| Claude Code (building this app) | Your Claude Pro subscription | Signed in with your subscription; no API key in the environment; extra usage off. |
| Mock provider | Free, offline | **Default.** |
| Ollama | Free, runs on this Mac | Optional. Select it in Settings → AI & costs. |
| Anthropic API | Paid per token to an API key, separate from your subscription | **Locked.** Not installed. Needs your approval, verified prices, a budget above $0 and an API key. |

The monthly paid-AI budget is **$0**. The router uses only the selected provider and never falls back to
another one, so a failing free provider can never trigger a paid call. Every call (including blocked and
cached ones) is logged in Settings → AI & costs.

## Safety rules built in so far

- Writes to the API require a header that other websites cannot send; requests to non-local host names are refused.
- One CRM record per company domain; one record per contact email; similar names need confirmation.
- A contact can be marked verified only when it has a source URL; changing the email or source resets verification.
- Eligibility for automatic outreach requires verified, sourced, fresh, unsuppressed contacts in an allowed
  jurisdiction (default: US only; everything else needs manual review).
- Opting a company out suppresses all its addresses permanently. Opt-out suppressions cannot be removed.
- "Approved for Autopilot" cannot be set by hand or by CSV import.
- Every change is written to the audit log (Settings → Audit log).
