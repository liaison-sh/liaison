// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Companies (kernel.companies, migration 0290): the organisations an org's
 * people work for, and the hub their deals, money, support and work hang off.
 *
 * Every read and write runs under the caller's RLS: a company shared with
 * nobody is invisible to whoever holds no grant on it, and a company the
 * caller cannot see answers 404, never 403. Two writes reach rows the caller's
 * RLS may not let them change, and both must commit with the change that
 * causes them, so they run elevated in the same transaction
 * (withElevatableRlsFrom + asAdmin, as the contact merge does):
 *
 *  - a rename rewrites `contacts.company` (the company name each person
 *    carries as text) on every linked person, private ones included;
 *  - a delete clears the company from deals and pipelines
 *    (`app_projects.deals.company_id`, `app_projects.projects.company_id`),
 *    which hold it as a soft reference.
 *
 * A company's domain is stored as a lowercase host and never as a personal
 * mail domain (gmail.com and the like): such a domain is dropped with a
 * notice and the company saves without one. Two companies may share a domain
 * (a group's subsidiaries); duplicates are a hint, never a refusal.
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { isConsumerMailDomain } from "~/apps/api-connector/consumer-domains"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withElevatableRlsFrom } from "~/db/privileged"
import { type Company, companies, contacts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { contactsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import {
  asAdmin,
  canManageSharing,
  listGrants,
  type OrgAccess,
  type ResourceGrants,
} from "~/modules/sharing/service"
import { deleteEntityDiscussions } from "~/modules/threads/entity-discussion"

export const COMPANY_RESOURCE = "kernel.company"
export const COMPANY_NAME_MAX = 200
export const COMPANY_LINK_BATCH_MAX = 200

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** A refusal with a code the page and the agent can act on (409 or 422). */
export class CompanyRequestError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "CompanyRequestError"
  }
}

function notFound(): HTTPException {
  return new HTTPException(404, { message: "Company not found" })
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.cause?.code ?? e?.code
}

/* -------------------------------------------------------------------------- */
/* Domain and name normalisation                                              */
/* -------------------------------------------------------------------------- */

export type DomainResult =
  | { domain: string | null }
  | { domain: null; refused: "consumer_domain"; typed: string }

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/

/**
 * A typed domain or url as the company's lowercase host: `https://www.x.example/a`
 * is `x.example`. Empty input is no domain. A personal mail domain is refused
 * (the company saves without one); anything that is not a host is a 422.
 */
export function normaliseCompanyDomain(raw: string | null | undefined): DomainResult {
  const typed = (raw ?? "").trim()
  if (!typed) return { domain: null }
  let host = typed.toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  host = host.replace(/^[^@/]*@/, "")
  host = host.split(/[/?#]/, 1)[0] ?? ""
  host = host.replace(/:\d+$/, "").replace(/\.+$/, "")
  if (host.startsWith("www.")) host = host.slice(4)
  if (!HOST_RE.test(host)) {
    throw new CompanyRequestError(
      422,
      "invalid_domain",
      `"${typed.slice(0, 100)}" is not a domain. Type it as example.com, or leave it empty.`,
    )
  }
  if (isConsumerMailDomain(host)) return { domain: null, refused: "consumer_domain", typed: host }
  return { domain: host }
}

/** The line a person reads when a personal mail domain was not saved. */
export function consumerDomainNotice(host: string): string {
  return `${host} is a personal mail domain, so it was not saved as the company's domain. The company was saved without one.`
}

/** Legal-form words that do not tell two companies apart ("Maison Arlon SAS"). */
const LEGAL_FORMS = new Set([
  "ab",
  "ag",
  "aps",
  "as",
  "bv",
  "co",
  "corp",
  "corporation",
  "eurl",
  "gmbh",
  "inc",
  "incorporated",
  "kg",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "nv",
  "oy",
  "plc",
  "pty",
  "sa",
  "sarl",
  "sas",
  "sasu",
  "sci",
  "sl",
  "snc",
  "spa",
  "srl",
  "ug",
])

/**
 * The comparison key of a company name: case, accents, punctuation and
 * trailing legal forms removed. `MAISON ARLON SAS` and `Maison Arlon` share
 * the key `maison arlon`.
 */
export function companyNameKey(raw: string | null | undefined): string {
  const words = (raw ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1]!)) words.pop()
  return words.join(" ")
}

