// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal views over a catalog app's tables. A catalog app's schema exists only
// once the app is registered, so its views cannot come from a numbered migration:
// they are made here, by the app's registration (inside its DDL transaction, also
// when the schema was already current) and once at boot for every installed app.
//
// Each view has the shape of the migration-made ones: `security_barrier`, owned by
// liaison_admin (which bypasses row level security, so the WHERE is the whole
// boundary), named columns only, the org of the context, the company stamped on the
// row (never a contact's current company), an open share, and SELECT for the portal
// role. A view is never dropped when one org uninstalls the app: the schema is
// shared, and the predicate already answers nothing for an org without rows.
//
// A view that fails to be made is logged and stays absent; the app still registers,
// and the portal part that reads it answers as unavailable.
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "portal-views" })

export interface PortalViewDef {
  /** The view's name in schema `portal`. */
  name: string
  /** Its SELECT, column names and predicate exactly as the portal reads them. */
  select: string
}

/** A transaction able to run statements and open a savepoint (a registration's or boot's). */
export interface PortalViewTx {
  execute: (query: SQL) => Promise<unknown>
  transaction: <T>(fn: (sp: PortalViewTx) => Promise<T>) => Promise<T>
}

const INVOICING_VIEWS: PortalViewDef[] = [
  {
    // Issued invoices and credit notes, never a draft, behind the company's open
    // invoices share. The label is the first line's description; notes never.
    name: "invoices",
    select: `SELECT d.id, d.type, d.number, d.status, d.payment_status, d.currency,
       d.subtotal_minor, d.tax_total_minor, d.grand_total_minor,
       d.issued_at, d.due_at, d.paid_at, d.pdf_file_id, d.original_document_id,
       (SELECT l.description FROM app_invoicing.document_lines l
         WHERE l.document_id = d.id AND l.org_id = d.org_id
         ORDER BY l.position LIMIT 1) AS label
  FROM app_invoicing.documents d
 WHERE d.org_id = (SELECT rls_ctx.org_id())::uuid
   AND d.company_id = (SELECT portal.company_id())
   AND d.type IN ('invoice', 'credit_note')
   AND d.issued_at IS NOT NULL
   AND d.status NOT IN ('draft', 'pending_approval')
   AND d.internal_cancellation IS NOT TRUE
   AND EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'invoices' AND s.object_id IS NULL)`,
  },
  {
    // What is still to be invoiced on the company's projects: the step's label and
    // amount, due on the date of the step's task when it has one.
    name: "billing_upcoming",
    select: `SELECT b.label, b.amount_minor, b.currency, t.due_date AS due_on
  FROM app_invoicing.billing_steps b
  JOIN app_projects.projects p ON p.id = b.billing_project_id AND p.org_id = b.org_id
  LEFT JOIN app_projects.tasks t ON t.id = b.task_id AND t.org_id = b.org_id
 WHERE b.org_id = (SELECT rls_ctx.org_id())::uuid
   AND p.company_id = (SELECT portal.company_id())
   AND p.kind = 'work'
   AND b.state IN ('planned', 'drafted')
   AND EXISTS (SELECT 1 FROM portal.shares s WHERE s.kind = 'invoices' AND s.object_id IS NULL)`,
  },
]

const TICKETS_VIEWS: PortalViewDef[] = [
  {
    // What was written in and sent out on a ticket the caller reads (portal.tickets,
    // migration 0330): no note, no HTML, no approval data, and an agent's name never.
    name: "ticket_messages",
    select: `SELECT m.id, m.ticket_id, m.kind, m.from_name,
       CASE WHEN m.author_agent_id IS NULL THEN m.author_label END AS author_label,
       m.text_body, m.sent_at
  FROM app_tickets.messages m
 WHERE m.org_id = (SELECT rls_ctx.org_id())::uuid
   AND m.kind IN ('inbound', 'outbound')
   AND m.sent_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM portal.tickets t WHERE t.id = m.ticket_id)`,
  },
]

/**
 * An agreement reaches the portal through an open `agreement` or `change_request`
 * share made for its company, on the agreement or on one of its versions (a send's
 * automatic share names the version its link is for). A restricted agreement
 * (`org_access = 'none'`) needs that share to name the caller.
 */
