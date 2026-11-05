-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Hidden apps become Off (A5, gate G-P3-1 default: hidden -> disabled).
--
-- `organizations.settings.hiddenApps` (surface-only hiding) is replaced by the
-- per-workspace On/Off state on `kernel.apps.status`. Every app an org listed
-- there is turned Off for that org (its jobs, webhooks and tools stop; its data
-- stays) and the key is removed. An app listed but not yet registered in the
-- org gets its row now, Off, so its first registration keeps it Off
-- (registration preserves an existing row's status). `kernel` is never an app
-- row; `knowledge` and `contacts` can never be Off, so a listing of them is
-- simply dropped with the key (they stay On). Reversible by a follow-up migration that sets the rows back to active.
-- Idempotent: only orgs still carrying the key are touched.
INSERT INTO kernel.apps (org_id, name, version, status)
SELECT o.id, h.app, '0.0.0', 'disabled'
FROM kernel.organizations o
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(o.settings -> 'hiddenApps') = 'array'
    THEN o.settings -> 'hiddenApps' ELSE '[]'::jsonb END
) AS h(app)
WHERE o.settings ? 'hiddenApps' AND h.app NOT IN ('kernel', 'knowledge', 'contacts', '')
ON CONFLICT (org_id, name) DO UPDATE
  SET status = 'disabled', updated_at = now()
  WHERE kernel.apps.status IN ('active', 'error');
--> statement-breakpoint
UPDATE kernel.organizations
SET settings = settings - 'hiddenApps', updated_at = now()
WHERE settings ? 'hiddenApps';
