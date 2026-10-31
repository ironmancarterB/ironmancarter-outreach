-- Phase 1 foundation: settings, categories, CRM, media kit, creator analytics, AI usage ledger.
-- Money is stored in integer cents. Timestamps are ISO-8601 UTC strings.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  compliance_note TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  research_quota  INTEGER NOT NULL DEFAULT 25 CHECK (research_quota >= 0),
  sort_order      INTEGER NOT NULL
);

CREATE TABLE prospects (
  id                     INTEGER PRIMARY KEY,
  company_name           TEXT NOT NULL,
  name_key               TEXT NOT NULL,          -- normalized name for duplicate hints
  website                TEXT,
  domain                 TEXT,                   -- normalized registrable host, e.g. logitech.com
  category_id            INTEGER REFERENCES categories(id),
  products               TEXT,
  sponsorship_evidence   TEXT,
  campaign_concept       TEXT,
  fit_score              INTEGER CHECK (fit_score BETWEEN 0 AND 100),
  fit_breakdown          TEXT,                   -- JSON: points per factor
  fit_explanation        TEXT,
  research_confidence    TEXT CHECK (research_confidence IN ('low', 'medium', 'high')),
  stage                  TEXT NOT NULL DEFAULT 'discovered' CHECK (stage IN (
                           'discovered', 'researching', 'qualified', 'draft_ready', 'awaiting_approval',
                           'approved_autopilot', 'contacted', 'replied', 'negotiating', 'proposal_sent',
                           'won', 'lost', 'not_interested', 'opted_out', 'paused')),
  potential_value_cents  INTEGER CHECK (potential_value_cents >= 0),
  negotiated_value_cents INTEGER CHECK (negotiated_value_cents >= 0),
  contract_duration      TEXT,
  deliverables           TEXT,
  usage_rights           TEXT,
  payment_status         TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none', 'invoiced', 'partial', 'paid')),
  renewal_date           TEXT,
  next_follow_up_date    TEXT,
  source                 TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'research')),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
-- One CRM record per company domain.
CREATE UNIQUE INDEX prospects_domain_unique ON prospects(domain) WHERE domain IS NOT NULL;
CREATE INDEX prospects_stage ON prospects(stage);
CREATE INDEX prospects_name_key ON prospects(name_key);

CREATE TABLE contacts (
  id                  INTEGER PRIMARY KEY,
  prospect_id         INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  name                TEXT,
  role                TEXT,
  email               TEXT,                      -- stored lowercased
  contact_form_url    TEXT,
  source_url          TEXT,                      -- page where this contact was published
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  verified_at         TEXT,
  jurisdiction        TEXT NOT NULL DEFAULT 'unknown',  -- ISO country code or 'unknown'
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (email IS NOT NULL OR contact_form_url IS NOT NULL)
);
-- The same address can never belong to two records.
CREATE UNIQUE INDEX contacts_email_unique ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX contacts_prospect ON contacts(prospect_id);

CREATE TABLE research_sources (
  id           INTEGER PRIMARY KEY,
  prospect_id  INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT,
  kind         TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('website', 'partnership_page', 'sponsorship_evidence', 'contact', 'other')),
  retrieved_at TEXT NOT NULL,
  notes        TEXT
);
CREATE INDEX research_sources_prospect ON research_sources(prospect_id);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE prospect_tags (
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (prospect_id, tag_id)
);

CREATE TABLE notes (
  id          INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Append-only audit log for everything the app does.
CREATE TABLE activities (
  id          INTEGER PRIMARY KEY,
  prospect_id INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  data        TEXT,                              -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX activities_prospect ON activities(prospect_id, created_at);
CREATE INDEX activities_created ON activities(created_at);

-- Global do-not-contact list. Checked before any outreach.
CREATE TABLE suppressions (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value      TEXT NOT NULL,                      -- lowercased
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'opt_out', 'bounce', 'import')),
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE media_kits (
  id                INTEGER PRIMARY KEY,
  version           INTEGER NOT NULL UNIQUE,
  label             TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename   TEXT NOT NULL UNIQUE,
  sha256            TEXT NOT NULL UNIQUE,
  size_bytes        INTEGER NOT NULL,
  page_count        INTEGER,
  is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  public_url        TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX media_kits_one_default ON media_kits(is_default) WHERE is_default = 1;

CREATE TABLE creator_metrics (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube', 'tiktok', 'twitch', 'combined')),
  metric_key    TEXT NOT NULL,
  label         TEXT NOT NULL,
  value         REAL NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'count' CHECK (unit IN ('count', 'percent', 'hours', 'average')),
  approximate   INTEGER NOT NULL DEFAULT 0 CHECK (approximate IN (0, 1)),
  period_label  TEXT,                            -- e.g. "90 days"; NULL for point-in-time totals
  period_start  TEXT,
  period_end    TEXT,
  as_of         TEXT NOT NULL,                   -- date the figure was reported
  source        TEXT NOT NULL,
  notes         TEXT,
  pitchable     INTEGER NOT NULL DEFAULT 1 CHECK (pitchable IN (0, 1)),
  updated_at    TEXT NOT NULL,
  UNIQUE (platform, metric_key)
);

-- Every AI call (mock, local or paid), including blocked attempts.
CREATE TABLE ai_usage (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  billing        TEXT NOT NULL CHECK (billing IN ('free_mock', 'free_local', 'paid_api')),
  status         TEXT NOT NULL CHECK (status IN ('ok', 'cached', 'blocked', 'error')),
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  est_cost_usd   REAL NOT NULL DEFAULT 0,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX ai_usage_created ON ai_usage(created_at);

CREATE TABLE ai_cache (
  cache_key     TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  response      TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE sending_tiers (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  daily_limit  INTEGER NOT NULL CHECK (daily_limit > 0),
  weekly_limit INTEGER NOT NULL CHECK (weekly_limit > 0),
  sort_order   INTEGER NOT NULL
);