function agreementsViews(): PortalViewDef[] {
  const k = schemaRef("kernel")
  return [
    {
      name: "agreements",
      select: `SELECT a.id, a.number, a.kind, a.title, a.status, a.signed_at, a.price_minor, a.currency
  FROM app_agreements.agreements a
 WHERE a.org_id = (SELECT rls_ctx.org_id())::uuid
   AND a.company_id = (SELECT portal.company_id())
   AND a.status <> 'draft'
   AND EXISTS (
     SELECT 1 FROM ${k}.portal_shares s
      WHERE s.org_id = a.org_id
        AND s.company_id = a.company_id
        AND s.kind IN ('agreement', 'change_request')
        AND s.closed_at IS NULL
        AND (s.object_id = a.id OR s.object_id IN (
              SELECT v.id FROM app_agreements.agreement_versions v
               WHERE v.agreement_id = a.id AND v.org_id = a.org_id))
        AND CASE WHEN a.org_access = 'none'
                 THEN s.only_user_ids IS NOT NULL AND (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
                 ELSE s.only_user_ids IS NULL OR (SELECT rls_ctx.user_id())::uuid = ANY (s.only_user_ids)
            END
        AND NOT EXISTS (
          SELECT 1 FROM ${k}.portal_people p
           WHERE p.user_id = (SELECT rls_ctx.user_id())::uuid
             AND p.sees_only_share_ids IS NOT NULL
             AND NOT (s.id = ANY (p.sees_only_share_ids))))`,
    },
    {
      // A frozen or signed version of a readable agreement, with its page pictures (number,
      // size and picture file only, never the read text); a file a scan found infected is
      // never named, nor are its pages.
      name: "agreement_versions",
      select: `SELECT v.id, v.agreement_id, v.number, v.source,
       CASE WHEN v.scan_state = 'infected' THEN NULL ELSE v.file_id END AS file_id, v.sha256,
       CASE WHEN v.scan_state = 'infected' THEN NULL ELSE (
         SELECT jsonb_agg(jsonb_build_object('n', p.value->'n', 'width', p.value->'width',
                  'height', p.value->'height', 'file_id', p.value->'picture_file_id')
                  ORDER BY (p.value->>'n')::int)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(to_jsonb(v.pages)) = 'array'
                                          THEN to_jsonb(v.pages) ELSE '[]'::jsonb END) p) END AS pages
  FROM app_agreements.agreement_versions v
 WHERE v.org_id = (SELECT rls_ctx.org_id())::uuid
   AND v.status IN ('frozen', 'signed')
   AND EXISTS (SELECT 1 FROM portal.agreements a WHERE a.id = v.agreement_id)`,
    },
    {
      // The sealed evidence of a readable version, as a client is given it: the signed PDF,
      // and the copy of the caller's own decided link, or for a colleague who did not sign
      // the copy with no device at all. The staff file is never named.
      name: "evidence",
      select: `SELECT e.version_id, e.signed_pdf_file_id,
       (to_jsonb(e.signer_copy_file_ids) ->> COALESCE(own.id::text, 'colleague'))::uuid AS signer_copy_file_id,
       (to_jsonb(e.stamped_signer_copy_file_ids) ->> COALESCE(own.id::text, 'colleague'))::uuid AS stamped_signer_copy_file_id,
       e.sealed_at
  FROM app_agreements.evidence_packages e
  LEFT JOIN LATERAL (
    SELECT ca.id FROM portal.client_actions ca
     WHERE ca.target_id = e.version_id
       AND ca.decided_at IS NOT NULL
       AND lower(ca.invited_email) = (SELECT lower(m.email) FROM portal.me m)
     ORDER BY ca.decided_at LIMIT 1) own ON true
 WHERE e.org_id = (SELECT rls_ctx.org_id())::uuid
   AND e.sealed_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM app_agreements.agreement_versions v
       JOIN portal.agreements a ON a.id = v.agreement_id
      WHERE v.id = e.version_id AND v.org_id = e.org_id
        AND v.status IN ('frozen', 'signed') AND v.scan_state <> 'infected')`,
    },
  ]
}

/** An app's portal views, and the one-time step its views need first, if any. */
interface PortalAppViews {
  readonly views: PortalViewDef[]
  before?: (tx: PortalViewTx) => Promise<void>
}

const VIEWS_BY_APP: Record<string, PortalAppViews> = {
  invoicing: { views: INVOICING_VIEWS, before: (tx) => stampIssuedDocumentsOnce(tx) },
  tickets: { views: TICKETS_VIEWS },
  agreements: {
    get views() {
      return agreementsViews()
    },
  },
}

/** The portal views an app brings; none for an app without any. */
export function portalViewsFor(app: string): readonly PortalViewDef[] {
  return VIEWS_BY_APP[app]?.views ?? []
}

/** Every app that brings portal views. */
export function appsWithPortalViews(): string[] {
  return Object.keys(VIEWS_BY_APP)
}

const IDENT = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a portal view name: ${name}`)
  return name
}

async function viewExists(tx: PortalViewTx, name: string): Promise<boolean> {
  const [row] = extractRows<{ oid: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${`portal.${name}`})::text AS oid`),
  )
  return row?.oid != null
}

