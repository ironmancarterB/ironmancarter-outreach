-- foreign_keys: off
-- UGC autopilot: autopilot events say which campaign they belong to, and the research pool accepts companies found
-- through public discovery sources (Wikidata), with the source they came from.

ALTER TABLE autopilot_events ADD COLUMN campaign TEXT NOT NULL DEFAULT 'sponsorship' CHECK (campaign IN ('sponsorship', 'ugc'));
CREATE INDEX autopilot_events_campaign ON autopilot_events(campaign, day_key, kind);

CREATE TABLE candidate_pool_new (
  id            INTEGER PRIMARY KEY,
  company_name  TEXT NOT NULL,
  website       TEXT NOT NULL,
  domain        TEXT NOT NULL UNIQUE,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  origin        TEXT NOT NULL CHECK (origin IN ('seed', 'manual', 'csv', 'discovery')),
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'queued', 'researched', 'excluded')),
  note          TEXT,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  source_url    TEXT                                   -- where a discovered company was listed (e.g. its Wikidata item)
);
INSERT INTO candidate_pool_new (id, company_name, website, domain, category_id, origin, status, note, added_at, updated_at)
  SELECT id, company_name, website, domain, category_id, origin, status, note, added_at, updated_at FROM candidate_pool;
DROP TABLE candidate_pool;
ALTER TABLE candidate_pool_new RENAME TO candidate_pool;
CREATE INDEX candidate_pool_status ON candidate_pool(status, category_id);
