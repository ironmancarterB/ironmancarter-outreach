# IronmanCarter Sponsorship Outreach

A local-first command center for researching sponsors, managing the sponsorship CRM, and sending approved outreach
through Gmail, one reviewed email at a time. It runs entirely on this Mac.

**Current phase: 5 (reply tracking, follow-ups, manual sending).** **Live sending is OFF** until you switch it on in
Outreach Controls. Even then, every email needs your review and its own confirmation. There is no autopilot, no scheduled
sending and no bulk sending. No paid AI.

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

## Contact discovery

**Contact Discovery** (sidebar) shows how every company can be reached: verified email, verified agency, official portal or
form, needs manual verification, or no contact method. **Find more contacts** queues a bounded, cached research run that the
research worker processes (robots.txt obeyed, one request per site every 1.5 s, at most 14 page fetches plus 2 agency pages,
no logins, no JavaScript, protection never bypassed). **Refresh** ignores the 30-day page cache. **Research all without a
verified email** queues every company that lacks one.

Sources, in priority order: official contact pages; official creator/influencer pages; ambassador/affiliate pages; press and media
pages (including press sites on the brand's other domains); the site's sitemap for those pages; official social profiles (listed for
you to check: they need a login, so they are not read); agency pages the brand itself links to for PR or partnership inquiries.
Professional profiles and business directories are manual entry only (they require logins, forbid automated access, or charge).

| Tier | Meaning | Can be emailed? |
|---|---|---|
| `VERIFIED_DIRECT` | A business mailbox the brand publishes on its own site (or its structured contact data), on its domain or a domain it demonstrably owns (e.g. the domain research was redirected from) | Yes, after every other check (country, approval, compliance, confirmation) |
| `VERIFIED_AGENCY` | An agency address with evidence it represents the brand | Only once independently confirmed: named on the brand's own site, or confirmed by you |
| `VERIFIED_PORTAL` | An official application portal or contact form linked from the brand's own program/contact page | No: you submit it yourself (Manual submissions) |
| `PUBLIC_UNVERIFIED` | Public but unconfirmed (e.g. only in a page's embedded data, or on another domain without explanation) | No, until you verify it |

Every contact stores the company, type, address or URL, exact source URL, date verified, source category, evidence (the text around
it, with any other addresses removed), tier and confidence, plus why it was accepted. Every rejected address is listed with its
reason; personal-looking and free-mail addresses are recorded only in masked form. Addresses are never guessed or derived from names,
nothing comes from private databases, and suppressed addresses are skipped. A research contact that is no longer on its source page
is marked failed; contacts you entered or verified are never changed. **Add manually** requires the source page and evidence and
applies the same tier rules; **Verify…** upgrades a public contact after you check it (agencies need the brand-side confirmation).

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
5. **Data access → Add or remove scopes →** `https://www.googleapis.com/auth/gmail.compose` and `https://www.googleapis.com/auth/gmail.readonly` (only these two).
6. **Clients → Create client → Desktop app → Create → Download JSON.**
7. In the app: **Settings → Gmail**, paste the JSON, **Save OAuth client**, then **Connect**. Sign in on Google's page, approve, and the
   page confirms the connection. Google may warn that the app is unverified; that is expected for your own private app.

### How it works

- **Sign-in:** Google's OAuth for installed apps (loopback redirect to `127.0.0.1:5181`, PKCE, single-use state). You type your
  password only on Google's own page; the app never sees it.
- **Permissions:** see "Gmail permissions" under Phase 5. Connections that grant anything beyond `gmail.compose` and `gmail.readonly`
  are discarded and revoked.
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
- **Gmail API quota** is free and far above what this app uses.
- **Open in Gmail** uses Gmail's `#drafts?compose=<message id>` web link with your account selected.

## Reply tracking, follow-ups and manual sending (Phase 5)

### Gmail permissions

| Scope | Why | What it can do |
|---|---|---|
| `gmail.compose` (Phase 4) | Create/update drafts; `drafts.send` for a draft you confirmed | Manage drafts and send email. The app sends only via the confirmed-draft path. |
| `gmail.readonly` (new) | Read replies, threads and Sent Mail; search for replies from contacts; reconcile uncertain sends | Read mail and settings. **Cannot** delete, label, archive or send. |

Never requested: full access (`https://mail.google.com/`) and `gmail.modify`. `gmail.metadata` was considered and rejected: Google
does not allow search (`q`) or message bodies with it, so it cannot find replies or classify them. Both scopes are "restricted"; for
your own unverified app that means the "Google hasn't verified this app" screen, no extra cost.

**Reconnecting (once):** Settings → Gmail → **Reconnect Gmail**, sign in as ironmancarterbusiness@gmail.com, choose Advanced → Go to
the app, and leave both boxes ticked. Add the `gmail.readonly` scope under Data access in Google Cloud first. The refresh token in the
Keychain is replaced; the old one is not revoked (revoking would also end the new grant). Drafts keep working without read access.

### What the app reads

Only (1) Gmail threads that started from an email the app sent (or you sent from an app draft) and (2) messages **from the exact
addresses you emailed**, received after you emailed them. Nothing else in your mailbox is listed, read or stored.

### Conversations and classification

**Outreach → Check Gmail for replies** (or the Conversations tab) reads those threads. Each message is stored once (Gmail message ids
are unique in the database). Replies are linked to the company and, when the address is in the CRM, to the contact. Anything else
(another domain, a new address, a reply outside the original thread) is flagged **Needs review**. Replies are classified as Interested,
Needs more information, Negotiating, Not interested, Out of office, Wrong contact, Referral or Unclear:

- Rules first, conservatively: one clear signal wins; mixed or vague replies are "Unclear" for you to decide.
- With Ollama selected, the local model may classify, but only if it quotes the reply word for word; otherwise its answer is ignored.
- You can change any classification. The app never replies, negotiates or accepts anything.
- "Unsubscribe"-style replies add the sender to the do-not-contact list (opt-out) and stop follow-ups.

CRM stages change automatically only forward and only from outreach stages: Qualified/Draft Ready/Awaiting Approval → **Contacted**
when the first email is sent, Contacted → **Replied** when the brand replies. Each change is logged with its reason. Stages you set
yourself (Negotiating, Paused, Won …) are never overwritten. First contact, last contact and last reply dates are recorded; deal
value, deliverables, usage rights, negotiation notes and the final outcome are yours to edit.

### Email signature

Every outbound sponsorship email (template and local-AI pitches, manual messages, follow-ups, Gmail drafts) ends with your signature
from **Settings → Business → Email signature** (default `Best,` / `Carter`). Any other sign-off (for example the old
"Best, IronmanCarter, ironmancarterbusiness@gmail.com") is replaced, and stacked sign-offs are collapsed, so regenerating or editing
never doubles it; a trailing "P.S." stays below the signature. The compliance footer (postal address and opt-out line) is added
separately beneath it. Saving a new signature updates every unsent pitch and pending follow-up, and updates their Gmail drafts in place
(same draft, never sent). Drafts you changed in Gmail are left alone and reported. Sent emails and conversation history are never
changed. Your sender address and display name are not affected.

### Follow-ups

After a first email is sent, two follow-ups are scheduled for **your review**: 5 and 12 business days later (configurable), counted
in your business time zone on your business days, skipping holidays you list in Outreach Controls. They are written fresh (not copied
from the pitch; a check blocks repeated sentences) and go out as replies in the same Gmail thread. Approve, edit, reschedule, skip or
cancel each one. They are cancelled automatically when the brand replies or bounces, when the address or domain is suppressed, or when
the company moves to Replied, Negotiating, Proposal Sent, Won, Lost, Not Interested, Opted Out or Paused. Out-of-office replies do not
cancel them. **None is ever sent automatically**; right before one is prepared or sent, its thread is re-read for new replies.

### Manual sending

1. Approve the pitch, create its Gmail draft (the draft adds your postal address and an opt-out line).
2. Outreach → **Sending queue** → **Review & send…** checks every safeguard and reads the draft back from Gmail: live sending on,
   STOP not active, correct account and permissions, brand approved and ready for first contact, one sequence per company, pitch
   approved with no blockers, contact verified and **eligible** (unknown or non-US countries are not eligible), not suppressed,
   compliance footer present, Gmail draft identical to the approved text and media kit (SHA-256), and today's limits.
3. You see the exact From, To, Subject, body and attachment, tick that you reviewed it, and press Send. The confirmation expires
   after 10 minutes and works once. The server repeats every check and the Gmail read-back before sending.
4. The app sends **that one Gmail draft** (`drafts.send`). A sent draft no longer exists, so it cannot be sent twice.

If Google's answer is lost, the send is **SEND STATUS UNCERTAIN** and is never retried. **Reconcile** checks Gmail (read-only): if the
draft is still in Drafts it was not sent; if the message is in the thread or Sent Mail (matched by its MIME-boundary reference) it was
sent once. If neither, you check Gmail yourself and record the outcome. A crash mid-send also leaves an uncertain record.
If you send an app draft from Gmail yourself, the next sync records it like an app send.

### Controls

- **Live sending** is off by default and not changed by connecting Gmail or by tests. Outreach Controls switches it on only when the
  checklist passes (account, both scopes, matching business email, postal address, STOP off) and you type `ENABLE MANUAL SENDING`.
- **STOP ALL OUTREACH** blocks every send immediately and voids prepared confirmations. Nothing is deleted. Resume needs confirmation.
- **Daily ceilings** (server-side, from send records, so they survive restarts): 10 new, 5 follow-ups, 15 total per day, and the
  sending tier's limit (Testing: 5/day, 25/week). Uncertain sends count. Unused capacity is never filled.

### Limitations

- **Real sending is untested.** All sending tests use a fake Gmail server. Nothing has been sent for real; that waits for your
  authorization.
- **Replies from new addresses in a new thread** (for example a colleague starting a fresh email) are not found unless they reply in
  the original thread; the app does not search whole company domains, to avoid reading newsletters.
- **Classification is best-effort.** Rules are deliberately conservative and many replies will be "Unclear" for you to classify.
- **Holidays** are only the ones you list.
- **Sync is manual** ("Check Gmail for replies"); nothing polls Gmail in the background.

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
| `packages/research/` | Polite fetcher + robots.txt, page extraction, evidence detection, scoring, research pipeline, batches, durable worker queue, contact discovery (`contacts.ts`) and manual contact review (`contactReview.ts`). |
| `apps/worker/` | The research worker process (`npm run worker`). Safe to stop any time; interrupted work resumes. |
| `packages/pitch/` | Fact gathering, program classification, template writer, local-AI writer, checks, evidence validation, approvals, manual applications, packages. |
| `packages/gmail/` | Google OAuth + Gmail client (`google.ts`; the only send call needs a confirmation from `outreach/send.ts`), Keychain secret storage, MIME builder/parser, connection and draft services. |
| `packages/outreach/` | Business days, reply classification, conversation sync, follow-ups, manual sending (prepare → confirm, limits, STOP, reconciliation), dashboard data, automatic stage rules. |
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
- "Approved for Autopilot" cannot be set by hand or by CSV import (autopilot does not exist).
- Every send needs a fresh, single-use confirmation of the exact message; uncertain sends are never retried.
- Every change is written to the audit log (Settings → Audit log).