/** The handle's readable part: `@company-maison-arlon`. */
function handleBase(name: string): string {
  const slug = companyNameKey(name)
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "")
  return `@company-${slug || "company"}`
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface CompanyInput {
  name: string
  domain?: string | null
  description?: string | null
  tags?: string[]
}

export interface CompanyPatch {
  name?: string
  domain?: string | null
  description?: string | null
  tags?: string[]
  /** True ends the relationship (closed_at now), false reopens it. */
  closed?: boolean
}

export interface CompanyWrite {
  company: Company
  /** Set when the typed domain was a personal mail domain and was not saved. */
  notice?: string
}

export interface CompanyDealSummary {
  taskId: string
  stage: string | null
  /** Null for a reader without deal access, or when the deal has no amount. */
  amountMinor: number | null
  currency: string | null
}

export interface CompanyRow extends Company {
  peopleCount: number
  /** The newest open deal, for a reader who may see deals; null otherwise. */
  openDeal: CompanyDealSummary | null
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ")
  if (!trimmed) throw new CompanyRequestError(422, "name_required", "A company needs a name.")
  if (trimmed.length > COMPANY_NAME_MAX) {
    throw new CompanyRequestError(
      422,
      "name_too_long",
      `A company name is at most ${COMPANY_NAME_MAX} characters.`,
    )
  }
  return trimmed
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))]
}

function actorUuid(userId: string): string | null {
  return UUID_RE.test(userId) ? userId : null
}

const ks = () => drizzleSql.raw(quoteIdent(schemaRef("kernel")))
const ps = () => drizzleSql.raw(quoteIdent(schemaRef("app_projects")))

