-- Phase 3: personalized pitches, sponsorship packages, manual applications. Draft mode only: nothing here sends.

CREATE TABLE sponsorship_packages (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  deliverables    TEXT NOT NULL,
  price_min_cents INTEGER CHECK (price_min_cents >= 0),
  price_max_cents INTEGER CHECK (price_max_cents >= 0),
  price_unit      TEXT NOT NULL DEFAULT 'flat' CHECK (price_unit IN ('flat', 'per_month', 'custom')),
  recurring       INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order      INTEGER NOT NULL,
  notes           TEXT,
  updated_at      TEXT NOT NULL,
  CHECK (price_min_cents IS NULL OR price_max_cents IS NULL OR price_max_cents >= price_min_cents)
);

-- Your correction when the automatic program classification is wrong.
ALTER TABLE prospects ADD COLUMN program_type_override TEXT
  CHECK (program_type_override IN ('paid_sponsorship', 'creator_partnerships', 'affiliate_only', 'unknown'));

CREATE TABLE pitches (
  id              INTEGER PRIMARY KEY,
  prospect_id     INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'manual_form')),
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  recipient_email TEXT,                       -- snapshot of the proposed recipient
  application_url TEXT,                       -- for manual submissions
  subject         TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  generator       TEXT NOT NULL CHECK (generator IN ('template', 'ollama')),
  ai_model        TEXT,
  generation_note TEXT,                       -- e.g. why the template was used instead of local AI
  options         TEXT NOT NULL,              -- JSON: package, rates, deliverables, concept
  claims          TEXT NOT NULL,              -- JSON: each personalized sentence and the evidence behind it
  flags           TEXT NOT NULL,              -- JSON: missing information found at generation time
  media_kit_id    INTEGER REFERENCES media_kits(id),
  edited          INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  reviewed_at     TEXT,
  reject_reason   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (prospect_id, version)
);
CREATE INDEX pitches_status ON pitches(status);
-- At most one live (draft or approved) pitch per company and channel.
CREATE UNIQUE INDEX pitches_one_live ON pitches(prospect_id, channel) WHERE status IN ('draft', 'approved');

-- Creator portals and contact forms. You submit these yourself; the app never fills in or submits forms.
CREATE TABLE manual_applications (
  id               INTEGER PRIMARY KEY,
  prospect_id      INTEGER NOT NULL UNIQUE REFERENCES prospects(id) ON DELETE CASCADE,
  application_url  TEXT NOT NULL,
  url_origin       TEXT NOT NULL CHECK (url_origin IN ('research', 'manual')),
  url_retrieved_at TEXT,                      -- when research fetched this page (NULL if you added it)
  status           TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
                     'not_started', 'ready', 'submitted', 'responded', 'accepted', 'declined', 'no_response')),
  submitted_at     TEXT,
  follow_up_date   TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
