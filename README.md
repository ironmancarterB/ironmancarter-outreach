# IronmanCarter Sponsorship Outreach

A local-first command center for researching sponsors, managing the sponsorship CRM and (in later phases)
sending approved outreach through Gmail. It runs entirely on this Mac.

**Current phase: 1 (Foundation).** This build contains **no email-sending code**, no Gmail connection and
no paid AI. Autopilot, live sending, sending tiers and paid AI are locked.

## Launch it

Requires Node.js 24 or newer (this Mac has Node 26).

```bash
npm install
```

```bash
npm run dev
```

Then open **http://localhost:5180**. Press `Ctrl + C` in Terminal to stop.

`npm run dev` starts two processes: the API on `127.0.0.1:5181` and the dashboard on `localhost:5180`.
Both listen on this computer only. (Your creator dashboard keeps using 5173.)

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
| `scripts/` | Command-line import, migrations, and the one-off media kit email fix. |
| `tests/` | Vitest suites. |
| `data/` | **Git-ignored.** `outreach.db`, media kit versions, and `media-kit/originals/` (your untouched original PDF plus the corrected copy). |

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
