-- Verified-email leads. A brand is only actionable with a qualifying contact; qualification itself is computed
-- from stored facts (packages/crm/leads.ts), so it can never go stale or be set by hand.

-- Whether a domain can receive mail at all, from free public DNS. A pass says nothing about one mailbox.
CREATE TABLE mail_domains (
  domain     TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('ok', 'no_mail', 'invalid', 'unknown')),
  detail     TEXT,
  checked_at TEXT NOT NULL
);

-- What each researched brand came to: research batches now count brands with a qualifying email.
ALTER TABLE research_candidates ADD COLUMN qualified INTEGER CHECK (qualified IN (0, 1));
ALTER TABLE research_candidates ADD COLUMN exclusion_reason TEXT;
CREATE INDEX research_candidates_qualified ON research_candidates(batch_id, qualified);
