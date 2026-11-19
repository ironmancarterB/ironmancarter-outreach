# IronmanCarter Sponsorship Outreach

Local-first command center for researching sponsors, a sponsorship CRM, and sending reviewed outreach through Gmail
(one email at a time, never bulk/auto). TypeScript monorepo: `apps/server` (API), `apps/worker`, web UI (Vite), `packages/*`.
See README.md for the full guide.

## Install and run
- Node.js 24+
- `npm install`
- `npm run db:migrate`: create/upgrade the local SQLite database
- `npm run dev`: API + web + worker together
- `npm test` (vitest), `npm run typecheck`

## Environment variables (names only)
`ANTHROPIC_API_KEY` (optional), `OUTREACH_API_PORT`, `OUTREACH_WEB_PORT`, `OUTREACH_DATA_DIR`.
Gmail OAuth client ID/secret and refresh tokens are entered in the app and stored in the local database, not in env files.

## Not in git
`data/`: `outreach.db` (the CRM + Gmail tokens), `backups/`, `media-kit/`, logs. Copy it by hand when moving machines.
