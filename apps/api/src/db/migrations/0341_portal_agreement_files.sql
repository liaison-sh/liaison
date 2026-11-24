-- SPDX-License-Identifier: FSL-1.1-ALv2
-- What a client reads of an agreement's files, and the signing link behind a share made on
-- the agreement itself.
--
--   portal.target_parent(app, type, id)  the record a client action's target belongs to:
--                                        for a version of an agreement of the caller's
--                                        company, that agreement. Anything else, another
--                                        company's, or an app not installed, is NULL.
--   portal.client_actions                also shows an action whose target belongs to a
--                                        record an open share names (a person shares the
--                                        agreement, its versions' links come with it), under
--                                        the same company, share and list predicates.
--   portal.file_allowed(file)            gains the agreements branch: a version's frozen PDF
--                                        and page pictures through portal.agreement_versions,
--                                        the signed PDF and the caller's own copy through
--                                        portal.evidence (both made by the agreements app's
--                                        registration). A version a scan found infected names
--                                        no file, so its files answer as an unknown id does.
--
-- The functions are definers owned by liaison_admin; app tables are read through EXECUTE
-- behind to_regclass, so this migration runs before any app registration. Re-runnable.
-- reviewed-dynamic: fixed SELECTs on the agreements app's version table through EXECUTE, so the function exists before the app's registration; no DDL
CREATE OR REPLACE FUNCTION portal.target_parent(p_app text, p_type text, p_target uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_company uuid := (SELECT portal.company_id());
  v_parent uuid;
BEGIN
  IF v_org IS NULL OR v_company IS NULL OR p_target IS NULL THEN RETURN NULL; END IF;
  IF p_app = 'agreements' AND p_type = 'agreement_version'
     AND to_regclass('app_agreements.agreement_versions') IS NOT NULL THEN
    EXECUTE 'SELECT v.agreement_id FROM app_agreements.agreement_versions v
               JOIN app_agreements.agreements a ON a.id = v.agreement_id AND a.org_id = v.org_id
              WHERE v.id = $1 AND v.org_id = $2 AND a.company_id = $3'
      INTO v_parent USING p_target, v_org, v_company;
  END IF;
  RETURN v_parent;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.target_parent(text, text, uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.target_parent(text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.target_parent(text, text, uuid) TO liaison_portal;
--> statement-breakpoint
-- An action reaches the portal through an open agreement or change request share on its
-- target or on the record its target belongs to. A restricted document's action needs that
-- share to name the caller; an unrestricted one is seen by whoever the share is open to.
CREATE OR REPLACE VIEW portal.client_actions WITH (security_barrier = true) AS
  SELECT a.id, a.kind, a.target_app, a.target_type, a.target_id, a.invited_name, a.invited_email,
         a.expires_at, a.decided_at, a.decision, a.revoked_at, a.created_at
    FROM kernel.client_actions a
   WHERE a.org_id = (SELECT rls_ctx.org_id())::uuid
     AND a.company_id = (SELECT portal.company_id())
     AND EXISTS (
       SELECT 1 FROM kernel.portal_shares s
        WHERE s.org_id = a.org_id
          AND s.company_id = a.company_id
          AND s.kind IN ('agreement', 'change_request')
          AND (s.object_id = a.target_id
               OR s.object_id = (SELECT portal.target_parent(a.target_app, a.target_type, a.target_id)))
          AND s.closed_at IS NULL
          AND CASE WHEN a.visible_to IS NULL
                   THEN s.only_user_ids IS NULL OR (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
                   ELSE s.only_user_ids IS NOT NULL AND (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
              END
          AND NOT EXISTS (
            SELECT 1 FROM kernel.portal_people p
             WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
               AND p.sees_only_share_ids IS NOT NULL
               AND NOT (s.id = ANY (p.sees_only_share_ids))
          )
     );
--> statement-breakpoint
ALTER VIEW portal.client_actions OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.client_actions TO liaison_portal;
--> statement-breakpoint
-- A file the caller may download: an attachment of a message they read; a file a
-- person shared with their company, whose parent is re-read now and is theirs and not
-- restricted; the PDF of an invoice they read; an agreement version's files they read.
-- Anything else, or an unknown id, is false.
-- reviewed-dynamic: fixed SELECTs on portal.invoices, portal.ticket_messages, portal.agreement_versions and portal.evidence through EXECUTE, so the function exists before the app registrations make those views; no DDL
-- expand-safe: same signature and every earlier branch unchanged; it only allows more files (the agreements app's), so the previous release's calls answer as before
CREATE OR REPLACE FUNCTION portal.file_allowed(p_file uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_company uuid := (SELECT portal.company_id());
  f record;
  v_ok boolean := false;
BEGIN
  IF v_org IS NULL OR v_company IS NULL OR p_file IS NULL THEN RETURN false; END IF;
  SELECT id, app, entity_type, entity_id INTO f
    FROM kernel.files WHERE id = p_file AND org_id = v_org;
  IF NOT FOUND THEN RETURN false; END IF;

  -- An attachment of a message the caller reads.
  IF f.app = 'tickets' AND f.entity_type = 'message'
     AND to_regclass('portal.ticket_messages') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.ticket_messages m WHERE m.id::text = $1)'
      INTO v_ok USING f.entity_id;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- A file a person shared, whose parent is still the caller's company's and open.
  IF EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'file' AND s.object_id = f.id) THEN
    IF f.app = 'kernel' AND f.entity_type = 'company' THEN
      v_ok := f.entity_id = v_company::text;
    ELSIF f.app = 'tickets' AND f.entity_type = 'message' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_tickets.messages m
          JOIN app_tickets.tickets t ON t.id = m.ticket_id AND t.org_id = m.org_id
         WHERE m.id::text = f.entity_id AND m.org_id = v_org
           AND t.company_id = v_company AND t.sensitivity <> 'restricted');
    ELSIF f.app = 'tickets' AND f.entity_type = 'ticket' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_tickets.tickets t
         WHERE t.id::text = f.entity_id AND t.org_id = v_org
           AND t.company_id = v_company AND t.sensitivity <> 'restricted');
    ELSIF f.app = 'projects' AND f.entity_type = 'project' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_projects.projects p
         WHERE p.id::text = f.entity_id AND p.org_id = v_org AND p.company_id = v_company);
    ELSIF f.app = 'projects' AND f.entity_type = 'task' THEN
      v_ok := EXISTS (
        SELECT 1 FROM app_projects.tasks t
          JOIN app_projects.projects p ON p.id = t.project_id AND p.org_id = t.org_id
         WHERE t.id::text = f.entity_id AND t.org_id = v_org AND p.company_id = v_company);
    END IF;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- A frozen PDF or a page picture of an agreement version the caller reads, or a
  -- signed PDF or copy of its evidence the caller is given. The views come with the
  -- agreements app; a version a scan found infected names none of its files.
  IF f.app = 'agreements' THEN
    IF to_regclass('portal.agreement_versions') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.agreement_versions v
                  WHERE v.file_id = $1
                     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v.pages, ''[]''::jsonb)) p
                                 WHERE p->>''file_id'' = $1::text))'
        INTO v_ok USING p_file;
      IF v_ok THEN RETURN true; END IF;
    END IF;
    IF to_regclass('portal.evidence') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.evidence e
                  WHERE $1 IN (e.signed_pdf_file_id, e.signer_copy_file_id, e.stamped_signer_copy_file_id))'
        INTO v_ok USING p_file;
      IF v_ok THEN RETURN true; END IF;
    END IF;
  END IF;

  -- The PDF of an invoice the caller reads. The view comes with the invoicing app.
  IF f.app = 'invoicing' AND to_regclass('portal.invoices') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM portal.invoices i WHERE i.pdf_file_id = $1)'
      INTO v_ok USING p_file;
    IF v_ok THEN RETURN true; END IF;
  END IF;
  RETURN false;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.file_allowed(uuid) OWNER TO liaison_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.file_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.file_allowed(uuid) TO liaison_portal;
