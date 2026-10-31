-- foreign_keys: off
-- Phase 5: reply tracking, follow-ups and manual sending. Sending is manual only: every email needs your
-- approval and a separate confirmation of the exact message. Nothing here schedules or sends on its own.

-- Deal and contact timeline on the company record (all editable; nothing is estimated).
ALTER TABLE prospects ADD COLUMN first_contacted_at TEXT;
ALTER TABLE prospects ADD COLUMN last_contacted_at TEXT;
ALTER TABLE prospects ADD COLUMN last_reply_at TEXT;
ALTER TABLE prospects ADD COLUMN negotiation_notes TEXT;
ALTER TABLE prospects ADD COLUMN outcome_note TEXT;

-- Every send the app attempted, or found you made from Gmail. A row is written as 'sending' before the
-- request goes out. 'uncertain' = Google's answer was lost; it is never retried automatically.
CREATE TABLE send_attempts (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('initial', 'follow_up')),
  origin            TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'gmail')),  -- gmail = you sent the draft from Gmail
  prospect_id       INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  contact_id        INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  pitch_id          INTEGER REFERENCES pitches(id) ON DELETE SET NULL,
  follow_up_id      INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  draft_row_id      INTEGER REFERENCES gmail_drafts(id),
  account_id        INTEGER NOT NULL REFERENCES mail_accounts(id),
  idempotency_key   TEXT NOT NULL,               -- initial:p<company> or follow_up:<id>
  recipient         TEXT NOT NULL,
  subject           TEXT,
  content_sha256    TEXT NOT NULL,
  attachment_sha256 TEXT,
  status            TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain', 'not_sent', 'failed')),
  gmail_message_id  TEXT,
  gmail_thread_id   TEXT,
  rfc822_message_id TEXT,
  day_key           TEXT NOT NULL,               -- calendar day in your business time zone (daily limits)
  error             TEXT,
  reconcile_note    TEXT,
  confirmed_at      TEXT NOT NULL,
  sent_at           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
-- Duplicate-send protection: one live attempt per message, and one initial outreach per company.
CREATE UNIQUE INDEX send_attempts_one_live ON send_attempts(idempotency_key) WHERE status IN ('sending', 'sent', 'uncertain');
CREATE UNIQUE INDEX send_attempts_one_initial ON send_attempts(prospect_id) WHERE kind = 'initial' AND status IN ('sending', 'sent', 'uncertain');
CREATE INDEX send_attempts_day ON send_attempts(day_key, kind, status);

-- Follow-ups (rebuilt: Phase 4 created this table empty). They wait in a queue for your review; none is
-- ever sent automatically.
DROP TABLE follow_ups;
CREATE TABLE follow_ups (
  id              INTEGER PRIMARY KEY,
  prospect_id     INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  thread_id       INTEGER REFERENCES email_threads(id) ON DELETE SET NULL,
  initial_send_id INTEGER NOT NULL REFERENCES send_attempts(id),
  sequence        INTEGER NOT NULL CHECK (sequence IN (1, 2)),
  due_at          TEXT NOT NULL,
  original_due_at TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'approved', 'sent', 'skipped', 'cancelled')),
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  edited          INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  approved_at     TEXT,
  cancel_reason   TEXT,
  sent_send_id    INTEGER REFERENCES send_attempts(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (initial_send_id, sequence)
);
CREATE INDEX follow_ups_status ON follow_ups(status, due_at);