/** True when the projects app's deal tables exist in this database. */
async function dealTablesExist(tx: Pick<RlsClient, "execute">): Promise<boolean> {
  const [row] = extractRows<{ deals: string | null; projects: string | null }>(
    await tx.execute(drizzleSql`
      SELECT to_regclass(${`${quoteIdent(schemaRef("app_projects"))}.deals`})::text AS deals,
             to_regclass(${`${quoteIdent(schemaRef("app_projects"))}.projects`})::text AS projects`),
  )
  return !!row?.deals && !!row?.projects
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

async function loadVisible(tx: RlsClient, orgId: string, companyId: string): Promise<Company> {
  if (!UUID_RE.test(companyId)) throw notFound()
  const [row] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
    .limit(1)
  if (!row) throw notFound()
  return row
}

/** People the caller sees per company, by company id. */
async function peopleCounts(
  tx: RlsClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = extractRows<{ company_id: string; n: number }>(
    await tx.execute(drizzleSql`
      SELECT company_id::text AS company_id, count(*)::int AS n
        FROM ${ks()}.contacts
       WHERE org_id = ${orgId}::uuid AND company_id = ANY(${`{${ids.join(",")}}`}::uuid[])
       GROUP BY company_id`),
  )
  return new Map(rows.map((r) => [r.company_id, r.n]))
}

/**
 * The newest open deal of each company, as far as the caller's RLS lets them
 * see deals (projects read) and amounts (deal access). Nothing when the
 * projects app's tables are absent.
 */
async function openDeals(
  tx: RlsClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, CompanyDealSummary>> {
  if (ids.length === 0 || !(await dealTablesExist(tx))) return new Map()
  const rows = extractRows<{
    company_id: string
    task_id: string
    stage: string | null
    amount_minor: string | number | null
    currency: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT ON (d.company_id)
             d.company_id::text AS company_id, d.task_id::text AS task_id,
             s.label AS stage, v.amount_minor, v.currency
        FROM ${ps()}.deals d
        JOIN ${ps()}.tasks t ON t.id = d.task_id AND t.archived_at IS NULL
        LEFT JOIN ${ps()}.project_statuses s ON s.id = t.status_id
        LEFT JOIN ${ps()}.deal_values v ON v.task_id = d.task_id
       WHERE d.org_id = ${orgId}::uuid AND d.outcome = 'open'
         AND d.company_id = ANY(${`{${ids.join(",")}}`}::uuid[])
       ORDER BY d.company_id, d.created_at DESC, d.task_id`),
  )
  return new Map(
    rows.map((r) => [
      r.company_id,
      {
        taskId: r.task_id,
        stage: r.stage,
        amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
        currency: r.currency,
      },
    ]),
  )
}

async function withSummaries(tx: RlsClient, orgId: string, rows: Company[]): Promise<CompanyRow[]> {
  const ids = rows.map((r) => r.id)
  const [counts, deals] = [await peopleCounts(tx, orgId, ids), await openDeals(tx, orgId, ids)]
  return rows.map((r) => ({
    ...r,
    peopleCount: counts.get(r.id) ?? 0,
    openDeal: deals.get(r.id) ?? null,
  }))
}

/** One company the caller sees, with its summary; null when it is not visible. */
export async function getCompany(
  tx: RlsClient,
  params: { orgId: string; companyId: string },
): Promise<CompanyRow | null> {
  if (!UUID_RE.test(params.companyId)) return null
  const [row] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, params.companyId), eq(companies.orgId, params.orgId)))
    .limit(1)
  if (!row) return null
  return (await withSummaries(tx, params.orgId, [row]))[0] ?? null
}

/**
 * The companies the caller sees, most recently changed first, filtered by a
 * name or domain fragment. A personal mail domain matches nothing: no company
 * holds one.
 */
export async function listCompanies(
  tx: RlsClient,
  params: { orgId: string; page: number; limit: number; query?: string },
): Promise<{ rows: CompanyRow[]; total: number }> {
  const { orgId, page, limit } = params
  const conditions = [eq(companies.orgId, orgId)]
  const q = params.query?.trim()
  if (q) {
    const asDomain = q
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
    if (isConsumerMailDomain(asDomain)) return { rows: [], total: 0 }
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conditions.push(
      drizzleSql`(${companies.name} ILIKE ${like} OR ${companies.domain} ILIKE ${like})`,
    )
  }
  const rows = await tx
    .select({ company: companies, total: drizzleSql<number>`COUNT(*) OVER()::int` })
    .from(companies)
    .where(and(...conditions))
    .orderBy(drizzleSql`${companies.updatedAt} DESC`, companies.id)
    .limit(limit)
    .offset((page - 1) * limit)
  const total = rows[0]?.total ?? 0
  return {
    rows: await withSummaries(
      tx,
      orgId,
      rows.map((r) => r.company),
    ),
    total,
  }
}

export interface SimilarCompany {
  id: string
  name: string
  domain: string | null
  reason: "same_name" | "same_domain"
}

/**
 * Companies the caller sees that look like the one being typed: the same name
 * once case, accents and legal forms are set aside, or the same business
 * domain. A hint for the create form ("Looks like Maison Arlon"), never a
 * refusal.
 */
export async function similarCompanies(
  tx: RlsClient,
  params: { orgId: string; name?: string; domain?: string; excludeId?: string },
): Promise<SimilarCompany[]> {
  const key = companyNameKey(params.name)
  let domain: string | null = null
  if (params.domain?.trim()) {
    try {
      const d = normaliseCompanyDomain(params.domain)
      domain = d.domain
    } catch {
      domain = null
    }
  }
  if (!key && !domain) return []
  const firstWord = key.split(" ")[0] ?? ""
  const nameLike = firstWord ? `%${firstWord.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null
  const rows = extractRows<{ id: string; name: string; domain: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, name, domain FROM ${ks()}.companies
       WHERE org_id = ${params.orgId}::uuid
         AND (${nameLike !== null ? drizzleSql`name ILIKE ${nameLike}` : drizzleSql`false`}
              OR ${domain !== null ? drizzleSql`lower(domain) = ${domain}` : drizzleSql`false`})
       ORDER BY updated_at DESC
       LIMIT 200`),
  )
  const out: SimilarCompany[] = []
  for (const r of rows) {
    if (r.id === params.excludeId) continue
    if (key && companyNameKey(r.name) === key) out.push({ ...r, reason: "same_name" })
    else if (domain && r.domain?.toLowerCase() === domain) out.push({ ...r, reason: "same_domain" })
    if (out.length >= 5) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create a company, org-wide by default, with the caller as its creator (the
 * sharing trigger stamps `created_by` from the transaction's actor).
 */
export async function createCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; input: CompanyInput },
): Promise<CompanyWrite> {
  const { orgId, userId, input } = params
  const name = cleanName(input.name)
  const d = normaliseCompanyDomain(input.domain)
  const base = handleBase(name)
  let created: Company | undefined
  for (let attempt = 1; attempt <= 50 && !created; attempt++) {
    const handle =
      attempt === 1
        ? base
        : attempt < 50
          ? `${base}-${attempt}`
          : `${base}-${crypto.randomUUID().slice(0, 8)}`
    const [row] = await tx
      .insert(companies)
      .values({
        orgId,
        handle,
        name,
        domain: d.domain,
        description: input.description?.trim() || null,
        ...(cleanTags(input.tags)?.length ? { tags: cleanTags(input.tags) } : {}),
        createdBy: actorUuid(userId),
      })
      .onConflictDoNothing({ target: [companies.orgId, companies.handle] })
      .returning()
    created = row
  }
  if (!created) {
    throw new CompanyRequestError(409, "handle_taken", "Could not give the company a free handle.")
  }
  log.info({ companyId: created.id, handle: created.handle }, "Company created")
  await tx.queueEvent({
    app: "kernel",
    entity: "company",
    action: "create",
    orgId,
    actorId: userId,
    entityId: created.id,
    data: { id: created.id, name: created.name, handle: created.handle, domain: created.domain },
  })
  return {
    company: created,
    ...("refused" in d ? { notice: consumerDomainNotice(d.typed) } : {}),
  }
}

/**
 * Change a company. A rename rewrites the company name carried by every linked
 * person in the same transaction (elevated: a private person's row is not the
 * renamer's to edit under RLS, but the name it carries is the company's).
 * Closing it stamps `closed_at` and announces `company:closed`.
 */
export async function updateCompany(
  db: RlsClient,
  params: { orgId: string; userId: string; companyId: string; patch: CompanyPatch },
): Promise<CompanyWrite> {
  const { orgId, userId, companyId, patch } = params
  return withElevatableRlsFrom(db, "company-update", async (tx) => {
    const before = await loadVisible(tx, orgId, companyId)
    const set: Record<string, unknown> = { updatedAt: new Date() }
    let notice: string | undefined
    if (patch.name !== undefined) set.name = cleanName(patch.name)
    if (patch.domain !== undefined) {
      const d = normaliseCompanyDomain(patch.domain)
      set.domain = d.domain
      if ("refused" in d) notice = consumerDomainNotice(d.typed)
    }
    if (patch.description !== undefined) set.description = patch.description?.trim() || null
    if (patch.tags !== undefined) set.tags = cleanTags(patch.tags) ?? []
    const closing = patch.closed === true && before.closedAt === null
    if (patch.closed === true && before.closedAt === null) set.closedAt = new Date()
    if (patch.closed === false) set.closedAt = null

    const [updated] = await tx
      .update(companies)
      .set(set)
      .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
      .returning()
    // Visible but not editable (a viewer): the UPDATE policy matched nothing.
    if (!updated) {
      throw new HTTPException(403, { message: "You can see this company but not change it." })
    }

    let renamed = 0
    if (updated.name !== before.name) {
      renamed = await tx.transaction((sp) =>
        asAdmin(sp, async () => {
          const rows = extractRows<{ id: string }>(
            await sp.execute(drizzleSql`
              UPDATE ${ks()}.contacts SET company = ${updated.name}, updated_at = now()
               WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid
               RETURNING id::text AS id`),
          )
          await runAfterCompanyRenameFailpoint()
          return rows.length
        }),
      )
    }

    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "update",
      orgId,
      actorId: userId,
      entityId: companyId,
      data: { ...updated, renamedPeople: renamed },
    })
    if (closing) {
      await tx.queueEvent({
        app: "kernel",
        entity: "company",
        action: "closed",
        orgId,
        actorId: userId,
        entityId: companyId,
        data: { id: companyId, name: updated.name },
      })
    }
    return { company: updated, ...(notice ? { notice } : {}) }
  })
}

/**
 * Delete a company. In the same transaction its deals and pipelines stop
 * naming it (elevated: the deleter may not see every deal), its discussion
 * goes, and the grant rows go by the table's cleanup trigger. People keep
 * their company text and lose the link (the foreign key sets it NULL). A
 * company a portal account belongs to is refused (409 `company_has_accounts`).
 */
export async function deleteCompany(
  db: RlsClient,
  params: { orgId: string; userId: string; companyId: string },
): Promise<{ id: string; dealsCleared: number; projectsCleared: number }> {
  const { orgId, userId, companyId } = params
  return withElevatableRlsFrom(db, "company-delete", async (tx) => {
    const company = await loadVisible(tx, orgId, companyId)
    let deleted: { id: string } | undefined
    try {
      deleted = await tx.transaction(async (sp) => {
        const [row] = await sp
          .delete(companies)
          .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
          .returning({ id: companies.id })
        return row
      })
    } catch (err) {
      if (pgCode(err) === "23503") {
        throw new CompanyRequestError(
          409,
          "company_has_accounts",
          `${company.name} has portal accounts, so it cannot be deleted. Remove or move those accounts first.`,
        )
      }
      throw err
    }
    if (!deleted) {
      throw new HTTPException(403, { message: "You can see this company but not delete it." })
    }

    const cleared = await tx.transaction((sp) =>
      asAdmin(sp, async () => {
        if (!(await dealTablesExist(sp))) return { deals: 0, projects: 0 }
        const deals = extractRows(
          await sp.execute(drizzleSql`
            UPDATE ${ps()}.deals SET company_id = NULL, updated_at = now()
             WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid
             RETURNING task_id`),
        ).length
        const projects = extractRows(
          await sp.execute(drizzleSql`
            UPDATE ${ps()}.projects SET company_id = NULL
             WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid
             RETURNING id`),
        ).length
        return { deals, projects }
      }),
    )
    await tx.transaction((sp) =>
      asAdmin(sp, () =>
        deleteEntityDiscussions(
          { orgId, app: "kernel", entityType: "company", entityIds: [companyId] },
          sp as never,
        ),
      ),
    )

    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "delete",
      orgId,
      actorId: userId,
      entityId: companyId,
      // The page's handler reads `data.id` to drop the row.
      data: { id: companyId },
    })
    return { id: companyId, dealsCleared: cleared.deals, projectsCleared: cleared.projects }
  })
}

/**
 * Link people to a company: each one's `company_id` and its `company` text
 * (the company's name) are written together. People the caller cannot see or
 * edit are skipped and named by id.
 */
export async function linkContactsToCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; companyId: string; contactIds: string[] },
): Promise<{ companyId: string; linked: string[]; skipped: string[] }> {
  const { orgId, userId, companyId } = params
  const ids = [...new Set(params.contactIds)]
  if (ids.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_people",
      `Link at most ${COMPANY_LINK_BATCH_MAX} people at once.`,
    )
  }
  const company = await loadVisible(tx, orgId, companyId)
  const updated = await tx
    .update(contacts)
    .set({ companyId: company.id, company: company.name, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.orgId, orgId),
        drizzleSql`${contacts.id} = ANY(${`{${ids.filter((i) => UUID_RE.test(i)).join(",")}}`}::uuid[])`,
      ),
    )
    .returning()
  for (const row of updated) {
    await tx.queueEvent({
      app: "kernel",
      entity: "contact",
      action: "update",
      entityId: row.id,
      orgId,
      actorId: userId,
      data: row,
    })
  }
  const linked = new Set(updated.map((r) => r.id))
  return { companyId, linked: [...linked], skipped: ids.filter((i) => !linked.has(i)) }
}

/**
 * Unlink people from a company: the link and the company name they carried
 * both go. People not linked to it, or not the caller's to edit, are skipped.
 */
export async function unlinkContactsFromCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; companyId: string; contactIds: string[] },
): Promise<{ companyId: string; unlinked: string[]; skipped: string[] }> {
  const { orgId, userId, companyId } = params
  const ids = [...new Set(params.contactIds)].filter((i) => UUID_RE.test(i))
  if (ids.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_people",
      `Unlink at most ${COMPANY_LINK_BATCH_MAX} people at once.`,
    )
  }
  await loadVisible(tx, orgId, companyId)
  const updated = await tx
    .update(contacts)
    .set({ companyId: null, company: null, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.companyId, companyId),
        drizzleSql`${contacts.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
      ),
    )
    .returning()
  for (const row of updated) {
    await tx.queueEvent({
      app: "kernel",
      entity: "contact",
      action: "update",
      entityId: row.id,
      orgId,
      actorId: userId,
      data: row,
    })
  }
  const done = new Set(updated.map((r) => r.id))
  return { companyId, unlinked: [...done], skipped: params.contactIds.filter((i) => !done.has(i)) }
}

/* -------------------------------------------------------------------------- */
/* Sharing                                                                    */
/* -------------------------------------------------------------------------- */

export interface CompanySharing extends ResourceGrants {
  orgAccess: OrgAccess
  createdBy: string | null
  canManage: boolean
}

/** Who the company is shared with; whoever sees the company may read this. */
export async function getCompanySharing(
  tx: RlsClient,
  params: { orgId: string; companyId: string },
): Promise<CompanySharing> {
  const row = await loadVisible(tx, params.orgId, params.companyId)
  return {
    orgAccess: row.orgAccess,
    createdBy: row.createdBy,
    canManage: await canManageSharing(tx, COMPANY_RESOURCE, row.id),
    ...(await listGrants(tx, COMPANY_RESOURCE, row.id)),
  }
}

/* -------------------------------------------------------------------------- */
/* Rename failpoint (tests only)                                              */
/* -------------------------------------------------------------------------- */

type Failpoint = () => Promise<void> | void
let afterCompanyRename: Failpoint | null = null

/**
 * Arm a fault after a rename has rewritten the people's company name, to prove
 * the rename and the rewrite commit or roll back together. Refused in
 * production; returns the disarm function.
 */
export function armAfterCompanyRenameFailpoint(fn: Failpoint): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The company rename failpoint cannot be armed in production")
  }
  afterCompanyRename = fn
  return () => {
    afterCompanyRename = null
  }
}

async function runAfterCompanyRenameFailpoint(): Promise<void> {
  if (afterCompanyRename) await afterCompanyRename()
}

export function isCompanyRequestError(err: unknown): err is CompanyRequestError {
  return err instanceof CompanyRequestError
}
