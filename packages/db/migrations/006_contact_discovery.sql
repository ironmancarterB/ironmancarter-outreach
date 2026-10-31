-- Contact discovery upgrade: every contact carries a verification tier, its evidence and a confidence level.
-- Only VERIFIED_DIRECT and confirmed VERIFIED_AGENCY addresses can ever be emailed (subject to every other check).

ALTER TABLE contacts ADD COLUMN contact_tier TEXT NOT NULL DEFAULT 'PUBLIC_UNVERIFIED'
  CHECK (contact_tier IN ('VERIFIED_DIRECT', 'VERIFIED_AGENCY', 'VERIFIED_PORTAL', 'PUBLIC_UNVERIFIED'));
ALTER TABLE contacts ADD COLUMN contact_type TEXT;          -- partnerships, creator_program, affiliate, press, marketing, general, agency, portal, contact_form
ALTER TABLE contacts ADD COLUMN source_category TEXT;       -- official_contact, official_creator, official_affiliate, official_press, official_site, social, agency, professional_profile, directory, manual
ALTER TABLE contacts ADD COLUMN evidence TEXT;              -- why this contact belongs to the brand (quoted text or explanation)
ALTER TABLE contacts ADD COLUMN confidence TEXT CHECK (confidence IN ('high', 'medium', 'low'));
ALTER TABLE contacts ADD COLUMN agency_name TEXT;
ALTER TABLE contacts ADD COLUMN agency_confirmed TEXT CHECK (agency_confirmed IN ('brand_site', 'manual'));
ALTER TABLE contacts ADD COLUMN decision_note TEXT;         -- why it was accepted at this tier
ALTER TABLE contacts ADD COLUMN manually_verified INTEGER NOT NULL DEFAULT 0 CHECK (manually_verified IN (0, 1));
ALTER TABLE contacts ADD COLUMN last_checked_at TEXT;

-- Backfill existing contacts without changing them otherwise.
UPDATE contacts SET contact_tier = 'VERIFIED_DIRECT', confidence = 'high', source_category = 'official_site',
  decision_note = 'Published on the brand''s own site (found by research before this upgrade).', last_checked_at = verified_at
  WHERE email IS NOT NULL AND verification_status = 'verified' AND discovered_by = 'research';
UPDATE contacts SET contact_tier = 'VERIFIED_DIRECT', confidence = 'high', source_category = 'manual', manually_verified = 1,
  decision_note = 'Verified by you.', last_checked_at = verified_at
  WHERE email IS NOT NULL AND verification_status = 'verified' AND discovered_by != 'research';
UPDATE contacts SET contact_tier = 'VERIFIED_PORTAL', contact_type = 'contact_form', confidence = 'high', source_category = 'official_contact',
  decision_note = 'Contact form on the brand''s own site.', last_checked_at = updated_at
  WHERE email IS NULL AND contact_form_url IS NOT NULL;
UPDATE contacts SET contact_type = CASE
    WHEN lower(role) LIKE '%partner%' THEN 'partnerships'
    WHEN lower(role) LIKE '%creator%' OR lower(role) LIKE '%affiliate%' THEN 'creator_program'
    WHEN lower(role) LIKE '%press%' OR lower(role) LIKE '%marketing%' THEN 'press'
    ELSE 'general' END
  WHERE email IS NOT NULL AND contact_type IS NULL;

-- Everything a discovery run saw, accepted or rejected, with the reason. Personal or free-mail addresses are
-- never stored: only a masked form and the reason.
CREATE TABLE contact_findings (
  id          INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES contact_research_runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'portal', 'form', 'agency', 'protected_email', 'social')),
  value       TEXT,                          -- address or URL (masked or NULL when it must not be kept)
  source_url  TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('accepted', 'needs_review', 'rejected')),
  tier        TEXT,
  reason      TEXT NOT NULL,
  evidence    TEXT,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX contact_findings_prospect ON contact_findings(prospect_id, created_at);

-- One "Find more contacts" run per row. Queued runs are picked up by the research worker.
CREATE TABLE contact_research_runs (
  id            INTEGER PRIMARY KEY,
  prospect_id   INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  refresh       INTEGER NOT NULL DEFAULT 0,  -- 1 = ignore the page cache
  reason        TEXT,                        -- manual, backfill
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_cached  INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,                        -- JSON counts
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  queued_at     TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX contact_runs_status ON contact_research_runs(status, id);
-- At most one queued or running run per company.
CREATE UNIQUE INDEX contact_runs_one_active ON contact_research_runs(prospect_id) WHERE status IN ('queued', 'running');

-- What a page contained when it was last read, so identical pages are not fetched again (30-day cache;
-- "Refresh" ignores it). Stores only the extracted contact facts, not the page.
CREATE TABLE research_page_cache (
  url        TEXT PRIMARY KEY,
  final_url  TEXT,
  outcome    TEXT NOT NULL,
  status     INTEGER,
  extracted  TEXT,                            -- JSON
  fetched_at TEXT NOT NULL
);