-- Gmail drafts (rebuilt to allow follow-up drafts and a 'sent' status). Existing rows are copied unchanged.
CREATE TABLE gmail_drafts_new (
  id                     INTEGER PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('pitch', 'test', 'follow_up')),
  pitch_id               INTEGER REFERENCES pitches(id) ON DELETE SET NULL,
  follow_up_id           INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  prospect_id            INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  account_id             INTEGER NOT NULL REFERENCES mail_accounts(id),
  status                 TEXT NOT NULL CHECK (status IN ('creating', 'created', 'uncertain', 'failed', 'gone', 'unlinked', 'sent')),
  local_ref              TEXT NOT NULL UNIQUE,
  rfc822_message_id      TEXT NOT NULL,
  gmail_draft_id         TEXT UNIQUE,
  gmail_message_id       TEXT,
  gmail_thread_id        TEXT,
  recipient              TEXT NOT NULL,
  subject                TEXT,
  content_sha256         TEXT NOT NULL,
  media_kit_id           INTEGER REFERENCES media_kits(id),
  attachment_filename    TEXT,
  attachment_sha256      TEXT,
  attachment_check       TEXT,
  attachment_verified_at TEXT,
  edited_in_gmail        INTEGER NOT NULL DEFAULT 0 CHECK (edited_in_gmail IN (0, 1)),
  last_synced_at         TEXT,
  sync_note              TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
INSERT INTO gmail_drafts_new (id, kind, pitch_id, prospect_id, account_id, status, local_ref, rfc822_message_id, gmail_draft_id, gmail_message_id,
  gmail_thread_id, recipient, subject, content_sha256, media_kit_id, attachment_filename, attachment_sha256, attachment_check, attachment_verified_at,
  edited_in_gmail, last_synced_at, sync_note, error, created_at, updated_at)
SELECT id, kind, pitch_id, prospect_id, account_id, status, local_ref, rfc822_message_id, gmail_draft_id, gmail_message_id,
  gmail_thread_id, recipient, subject, content_sha256, media_kit_id, attachment_filename, attachment_sha256, attachment_check, attachment_verified_at,
  edited_in_gmail, last_synced_at, sync_note, error, created_at, updated_at FROM gmail_drafts;
DROP TABLE gmail_drafts;
ALTER TABLE gmail_drafts_new RENAME TO gmail_drafts;
CREATE UNIQUE INDEX gmail_drafts_one_live_pitch ON gmail_drafts(pitch_id)
  WHERE status IN ('creating', 'created', 'uncertain') AND pitch_id IS NOT NULL;
CREATE UNIQUE INDEX gmail_drafts_one_live_company ON gmail_drafts(prospect_id)
  WHERE status IN ('creating', 'created', 'uncertain') AND kind = 'pitch' AND prospect_id IS NOT NULL;
CREATE UNIQUE INDEX gmail_drafts_one_live_follow_up ON gmail_drafts(follow_up_id)
  WHERE status IN ('creating', 'created', 'uncertain') AND follow_up_id IS NOT NULL;
CREATE INDEX gmail_drafts_status ON gmail_drafts(status);

-- Conversation tracking.
ALTER TABLE email_threads ADD COLUMN contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE email_threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'app';   -- app | reply_search
ALTER TABLE email_threads ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_threads ADD COLUMN review_reason TEXT;
ALTER TABLE email_threads ADD COLUMN last_inbound_at TEXT;
ALTER TABLE email_threads ADD COLUMN last_outbound_at TEXT;

ALTER TABLE email_messages ADD COLUMN contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE email_messages ADD COLUMN send_attempt_id INTEGER REFERENCES send_attempts(id);
ALTER TABLE email_messages ADD COLUMN body_text TEXT;                     -- the new text of a reply (quoted history removed)
ALTER TABLE email_messages ADD COLUMN classification TEXT;
ALTER TABLE email_messages ADD COLUMN classification_source TEXT;         -- rules | ollama | manual
ALTER TABLE email_messages ADD COLUMN classification_note TEXT;
ALTER TABLE email_messages ADD COLUMN classified_at TEXT;
ALTER TABLE email_messages ADD COLUMN opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN review_reason TEXT;
CREATE INDEX email_messages_kind ON email_messages(kind, message_at);

-- Each conversation sync. A run left 'started' by a crash is marked 'interrupted'; the next run simply
-- re-reads the threads (message ids are unique, so nothing is recorded twice).
CREATE TABLE gmail_sync_runs (
  id              INTEGER PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('started', 'ok', 'failed', 'interrupted')),
  threads_checked INTEGER NOT NULL DEFAULT 0,
  messages_added  INTEGER NOT NULL DEFAULT 0,
  detail          TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