/** True when the view in the database reads exactly what the code holds, with its barrier. */
async function viewIsCurrent(tx: PortalViewTx, def: PortalViewDef): Promise<boolean> {
  const name = ident(def.name)
  return tx.transaction(async (sp) => {
    // The code's definition, made as a temporary view in this transaction only, so
    // both texts come out of the same deparser.
    await sp.execute(
      drizzleSql.raw(`CREATE TEMPORARY VIEW portal_view_cmp_${name} AS ${def.select}`),
    )
    const [row] = extractRows<{ same: boolean }>(
      await sp.execute(
        drizzleSql.raw(`SELECT pg_get_viewdef('portal.${name}'::regclass) = pg_get_viewdef('pg_temp.portal_view_cmp_${name}'::regclass)
          AND (SELECT reloptions FROM pg_class WHERE oid = 'portal.${name}'::regclass) @> ARRAY['security_barrier=true']
          AND (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'portal.${name}'::regclass) = 'liaison_admin'
          AND has_table_privilege('liaison_portal', 'portal.${name}'::regclass, 'SELECT') AS same`),
      ),
    )
    await sp.execute(drizzleSql.raw(`DROP VIEW pg_temp.portal_view_cmp_${name}`))
    return row?.same === true
  })
}

async function writeView(tx: PortalViewTx, def: PortalViewDef): Promise<void> {
  const name = ident(def.name)
  const create = `CREATE OR REPLACE VIEW portal.${name} WITH (security_barrier = true) AS ${def.select}`
  try {
    await tx.transaction((sp) => sp.execute(drizzleSql.raw(create)))
  } catch (err) {
    // A changed column list cannot be replaced in place: drop and make it again.
    const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code
    if (code !== "42P16" && (err as { code?: string })?.code !== "42P16") throw err
    await tx.execute(drizzleSql.raw(`DROP VIEW portal.${name}`))
    await tx.execute(drizzleSql.raw(create))
  }
  await tx.execute(drizzleSql.raw(`ALTER VIEW portal.${name} OWNER TO liaison_admin`))
  await tx.execute(drizzleSql.raw(`REVOKE ALL ON portal.${name} FROM PUBLIC`))
  await tx.execute(drizzleSql.raw(`GRANT SELECT ON portal.${name} TO liaison_portal`))
}

/**
 * Stamps the invoices issued before the stamp existed, once: each takes its contact's
 * company as it is now. A document whose contact has no company stays NULL. The
 * column's comment records that the step ran, so a later run never re-stamps a NULL.
 */
async function stampIssuedDocumentsOnce(tx: PortalViewTx): Promise<void> {
  const [row] = extractRows<{ stamped: boolean | null; has: boolean }>(
    await tx.execute(drizzleSql`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'app_invoicing' AND table_name = 'documents'
                        AND column_name = 'company_id') AS has,
             col_description('app_invoicing.documents'::regclass,
               (SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'app_invoicing.documents'::regclass AND attname = 'company_id'))
               = 'company stamp: forward step done' AS stamped`),
  )
  if (!row?.has || row.stamped) return
  await tx.execute(drizzleSql`
    UPDATE app_invoicing.documents d
       SET company_id = c.company_id
      FROM ${drizzleSql.raw(`${schemaRef("kernel")}.contacts`)} c
     WHERE c.id = d.counterparty_contact_id
       AND c.org_id = d.org_id
       AND c.company_id IS NOT NULL
       AND d.company_id IS NULL
       AND d.issued_at IS NOT NULL`)
  await tx.execute(
    drizzleSql.raw(
      `COMMENT ON COLUMN app_invoicing.documents.company_id IS 'company stamp: forward step done'`,
    ),
  )
}

export interface EnsureResult {
  written: string[]
  failed: string[]
}

/**
 * Makes the app's portal views. `mode: "missing"` (a registration on a schema
 * already current) only creates absent views; `"replace"` (a registration that ran
 * DDL) writes every one; `"compare"` (boot) replaces only a view whose definition,
 * barrier, owner or grant differs from the code's. Never throws: a failed view is
 * logged and listed.
 */
export async function ensurePortalViews(
  tx: PortalViewTx,
  app: string,
  mode: "missing" | "replace" | "compare",
): Promise<EnsureResult> {
  const result: EnsureResult = { written: [], failed: [] }
  const entry = VIEWS_BY_APP[app]
  const defs = entry?.views ?? []
  if (defs.length === 0) return result
  const before = entry?.before
  if (before) {
    try {
      await tx.transaction((sp) => before(sp))
    } catch (err) {
      log.error({ err, app }, "Portal views' first step failed")
    }
  }
  for (const def of defs) {
    try {
      await tx.transaction(async (sp) => {
        const exists = await viewExists(sp, def.name)
        if (exists && mode === "missing") return
        if (exists && mode === "compare" && (await viewIsCurrent(sp, def))) return
        await writeView(sp, def)
        result.written.push(def.name)
      })
    } catch (err) {
      result.failed.push(def.name)
      log.error(
        { err, app, view: def.name },
        "Portal view could not be made; that part is unavailable",
      )
    }
  }
  return result
}
