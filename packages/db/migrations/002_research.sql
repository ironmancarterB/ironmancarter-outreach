-- Phase 2: brand discovery and prospect research.

-- Your review decision. Only approved companies may enter outreach stages.
ALTER TABLE prospects ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE prospects ADD COLUMN review_note TEXT;
ALTER TABLE prospects ADD COLUMN reviewed_at TEXT;
ALTER TABLE prospects ADD COLUMN last_researched_at TEXT;
CREATE INDEX prospects_review ON prospects(review_status);

ALTER TABLE contacts ADD COLUMN discovered_by TEXT NOT NULL DEFAULT 'manual'
  CHECK (discovered_by IN ('manual', 'research', 'csv'));

ALTER TABLE research_sources ADD COLUMN snippet TEXT;   -- the exact text that supports the finding

-- Brands that could be researched. Each needs only a name and an official website; nothing about
-- them is trusted until a research run fetches the site.
CREATE TABLE candidate_pool (
  id            INTEGER PRIMARY KEY,
  company_name  TEXT NOT NULL,
  website       TEXT NOT NULL,
  domain        TEXT NOT NULL UNIQUE,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  origin        TEXT NOT NULL CHECK (origin IN ('seed', 'manual', 'csv')),
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'queued', 'researched', 'excluded')),
  note          TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX candidate_pool_status ON candidate_pool(status, category_id);

CREATE TABLE research_batches (
  id              INTEGER PRIMARY KEY,
  requested_size  INTEGER NOT NULL CHECK (requested_size IN (20, 50, 100, 200, 500)),
  category_ids    TEXT NOT NULL,                 -- JSON array
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  shortfall_note  TEXT,                          -- why fewer candidates than requested were queued
  ai_provider     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  error           TEXT
);

CREATE TABLE research_candidates (
  id           INTEGER PRIMARY KEY,
  batch_id     INTEGER NOT NULL REFERENCES research_batches(id) ON DELETE CASCADE,
  pool_id      INTEGER NOT NULL REFERENCES candidate_pool(id),
  company_name TEXT NOT NULL,
  website      TEXT NOT NULL,
  domain       TEXT NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                 'pending', 'researching', 'done', 'duplicate', 'unreachable', 'blocked', 'failed', 'cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  message      TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  UNIQUE (batch_id, domain)
);
CREATE INDEX research_candidates_status ON research_candidates(batch_id, status);

-- Every HTTP request research makes, including ones robots.txt told us not to make.
CREATE TABLE research_fetches (
  id             INTEGER PRIMARY KEY,
  candidate_id   INTEGER REFERENCES research_candidates(id) ON DELETE CASCADE,
  prospect_id    INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  url            TEXT NOT NULL,
  final_url      TEXT,
  status_code    INTEGER,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok', 'robots_disallowed', 'http_error', 'not_html', 'too_large', 'network_error', 'timeout')),
  bytes          INTEGER,
  title          TEXT,
  fetched_at     TEXT NOT NULL
);
CREATE INDEX research_fetches_candidate ON research_fetches(candidate_id);
CREATE INDEX research_fetches_prospect ON research_fetches(prospect_id);
