-- Phase 4: Gmail connection and Gmail drafts. Drafts only: nothing in this schema or its code sends email.

-- The Google account the app is connected to. One active account at a time; the address is configurable
-- (gmail.expectedAccount) so a future business-domain mailbox can replace it. Tokens live in the macOS
-- Keychain, never in this database.
CREATE TABLE mail_accounts (
  id              INTEGER PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('gmail')),
  email           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  scopes          TEXT NOT NULL,                -- JSON array of granted scopes
  secret_ref      TEXT NOT NULL,                -- Keychain item holding the refresh token
  connected_at    TEXT NOT NULL,
  last_checked_at TEXT,
  last_error      TEXT,
  disconnected_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX mail_accounts_one_active ON mail_accounts(provider) WHERE status != 'disconnected';

-- Every Gmail draft the app created (or tried to create). 'uncertain' means the request may have reached
-- Google but no answer came back; it is never retried automatically and must be checked against Gmail.
CREATE TABLE gmail_drafts (
  id                     INTEGER PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('pitch', 'test')),
  pitch_id               INTEGER REFERENCES pitches(id) ON DELETE SET NULL,
  prospect_id            INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  account_id             INTEGER NOT NULL REFERENCES mail_accounts(id),
  status                 TEXT NOT NULL CHECK (status IN ('creating', 'created', 'uncertain', 'failed', 'gone', 'unlinked')),
  local_ref              TEXT NOT NULL UNIQUE,  -- carried in the MIME boundary so the draft can be found again
  rfc822_message_id      TEXT NOT NULL,         -- the Message-ID Gmail assigned ('' until read back)
  gmail_draft_id         TEXT UNIQUE,
  gmail_message_id       TEXT,
  gmail_thread_id        TEXT,
  recipient              TEXT NOT NULL,
  subject                TEXT,
  content_sha256         TEXT NOT NULL,         -- recipient + subject + body + attachment, to spot stale drafts
  media_kit_id           INTEGER REFERENCES media_kits(id),
  attachment_filename    TEXT,
  attachment_sha256      TEXT,
  attachment_check       TEXT,                  -- JSON: result of reading the draft back from Gmail
  attachment_verified_at TEXT,
  edited_in_gmail        INTEGER NOT NULL DEFAULT 0 CHECK (edited_in_gmail IN (0, 1)),
  last_synced_at         TEXT,
  sync_note              TEXT,
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
-- Duplicate prevention: at most one live Gmail draft per pitch and per company.
CREATE UNIQUE INDEX gmail_drafts_one_live_pitch ON gmail_drafts(pitch_id)
  WHERE status IN ('creating', 'created', 'uncertain') AND pitch_id IS NOT NULL;
CREATE UNIQUE INDEX gmail_drafts_one_live_company ON gmail_drafts(prospect_id)
  WHERE status IN ('creating', 'created', 'uncertain') AND kind = 'pitch' AND prospect_id IS NOT NULL;
CREATE INDEX gmail_drafts_status ON gmail_drafts(status);

-- Audit trail of every Gmail API call. A row is written as 'started' before the request goes out, so a
-- crash mid-request leaves evidence behind.
CREATE TABLE gmail_operations (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER REFERENCES mail_accounts(id),
  draft_row_id   INTEGER REFERENCES gmail_drafts(id),
  operation      TEXT NOT NULL,                 -- connect, profile, create_draft, update_draft, get_draft, list_drafts, revoke
  status         TEXT NOT NULL CHECK (status IN ('started', 'ok', 'failed', 'uncertain')),
  http_status    INTEGER,
  detail         TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX gmail_operations_started ON gmail_operations(started_at);

-- Conversation tracking for later phases (replies, follow-ups). Phase 4 records the draft threads only.
CREATE TABLE email_threads (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES mail_accounts(id),
  prospect_id     INTEGER REFERENCES prospects(id) ON DELETE SET NULL,
  gmail_thread_id TEXT NOT NULL,
  subject         TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'awaiting_reply', 'replied', 'closed')),
  last_message_at TEXT,
  last_synced_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (account_id, gmail_thread_id)
);

CREATE TABLE email_messages (
  id                INTEGER PRIMARY KEY,
  thread_id         INTEGER NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  gmail_message_id  TEXT NOT NULL UNIQUE,
  rfc822_message_id TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  kind              TEXT NOT NULL CHECK (kind IN ('draft', 'sent', 'reply', 'follow_up', 'auto_reply', 'bounce')),
  draft_row_id      INTEGER REFERENCES gmail_drafts(id),
  from_email        TEXT,
  to_email          TEXT,
  subject           TEXT,
  snippet           TEXT,
  message_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX email_messages_thread ON email_messages(thread_id);

-- Follow-up schedule for Phase 5. Nothing writes to it yet.
CREATE TABLE follow_ups (
  id          INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  thread_id   INTEGER REFERENCES email_threads(id) ON DELETE SET NULL,
  sequence    INTEGER NOT NULL CHECK (sequence IN (1, 2)),
  due_at      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'done', 'skipped')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (prospect_id, sequence)
);
