-- Autopilot: automatic sending of first emails and follow-ups to qualifying brands, within hard daily limits.
-- Every send still goes through the same checks and duplicate protection as a manual send.

-- Who started each send: you (after the confirmation dialog) or autopilot.
ALTER TABLE send_attempts ADD COLUMN initiated_by TEXT NOT NULL DEFAULT 'you';

-- What autopilot did and why, one row per decision (sent, skipped, dry run, paused, error...).
CREATE TABLE autopilot_events (
  id           INTEGER PRIMARY KEY,
  day_key      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('sent', 'dry_run', 'skipped', 'error', 'paused', 'enabled', 'disabled', 'research', 'sync', 'report')),
  prospect_id  INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  follow_up_id INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  send_id      INTEGER REFERENCES send_attempts(id) ON DELETE SET NULL,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX autopilot_events_day ON autopilot_events(day_key, kind);

-- Brands or follow-ups autopilot gave up on for now, so it does not retry them every minute.
CREATE TABLE autopilot_holds (
  key        TEXT PRIMARY KEY,               -- p:<prospect id> or f:<follow-up id>
  reason     TEXT NOT NULL,
  until      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Daily summaries and weekly performance reports. One per period: a job that runs twice writes it once.
CREATE TABLE autopilot_reports (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period_key TEXT NOT NULL,
  summary    TEXT NOT NULL,                  -- JSON numbers
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, period_key)
);
