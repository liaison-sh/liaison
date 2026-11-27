-- SPDX-License-Identifier: FSL-1.1-ALv2
-- expand-only
-- kernel.buyer_invoice_keys / kernel.buyer_invoice_links: the server keys a shop's own website
-- reads its buyers' invoices with (modules/buyer-invoices), and the short-lived download links
-- they mint. A key belongs to one org and one invoicing issuer profile; only its SHA-256 and its
-- first 8 characters are kept. A link keeps only the SHA-256 of its token, is bound to one
-- document and the key that minted it, and lives 5 minutes. Privileged pool only (RLS forced,
-- no policy): the public routes look a key up before any org is known.
--
-- New tables, every statement re-runnable: the previous release never reads them.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.buyer_invoice_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  issuer_profile_id uuid NOT NULL,
  label text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  last_used_at timestamptz,
  CONSTRAINT buyer_invoice_keys_hash_uq UNIQUE (key_hash)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS buyer_invoice_keys_prefix_idx ON kernel.buyer_invoice_keys (key_prefix);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS buyer_invoice_keys_profile_idx
  ON kernel.buyer_invoice_keys (org_id, issuer_profile_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kernel.buyer_invoice_links (
  token_hash text NOT NULL PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  key_id uuid NOT NULL REFERENCES kernel.buyer_invoice_keys(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS buyer_invoice_links_expiry_idx ON kernel.buyer_invoice_links (expires_at);
--> statement-breakpoint
ALTER TABLE kernel.buyer_invoice_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.buyer_invoice_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.buyer_invoice_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.buyer_invoice_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kernel.buyer_invoice_keys FROM liaison_rls;
--> statement-breakpoint
REVOKE ALL ON kernel.buyer_invoice_links FROM liaison_rls;
