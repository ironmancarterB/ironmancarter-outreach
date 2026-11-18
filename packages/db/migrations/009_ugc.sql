-- foreign_keys: off
-- UGC client acquisition: a second campaign type on the same CRM, research, drafting and sending workflow.
-- Every existing row stays a sponsorship row. A company belongs to exactly one campaign (one CRM record per
-- domain, one first email per company), so the two campaigns can never email the same brand twice.

ALTER TABLE prospects ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'sponsorship' CHECK (campaign_type IN ('sponsorship', 'ugc'));
CREATE INDEX prospects_campaign ON prospects(campaign_type, stage);
-- Researched video ideas for a UGC prospect: JSON [{ title, outline, basis }]. Editable; never sent unless you approve the pitch.
ALTER TABLE prospects ADD COLUMN ugc_concepts TEXT;

ALTER TABLE categories ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'sponsorship' CHECK (campaign_type IN ('sponsorship', 'ugc'));

-- The sponsorship media kit and the UGC rate card / portfolio PDF are kept apart: one default of each kind.
ALTER TABLE media_kits ADD COLUMN kind TEXT NOT NULL DEFAULT 'sponsorship' CHECK (kind IN ('sponsorship', 'ugc'));
DROP INDEX media_kits_one_default;
CREATE UNIQUE INDEX media_kits_one_default ON media_kits(kind) WHERE is_default = 1;

-- Research batches: any size from 1 to 500 (UGC uses 10, 25, 50 or custom), and which campaign they research for.
CREATE TABLE research_batches_new (
  id              INTEGER PRIMARY KEY,
  requested_size  INTEGER NOT NULL CHECK (requested_size BETWEEN 1 AND 500),
  category_ids    TEXT NOT NULL,                 -- JSON array
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  shortfall_note  TEXT,
  ai_provider     TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  error           TEXT,
  campaign_type   TEXT NOT NULL DEFAULT 'sponsorship' CHECK (campaign_type IN ('sponsorship', 'ugc')),
  origin          TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'autopilot', 'daily'))
);
INSERT INTO research_batches_new (id, requested_size, category_ids, status, shortfall_note, ai_provider, created_at, started_at, finished_at, error)
  SELECT id, requested_size, category_ids, status, shortfall_note, ai_provider, created_at, started_at, finished_at, error FROM research_batches;
DROP TABLE research_batches;
ALTER TABLE research_batches_new RENAME TO research_batches;

-- UGC deals. Money in integer cents. Nothing here is ever agreed automatically: every field is yours to set.
CREATE TABLE ugc_deals (
  id                 INTEGER PRIMARY KEY,
  prospect_id        INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  contact_id         INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'interested' CHECK (status IN (
                       'interested', 'negotiating', 'contract_pending', 'booked', 'delivered', 'declined')),
  deliverables       TEXT,
  video_count        INTEGER CHECK (video_count BETWEEN 0 AND 500),
  quoted_cents       INTEGER CHECK (quoted_cents >= 0),
  negotiated_cents   INTEGER CHECK (negotiated_cents >= 0),
  usage_rights       TEXT NOT NULL DEFAULT 'organic' CHECK (usage_rights IN ('organic', 'paid_ads', 'paid_ads_whitelisting', 'perpetual', 'custom')),
  usage_fee_cents    INTEGER CHECK (usage_fee_cents >= 0),        -- licensing priced separately from production
  paid_ads_duration  TEXT,                                        -- e.g. "30 days"
  raw_footage        TEXT NOT NULL DEFAULT 'not_included' CHECK (raw_footage IN ('not_included', 'included', 'extra_fee')),
  exclusivity        TEXT,
  revisions          INTEGER CHECK (revisions BETWEEN 0 AND 20),
  deadline           TEXT,                                        -- YYYY-MM-DD
  contract_status    TEXT NOT NULL DEFAULT 'none' CHECK (contract_status IN ('none', 'drafted', 'sent', 'signed', 'cancelled')),
  payment_status     TEXT NOT NULL DEFAULT 'none' CHECK (payment_status IN ('none', 'invoiced', 'partial', 'paid', 'refunded')),
  amount_paid_cents  INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  recurring          INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  meeting_at         TEXT,                                        -- a call or meeting you booked
  booked_at          TEXT,
  paid_at            TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX ugc_deals_prospect ON ugc_deals(prospect_id);
CREATE INDEX ugc_deals_status ON ugc_deals(status);

-- Customizable email templates. {{variables}} are filled from researched facts; an unfilled one blocks approval.
CREATE TABLE email_templates (
  slug             TEXT PRIMARY KEY,
  campaign_type    TEXT NOT NULL CHECK (campaign_type IN ('sponsorship', 'ugc')),
  kind             TEXT NOT NULL CHECK (kind IN ('initial', 'follow_up_1', 'follow_up_2', 'reply', 'proposal')),
  name             TEXT NOT NULL,
  subject          TEXT,
  body             TEXT NOT NULL,
  default_subject  TEXT,
  default_body     TEXT NOT NULL,
  sort_order       INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
);
