// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agreements: search in the order of what needs someone first, read, create, update, price,
// prepare. Writes go through `ctx.db.batch` so a numbered row and its list land together.

import { batchPreconditionFailure, type DbBatchOp } from "@liaison/app-sdk"
import {
  accessOps,
  currentShares,
  emitAccessChanged,
  mayChangeAccess,
  normaliseShares,
  type OrgAccess,
  type ShareEntry,
  type ShareRow,
} from "./access"
import {
  type AgreementSource,
  type Check,
  markAgentBlocks,
  prepareChecks,
  priceInSource,
  sourceText,
} from "./checks"
import {
  type AgreementsCtx,
  actingAgentId,
  agentWrites,
  bridgeAnswer,
  callerUserId,
  type ErrorEnvelope,
  refusal,
  todayOf,
} from "./ctx"
import { linksOf, rescannedState } from "./send"

export interface AgreementRow {
  id: string
  number: string
  kind: string
  status: string
  title: string
  company_id?: string | null
  contact_id?: string | null
  template_id?: string | null
  template_version?: number | null
  language?: string | null
  fit_tag?: string | null
  price_minor?: string | number | null
  currency?: string | null
  priced_by_user_id?: string | null
  renews_on?: string | null
  notice_days?: number | null
  signed_at?: string | null
  starts_on?: string | null
  ends_on?: string | null
  what_it_is?: string | null
  what_it_is_by_user_id?: string | null
  not_a_guarantee_by_user_id?: string | null
  org_access?: OrgAccess | null
  claimed_by_user_id?: string | null
  claimed_at?: string | null
  created_by_user_id?: string | null
  created_by_agent_id?: string | null
  updated_at?: string | null
  created_at?: string | null
}

interface DraftRow {
  id: string
  agreement_id: string
  source?: AgreementSource | null
  lock_version: number
  next_number?: number
  /** An uploaded PDF waiting to be frozen as the next version. */
  upload_file_id?: string | null
  /** `checking` while a long upload is read by the `upload-freeze` job. */
  upload_state?: string | null
  updated_by_user_id?: string | null
}

const KINDS = [
  "proposal",
  "sow",
  "msa",
  "nda",
  "retainer",
  "tm",
  "dpa",
  "change_request",
  "other",
] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SENT = ["sent", "partly_signed"]
const CLOSED = ["ended", "declined", "expired", "voided", "withdrawn", "imported"]

/** The series prefix of a kind: PR for proposals, DOC for any PDF, AG for the rest. */
export function seriesOf(kind: string): string {
  if (kind === "proposal") return "PR"
  if (kind === "other") return "DOC"
  return "AG"
}

function addDays(date: string, days: number): string {
  const [y, m, day] = date.split("-").map(Number)
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (day ?? 1) + days))
  return d.toISOString().slice(0, 10)
}

/** Inside its notice period: a signed agreement whose renewal is due within `notice_days`. */
export function insideNotice(row: AgreementRow, today: string): boolean {
  if (row.status !== "signed" || !row.renews_on) return false
  const notice = row.notice_days ?? 0
  return addDays(today, notice) >= row.renews_on && row.renews_on >= today
}

/**
 * What needs someone first: a draft (someone is writing or approving it), then a document
 * waiting for signatures, then a renewal inside its notice, then signed, then closed.
 */
export function needRank(row: AgreementRow, today: string): number {
  if (row.status === "draft") return 0
  if (row.status === "sent" || row.status === "partly_signed") return 1
  if (insideNotice(row, today)) return 2
  if (row.status === "signed") return 3
  if (CLOSED.includes(row.status)) return 4
  return 5
}

export function orderByNeed(rows: AgreementRow[], today: string): AgreementRow[] {
  return [...rows].sort((a, b) => {
    const r = needRank(a, today) - needRank(b, today)
    if (r !== 0) return r
    const ta = a.updated_at ?? a.created_at ?? ""
    const tb = b.updated_at ?? b.created_at ?? ""
    return ta < tb ? 1 : ta > tb ? -1 : a.number.localeCompare(b.number)
  })
}

const NEED_WORDS = [
  "being drafted",
  "waiting for signatures",
  "renewal inside its notice",
  "signed",
  "closed",
  "other",
]

function brief(row: AgreementRow, today: string) {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    kind: row.kind,
    status: row.status,
    needs: NEED_WORDS[needRank(row, today)],
    company_id: row.company_id ?? null,
    renews_on: row.renews_on ?? null,
    price_minor:
      row.price_minor === null || row.price_minor === undefined ? null : String(row.price_minor),
    currency: row.currency ?? null,
    org_access: row.org_access ?? "editor",
  }
}

export interface SearchParams {
  status?: string
  company_id?: string
  kind?: string
  renews_before?: string
  query?: string
  limit?: number
}

export async function agreementsSearch(ctx: AgreementsCtx, p: SearchParams) {
  const where: Record<string, unknown> = {}
  if (p.status) where.status = p.status
  if (p.company_id) where.company_id = p.company_id
  if (p.kind) where.kind = p.kind
  let rows = (await ctx.db.findMany("agreements", { where, limit: 1000 })) as AgreementRow[]
  if (p.renews_before) {
    const before = p.renews_before
    rows = rows.filter((r) => !!r.renews_on && r.renews_on < before)
  }
  if (p.query) {
    const q = p.query.toLowerCase()
    rows = rows.filter(
      (r) => r.title.toLowerCase().includes(q) || r.number.toLowerCase().includes(q),
    )
  }
  const today = todayOf(ctx)
  const limit = Math.min(Math.max(p.limit ?? 25, 1), 200)
  const ordered = orderByNeed(rows, today)
  const items = ordered.slice(0, limit).map((r) => brief(r, today))
  return {
    status: "ok",
    items,
    total: ordered.length,
    message:
      items.length === 0
        ? "No agreement matches. Create one with agreement_create."
        : `${ordered.length} agreement(s), what needs someone first${ordered.length > items.length ? `; the first ${items.length} shown` : ""}. Open one with agreement_get.`,
  }
}

async function loadAgreement(
  ctx: AgreementsCtx,
  id: unknown,
): Promise<AgreementRow | ErrorEnvelope> {
  if (typeof id !== "string" || !UUID.test(id))
    return refusal("NOT_FOUND", "No agreement with this id. Find it with agreements_search.")
  const row = (await ctx.db.findOne("agreements", id)) as AgreementRow | null
  if (!row)
    return refusal("NOT_FOUND", `No agreement ${id} you can see. Find it with agreements_search.`)
  return row
}

async function loadDraft(ctx: AgreementsCtx, agreementId: string): Promise<DraftRow | null> {
  const rows = (await ctx.db.findMany("agreement_drafts", {
    where: { agreement_id: agreementId },
    limit: 1,
  })) as DraftRow[]
  return rows[0] ?? null
}

const isError = (v: unknown): v is ErrorEnvelope =>
  !!v && typeof v === "object" && (v as { status?: unknown }).status === "error"

export async function agreementGet(ctx: AgreementsCtx, p: { id: string }) {
  const row = await loadAgreement(ctx, p.id)
  if (isError(row)) return row
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: row.id },
    orderBy: { number: "asc" },
    limit: 200,
  })) as Array<{
    id: string
    number: number
    status: string
    sha256?: string | null
    page_count?: number | null
    frozen_at?: string
    file_id?: string | null
    copy_differs_at?: string | null
  }>
  const draft = await loadDraft(ctx, row.id)
  const me = await callerUserId(ctx)
  const shares = await currentShares(ctx, row.id)
  // The links of the version that went out: the latest one, once the agreement left draft.
  const latest = versions[versions.length - 1]
  const links = latest && row.status !== "draft" ? await linksOf(ctx, latest.id) : []
  return {
    status: "ok",
    agreement: {
      ...brief(row, todayOf(ctx)),
      what_it_is: row.what_it_is ?? null,
      starts_on: row.starts_on ?? null,
      ends_on: row.ends_on ?? null,
      template_id: row.template_id ?? null,
      template_version: row.template_version ?? null,
      ...(row.not_a_guarantee_by_user_id ? { not_a_guarantee: true } : {}),
      ...(draft?.upload_file_id ? { upload: true } : {}),
      ...(row.status === "imported" ? { status_note: "Imported, signed outside Liaison" } : {}),
    },
    draft: draft ? { lock_version: draft.lock_version, source: draft.source ?? null } : null,
    versions: versions.map((v) => ({
      id: v.id,
      number: v.number,
      status: v.status,
      sha256: v.sha256 ?? null,
      page_count: v.page_count ?? null,
      frozen_at: v.frozen_at ?? null,
      file_id: v.file_id ?? null,
      // The signed copy did not read as the frozen file: nothing was sealed (no repair).
      ...(v.copy_differs_at ? { copy_differs: true } : {}),
    })),
    shares: shares.map((s) => ({ user_id: s.user_id, role: s.role })),
    // An admin's claim, once every person on the list had left, stays shown to whoever reads it.
    claimed: row.claimed_by_user_id
      ? { by_user_id: row.claimed_by_user_id, at: row.claimed_at ?? null }
      : null,
    signing_links: links.map((l) => ({
      client_action_id: l.id,
      signer: l.invited_name,
      email: l.invited_email,
      sign_order: l.sign_order,
      state: l.state,
      expires_at: l.expires_at,
      // The reader's own link (a staff signer): their Read and sign, never anyone else's.
      ...(me && l.signer_user_id === me ? { yours: true } : {}),
      // A decline without the emailed code may not be theirs: a new link is offered.
      ...(l.state === "declined" && !l.code_verified ? { code_verified: false } : {}),
    })),
    message:
      `Agreement ${row.number} "${row.title}" is ${row.status}${versions.length ? `, ${versions.length} version(s)` : ", no version yet"}. ${row.claimed_by_user_id ? ` An admin added themselves to its list on ${String(row.claimed_at ?? "").slice(0, 10)}, after every person on it had been deactivated for 7 days.` : ""} ${row.status === "draft" ? "Check it with agreement_prepare." : ""}`
        .replace(/\s+/g, " ")
        .trim(),
  }
}

export interface CreateParams {
  kind: string
  title: string
  company_id?: string
  contact_id?: string
  template_id?: string
  language?: "en" | "fr"
  fit_tag?: string
  source?: AgreementSource
  file_id?: string
  what_it_is?: string
  org_access?: OrgAccess
  shares?: ShareEntry[]
}

async function templateSource(
  ctx: AgreementsCtx,
  templateId: string,
): Promise<{ version: number; body: unknown; kind: string; fit_tag: string } | ErrorEnvelope> {
  const metas = (await ctx.db.findMany("agreement_template_meta", {
    where: { template_id: templateId },
    limit: 1,
  })) as Array<{ version: number; kind: string; fit_tag: string; archived?: boolean }>
  const meta = metas[0]
  if (!meta || meta.archived)
    return refusal(
      "TEMPLATE_NOT_FOUND",
      `No template ${templateId}. List them with templates_list.`,
    )
  const versions = (await ctx.db.findMany("agreement_template_versions", {
    where: { template_id: templateId, version: meta.version },
    limit: 1,
  })) as Array<{ body: unknown }>
  if (!versions[0])
    return refusal("TEMPLATE_NOT_FOUND", `Template ${templateId} has no version ${meta.version}.`)
  return { version: meta.version, body: versions[0].body, kind: meta.kind, fit_tag: meta.fit_tag }
}

export async function agreementCreate(ctx: AgreementsCtx, p: CreateParams) {
  if (!(KINDS as readonly string[]).includes(p.kind))
    return refusal(
      "INVALID_KIND",
      `Kind ${p.kind} is not one of ${KINDS.join(", ")}. Nothing was created.`,
    )
  if (typeof p.title !== "string" || p.title.trim() === "")
    return refusal("TITLE_REQUIRED", "An agreement needs a title. Nothing was created.")
  if (p.kind === "change_request")
    return refusal(
      "USE_CHANGE_REQUEST",
      "A change request is made from its parent agreement, not here. Nothing was created.",
    )
  if ("price_minor" in (p as unknown as Record<string, unknown>))
    return refusal(
      "PRICE_NEEDS_A_PERSON",
      "agreement_create never sets a price: a person sets it on the agreement's page. Nothing was created.",
    )
  if (p.file_id !== undefined && (typeof p.file_id !== "string" || !UUID.test(p.file_id)))
    return refusal(
      "INVALID_FILE",
      "file_id is the id files_upload_confirm returned for the uploaded PDF. Nothing was created.",
    )
  const agent = await actingAgentId(ctx)
  const user = await callerUserId(ctx)
  let source: AgreementSource | null = p.source ?? null
  let templateVersion: number | null = null
  let fitTag = p.fit_tag ?? "commercial"
  if (p.template_id) {
    const t = await templateSource(ctx, p.template_id)
    if (isError(t)) return t
    templateVersion = t.version
    if (!p.fit_tag) fitTag = t.fit_tag
    // The template's text is copied: a later template version never moves it.
    source = {
      body: JSON.parse(JSON.stringify(t.body)) as AgreementSource["body"],
      data: p.source?.data ?? {},
    }
  }
  if (source && (await agentWrites(ctx))) source = markAgentBlocks(null, source)
  const orgAccess: OrgAccess = p.org_access ?? "editor"
  const requested = normaliseShares(p.shares ?? [])
  if (!requested)
    return refusal(
      "INVALID_SHARES",
      "Each person on the list needs a user id and the role viewer or editor. Nothing was created.",
    )
  // The creator is on the list as editor, like anyone else.
  const list =
    user && !requested.some((s) => s.user_id === user)
      ? [{ user_id: user, role: "editor" as const }, ...requested]
      : requested.map((s) => (s.user_id === user ? { ...s, role: "editor" as const } : s))
  const now = new Date().toISOString()
  const year = now.slice(0, 4)
  const series = seriesOf(p.kind)
  const ops: DbBatchOp[] = [
    {
      insert: "agreements",
      as: "agreement",
      data: {
        number: { $seq: "formatted" },
        kind: p.kind,
        status: "draft",
        title: p.title.trim(),
        company_id: p.company_id ?? null,
        contact_id: p.contact_id ?? null,
        template_id: p.template_id ?? null,
        template_version: templateVersion,
        language: p.language ?? "en",
        fit_tag: fitTag,
        what_it_is: p.what_it_is?.trim() || null,
        what_it_is_by_user_id: p.what_it_is && agent === null ? user : null,
        org_access: "editor",
        created_by_user_id: user,
        created_by_agent_id: agent,
      },
    },
    {
      insert: "agreement_drafts",
      data: {
        agreement_id: { $ref: "agreement" },
        source,
        upload_file_id: null,
        lock_version: 1,
        next_number: 1,
        updated_by_user_id: user,
        updated_by_agent_id: agent,
      },
    },
  ]
  if (list.length > 0) {
    const acc = accessOps("", orgAccess, list, "new", user, now)
    if (isError(acc)) return acc
    ops.push(...acc)
  } else if (orgAccess === "none") {
    return refusal(
      "ACCESS_LIST_EMPTY",
      "An agreement closed to the organization needs at least one person on its list. Nothing was created.",
    )
  }
  const result = await ctx.db.batch({
    sequence: {
      key: `agreements:${series}:${year}`,
      format: { prefix: `${series}-${year}-`, pad: 3 },
      unique: { entity: "agreements", field: "number" },
    },
    ops,
  })
  const row = result.rows.agreement
  const number = result.sequence?.formatted ?? String(row?.number ?? "")
  if (orgAccess === "none" && row?.id) await emitAccessChanged(ctx, String(row.id), orgAccess, list)
  // The upload is kept on the new agreement (see keepUploadOnAgreement).
  let keptFileId: string | null = null
  let notKept = ""
  if (p.file_id !== undefined && row?.id) {
    const kept = await keepUploadOnAgreement(ctx, { ...row, number } as AgreementRow, p.file_id)
    if (isError(kept))
      notKept = `; the uploaded file ${p.file_id} could not be read by you, so it is not on the draft (agreement_update with a new file_id adds one)`
    else {
      keptFileId = kept
      await ctx.db.updateMany("agreement_drafts", {
        where: { agreement_id: row.id },
        data: { upload_file_id: kept },
      })
    }
  }
  return {
    status: "ok",
    agreement: {
      id: row?.id,
      number,
      kind: p.kind,
      status: "draft",
      title: p.title.trim(),
      org_access: orgAccess,
      file_id: keptFileId,
    },
    message: `Draft ${number} "${p.title.trim()}" was created${templateVersion ? ` from template version ${templateVersion}` : ""}${notKept}; no price was set${p.kind === "other" && !p.what_it_is ? ", and a person must still say what the document is" : ""}${!keptFileId && sourceText(source).trim() === "" ? "; it has no text yet: its clauses go in source.body.blocks (agreement_update)" : ""}. Next: agreement_prepare to check it.`,
  }
}

export interface UpdateParams {
  /** A new version from an uploaded PDF (files_upload_confirm's id). */
  file_id?: string
  id: string
  lock_version?: number
  title?: string
  source?: AgreementSource
  starts_on?: string
  ends_on?: string
  renews_on?: string
  notice_days?: number
  what_it_is?: string
  not_a_guarantee?: boolean
  org_access?: OrgAccess
  shares?: ShareEntry[]
}

export async function agreementUpdate(ctx: AgreementsCtx, p: UpdateParams) {
  const loaded = await loadAgreement(ctx, p.id)
  if (isError(loaded)) return loaded
  let row = loaded
  if ("price_minor" in (p as unknown as Record<string, unknown>))
    return refusal(
      "PRICE_NEEDS_A_PERSON",
      `The price of ${row.number} is set by a person on its page, never here. Nothing was changed.`,
    )
  let replaced: { version: number; revoked: number } | null = null
  if (p.file_id !== undefined && (typeof p.file_id !== "string" || !UUID.test(p.file_id)))
    return refusal(
      "INVALID_FILE",
      "file_id is the id files_upload_confirm returned for the uploaded PDF. Nothing was changed.",
    )
  if (SENT.includes(row.status) && (p.source !== undefined || p.file_id !== undefined)) {
    // Saving over a sent version: its open links die (`replaced`), its signatures stay on it,
    // and the next freeze makes a new version.
    const r = await replaceSentVersion(ctx, row)
    if (isError(r)) return r
    replaced = r
    row = { ...row, status: "draft" }
  }
  if (row.status !== "draft")
    return refusal(
      "NOT_A_DRAFT",
      `Agreement ${row.number} is ${row.status}: only a draft changes here. Nothing was changed.`,
    )
  const agent = await actingAgentId(ctx)
  const user = await callerUserId(ctx)
  const accessChange = p.org_access !== undefined || p.shares !== undefined
  const allShares = (await ctx.db.findMany("agreement_shares", {
    where: { agreement_id: row.id },
    limit: 500,
  })) as ShareRow[]
  const shares = allShares.filter((s) => !s.removed_at)
  let accessBatch: DbBatchOp[] = []
  let accessNow: { orgAccess: OrgAccess; list: ShareEntry[] } | null = null
  if (accessChange) {
    const orgAccess = (p.org_access ?? row.org_access ?? "editor") as OrgAccess
    if (!mayChangeAccess(user, (row.org_access ?? "editor") as OrgAccess, shares))
      return refusal(
        "NOT_AN_EDITOR",
        `Only a person on the list of ${row.number} as editor changes who can see it. Nothing was changed.`,
      )
    const list =
      p.shares !== undefined
        ? normaliseShares(p.shares)
        : shares.map((s) => ({ user_id: s.user_id, role: s.role }))
    if (!list)
      return refusal(
        "INVALID_SHARES",
        "Each person on the list needs a user id and the role viewer or editor. Nothing was changed.",
      )
    // An agent never changes who can see a document on its own: a person decides.
    if (agent !== null && !ctx.approval) {
      if (!ctx.requestApproval)
        return refusal(
          "APPROVAL_REQUIRED",
          `Changing who can see ${row.number} needs a person's decision. Nothing was changed.`,
        )
      const approval = await ctx.requestApproval({
        tool_name: "agreements:agreement_update",
        summary: `Change who can see ${row.number}`,
        summary_detail: {
          subtitle: "Who can see this agreement",
          lines: [
            `Agreement: ${row.number} "${row.title}"`,
            `Organization access: ${row.org_access ?? "editor"} to ${orgAccess}`,
            `People: ${list.map((s) => `${s.user_id} (${s.role})`).join(", ") || "(none)"}`,
          ],
        },
        current_payload: p,
        editable_fields: [],
        noAutoApprove: true,
      })
      return {
        status: "pending_approval",
        approval_id: approval.approval_id,
        message: `Nothing was changed yet: who can see ${row.number} changes only when a person approves card ${approval.approval_id}.`,
      }
    }
    const acc = accessOps(
      row.id,
      orgAccess,
      list,
      shares,
      user,
      new Date().toISOString(),
      allShares,
    )
    if (isError(acc)) return acc
    accessBatch = acc
    accessNow = { orgAccess, list }
  }
  const data: Record<string, unknown> = {}
  if (p.title !== undefined) data.title = p.title.trim()
  for (const k of ["starts_on", "ends_on", "renews_on", "notice_days"] as const)
    if (p[k] !== undefined) data[k] = p[k]
  if (p.what_it_is !== undefined) {
    data.what_it_is = p.what_it_is.trim() || null
    data.what_it_is_by_user_id = agent === null ? user : null
  }
  if (p.not_a_guarantee !== undefined) {
    if (agent !== null)
      return refusal(
        "NEEDS_A_PERSON",
        `Only a person says ${row.number} is not a personal guarantee. Nothing was changed.`,
      )
    data.not_a_guarantee_by_user_id = p.not_a_guarantee ? user : null
  }
  const ops: DbBatchOp[] = []
  if (Object.keys(data).length > 0) ops.push({ update: "agreements", id: row.id, data })
  if (p.source !== undefined || p.file_id !== undefined) {
    const draft = await loadDraft(ctx, row.id)
    if (!draft)
      return refusal("NOT_A_DRAFT", `Agreement ${row.number} has no draft. Nothing was changed.`)
    const expected = p.lock_version ?? draft.lock_version
    let uploadFileId: string | null = null
    if (p.file_id !== undefined && p.source === undefined) {
      const kept = await keepUploadOnAgreement(ctx, row, p.file_id)
      if (isError(kept)) return kept
      uploadFileId = kept
    }
    // A file makes the next version an upload; a source (a restart from the
    // template's text) makes it generated again. The template link stays.
    const body: Record<string, unknown> =
      p.source !== undefined
        ? {
            source: (await agentWrites(ctx))
              ? markAgentBlocks(draft.source ?? null, p.source)
              : p.source,
            upload_file_id: null,
            upload_state: null,
          }
        : { upload_file_id: uploadFileId, upload_state: null }
    // An agreement has one draft: it is found by its agreement, because the
    // host refuses `id` in a bulk write's filter.
    ops.push({
      updateMany: "agreement_drafts",
      where: { agreement_id: row.id, lock_version: expected },
      data: {
        ...body,
        lock_version: expected + 1,
        updated_by_user_id: user,
        updated_by_agent_id: agent,
      },
      expect: { minRows: 1, maxRows: 1 },
    })
  }
  ops.push(...accessBatch)
  if (ops.length === 0) return { status: "ok", message: `Nothing to change on ${row.number}.` }
  try {
    await ctx.db.batch({ ops })
  } catch (err) {
    const failed = batchPreconditionFailure(err)
    if (failed?.entity === "agreement_drafts")
      return refusal(
        "VERSION_CONFLICT",
        `The draft of ${row.number} changed since lock_version ${p.lock_version}: read it again with agreement_get, then save. Nothing was changed.`,
      )
    throw err
  }
  if (accessNow) await emitAccessChanged(ctx, row.id, accessNow.orgAccess, accessNow.list)
  return {
    status: "ok",
    message: `Draft ${row.number} was saved${accessChange ? "; who can see it changed" : ""}${replaced ? `; version ${replaced.version} was replaced and its ${replaced.revoked} open link(s) withdrawn, its signatures kept` : ""}. Next: agreement_prepare to check it.`,
  }
}

/** The latest frozen version of an agreement, or null. */
export async function latestVersion(
  ctx: AgreementsCtx,
  agreementId: string,
): Promise<VersionRow | null> {
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: agreementId },
    limit: 500,
  })) as VersionRow[]
  return versions.sort((a, b) => b.number - a.number)[0] ?? null
}

export interface VersionRow {
  id: string
  agreement_id: string
  number: number
  status: string
  sha256?: string | null
  file_id?: string | null
  page_count?: number | null
  source?: AgreementSource | null
  source_text?: string | null
  frozen_at?: string | null
}

/** Withdraws the open links of the sent version (reason `replaced`) and reopens the draft. */
async function replaceSentVersion(
  ctx: AgreementsCtx,
  row: AgreementRow,
): Promise<{ version: number; revoked: number } | ErrorEnvelope> {
  const v = await latestVersion(ctx, row.id)
  if (!v)
    return refusal(
      "NOT_A_DRAFT",
      `Agreement ${row.number} has no sent version. Nothing was changed.`,
    )
  if (!ctx.client_actions_revoke)
    return refusal(
      "LINKS_NOT_AVAILABLE",
      `The links of ${row.number} cannot be withdrawn on this server. Nothing was changed.`,
    )
  const out = bridgeAnswer<{
    status: string
    revoked_ids?: string[]
    error?: { code: string; message: string }
  }>(
    await ctx.client_actions_revoke({
      target_type: "agreement_version",
      target_id: v.id,
      reason: "replaced",
    }),
  )
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "REVOKE_FAILED",
      `The links of ${row.number} version ${v.number} were not withdrawn: ${out.error?.message ?? ""} Nothing was changed.`,
    )
  await ctx.db.update("agreement_versions", v.id, { status: "superseded" })
  await ctx.db.update("agreements", row.id, { status: "draft" })
  return { version: v.number, revoked: out.revoked_ids?.length ?? 0 }
}

/** Set the price: a person's own call only (the tool is hidden from agents and MCP). */
export async function agreementPriceSet(
  ctx: AgreementsCtx,
  p: { id: string; price_minor: string; currency: string },
) {
  const agent = await actingAgentId(ctx)
  const user = await callerUserId(ctx)
  if (agent !== null || ctx.approval || !user)
    return refusal(
      "PRICE_NEEDS_A_PERSON",
      "A price is set by a person on the agreement's page, never by an agent or an approval. Nothing was changed.",
    )
  const row = await loadAgreement(ctx, p.id)
  if (isError(row)) return row
  if (row.status !== "draft")
    return refusal(
      "NOT_A_DRAFT",
      `Agreement ${row.number} is ${row.status}: its price no longer changes. Nothing was changed.`,
    )
  if (typeof p.price_minor !== "string" || !/^[0-9]{1,18}$/.test(p.price_minor))
    return refusal(
      "INVALID_PRICE",
      "The price is whole minor units, digits only. Nothing was changed.",
    )
  if (typeof p.currency !== "string" || !/^[A-Z]{3}$/.test(p.currency))
    return refusal(
      "INVALID_CURRENCY",
      "The currency is a three-letter code such as EUR. Nothing was changed.",
    )
  await ctx.db.update("agreements", row.id, {
    price_minor: p.price_minor,
    currency: p.currency,
    priced_by_user_id: user,
  })
  return {
    status: "ok",
    message: `The price of ${row.number} is now ${p.price_minor} minor units of ${p.currency}. Next: agreement_prepare.`,
  }
}

export async function agreementPrepare(ctx: AgreementsCtx, p: { id: string }) {
  const row = await loadAgreement(ctx, p.id)
  if (isError(row)) return row
  if (row.status !== "draft")
    return refusal(
      "NOT_A_DRAFT",
      `Agreement ${row.number} is ${row.status}: only a draft is prepared. Nothing was frozen.`,
    )
  const draft = await loadDraft(ctx, row.id)
  const checks: Check[] = prepareChecks(row, draft?.source ?? null, {
    upload: !!draft?.upload_file_id,
  })
  const failed = checks.filter((c) => c.blocking && !c.ok)
  if (failed.length > 0) {
    const first = failed[0] as Check
    return {
      status: "error",
      error: {
        code: first.code,
        message: `${row.number} cannot be prepared: ${failed.map((c) => c.message).join(" ")} Nothing was frozen.`,
      },
      checks,
    }
  }
  return freezeDraft(ctx, row, draft, checks)
}

interface RenderAnswer {
  status: string
  error?: { code: string; message: string }
  bytesBase64?: string
  sha256?: string
  byteSize?: number
  pageCount?: number
  blanks?: Array<{ path: string; label: string }>
  sourceText?: string
  textMatches?: boolean
}

/** Every record a filled source reads: its own data plus the agreement's number and title. */
function freezeRecord(row: AgreementRow, source: AgreementSource): Record<string, unknown> {
  const data = (source.data ?? {}) as Record<string, unknown>
  const own = (data.agreement as Record<string, unknown> | undefined) ?? {}
  return { ...data, agreement: { ...own, number: row.number, title: row.title } }
}

/**
 * Freeze the draft as the next version: the host renders the filled source, the
 * freeze refuses a blank field and a drawn text that differs from the source's,
 * and the bytes are stored as the version's file with their hash.
 */
async function freezeDraft(
  ctx: AgreementsCtx,
  row: AgreementRow,
  draft: DraftRow | null,
  checks: Check[],
) {
  if (draft?.upload_file_id) return freezeUpload(ctx, row, draft, checks, { inJob: false })
  if (!draft?.source)
    return {
      status: "checked",
      version_id: null,
      sha256: null,
      page_count: null,
      checks,
      message: `${row.number} passes every check. No version was frozen: it has no written text yet (an uploaded file is frozen when its pages are read). Write it with agreement_update.`,
    }
  if (!ctx.rich_text_render || !ctx.files_importAttachment)
    return refusal(
      "FREEZE_NOT_AVAILABLE",
      `This server cannot render ${row.number} for a freeze. Nothing was frozen.`,
    )
  // A priced kind freezes with the person's price in its text (S703).
  const source = priceInSource(row, draft.source)
  const out = bridgeAnswer<RenderAnswer>(
    await ctx.rich_text_render({
      body: source.body,
      data: freezeRecord(row, source),
      title: row.title,
    }),
  )
  if (out.status !== "ok" || !out.bytesBase64 || !out.sha256)
    return refusal(
      out.error?.code ?? "RENDER_FAILED",
      `${row.number} could not be rendered: ${out.error?.message ?? "no file"}. Nothing was frozen.`,
    )
  const blanks = out.blanks ?? []
  if (blanks.length > 0)
    return {
      status: "error",
      error: {
        code: "BLANK_FIELD",
        message: `${row.number} still has blank fields: ${blanks.map((b) => b.label).join(", ")}. Fill them with agreement_update. Nothing was frozen.`,
      },
      blanks: blanks.map((b) => b.label),
      checks,
    }
  if (out.textMatches !== true)
    return refusal(
      "FREEZE_TEXT_MISMATCH",
      `The laid-out text of ${row.number} differs from its source, so it was not frozen. Nothing was frozen; report this document.`,
    )
  const user = await callerUserId(ctx)
  const number = Math.max(1, Number((draft as { next_number?: number }).next_number ?? 1))
  const version = (await ctx.db.insert("agreement_versions", {
    agreement_id: row.id,
    number,
    source,
    source_text: out.sourceText ?? "",
    sha256: out.sha256,
    byte_size: out.byteSize ?? null,
    page_count: out.pageCount ?? null,
    frozen_at: new Date().toISOString(),
    frozen_by_user_id: user,
    source_kind: "generated",
    source_text_origin: "rendered",
    status: "frozen",
  })) as { id: string }
  const file = bridgeAnswer<{ id?: string }>(
    await ctx.files_importAttachment({
      targetApp: "agreements",
      targetEntityType: "agreement_version",
      targetEntityId: version.id,
      filename: `${row.number}-v${number}.pdf`,
      mimeType: "application/pdf",
      bytesBase64: out.bytesBase64,
    }),
  )
  if (file?.id) await ctx.db.update("agreement_versions", version.id, { file_id: file.id })
  await ctx.db.update("agreement_drafts", draft.id, { next_number: number + 1 })
  return {
    status: "ok",
    version_id: version.id,
    version: number,
    sha256: out.sha256,
    page_count: out.pageCount ?? null,
    checks,
    message: `${row.number} version ${number} is frozen (${out.pageCount ?? "?"} page(s), fingerprint ${out.sha256.slice(0, 12)}). Nothing was sent. Next: agreement_send with this version_id and sha256.`,
  }
}

/**
 * Keep a person's upload on the agreement itself: the host copies the file
 * the caller can read onto the agreement, so whoever may see the agreement
 * (the system run finishing a long check included) reads it under the same
 * row rules, and a restricted agreement hides it. Answers the copy's id.
 */
async function keepUploadOnAgreement(
  ctx: AgreementsCtx,
  row: AgreementRow,
  fileId: string,
): Promise<string | ErrorEnvelope> {
  const notKept = refusal(
    "NOT_READABLE",
    `The uploaded file ${fileId} cannot be read by you here, so ${row.number} was not changed. Upload it again with files_upload_url, then pass the new file_id.`,
  )
  if (!ctx.files_attachToParent) return notKept
  try {
    const copy = bridgeAnswer<{ id?: string }>(
      await ctx.files_attachToParent({
        sourceFileId: fileId,
        targetApp: "agreements",
        targetEntityType: "agreement",
        targetEntityId: row.id,
      }),
    )
    return copy?.id ? copy.id : notKept
  } catch {
    return notKept
  }
}

/** A tool call waits this long for an upload's checks; past it the job finishes them. */
export const UPLOAD_CHECK_DEADLINE_MS = 20_000

interface UploadCheckAnswer {
  status: string
  error?: { code: string; message: string }
  sha256?: string
  byteSize?: number
  pageCount?: number
  pagesSha256?: string
  scanState?: "clean" | "not_run"
  scanned?: boolean
  report?: {
    revisions: number
    signed: boolean
    emptyFields: number
    comments: number
    fontsNotEmbedded: number
    openGoTo: boolean
  }
}

/** What the person is told of a kept file, in short plain facts (16.2's "kept" rows). */
function keptLines(out: UploadCheckAnswer): string[] {
  const r = out.report
  const lines: string[] = []
  if (r?.signed)
    lines.push(
      "It already holds a digital signature: it stays valid in the original file, not in the signed copy.",
    )
  if (out.scanned) lines.push("It has no text (a scan): it is read as pictures only.")
  if (r && r.emptyFields > 0)
    lines.push(`${r.emptyFields} empty field(s) in this file will stay empty.`)
  if (r && r.comments > 0) lines.push(`It holds ${r.comments} comment(s).`)
  if (r && r.revisions > 0) lines.push(`It holds ${r.revisions} earlier revision(s).`)
  return lines
}

/**
 * Freeze an uploaded PDF as the next version, as is: the host checks it in the
 * render service (one reading, or refused), then the version row is written
 * and the host stores the uploaded bytes untouched with every page picture. A
 * refused file leaves no version. A tool call over 20 s answers `checking`
 * and the `upload-freeze` job finishes the same work.
 */
async function freezeUpload(
  ctx: AgreementsCtx,
  row: AgreementRow,
  draft: DraftRow,
  checks: Check[],
  opts: { inJob: boolean },
) {
  const fileId = draft.upload_file_id as string
  if (!ctx.pdf_upload_check || !ctx.pdf_upload_freeze)
    return refusal(
      "FREEZE_NOT_AVAILABLE",
      `This server cannot read an uploaded file for ${row.number}. Nothing was frozen.`,
    )
  const out = bridgeAnswer<UploadCheckAnswer>(
    await ctx.pdf_upload_check({
      fileId,
      ...(opts.inJob ? {} : { deadlineMs: UPLOAD_CHECK_DEADLINE_MS }),
    }),
  )
  if (out.status === "checking") {
    await ctx.db.update("agreement_drafts", draft.id, { upload_state: "checking" })
    return {
      status: "checking",
      version_id: null,
      checks,
      message: `The file of ${row.number} is still being checked. Nothing was frozen yet: the result arrives here when the check ends.`,
    }
  }
  if (out.status !== "ok" || !out.sha256 || !out.pagesSha256) {
    if (opts.inJob) await ctx.db.update("agreement_drafts", draft.id, { upload_state: null })
    return refusal(
      out.error?.code ?? "PDF_UNREADABLE",
      `The file of ${row.number} was not frozen: ${out.error?.message ?? "it could not be read."}`,
    )
  }
  const number = Math.max(1, Number(draft.next_number ?? 1))
  const user = opts.inJob ? (draft.updated_by_user_id ?? null) : await callerUserId(ctx)
  const version = (await ctx.db.insert("agreement_versions", {
    agreement_id: row.id,
    number,
    source: null,
    source_text: null,
    sha256: out.sha256,
    byte_size: out.byteSize ?? null,
    page_count: out.pageCount ?? null,
    frozen_at: new Date().toISOString(),
    frozen_by_user_id: user,
    source_kind: "uploaded",
    source_text_origin: out.scanned ? null : "pdf_extract",
    pages_sha256: out.pagesSha256,
    file_report: out.report ?? null,
    scan_state: out.scanState ?? "not_run",
    status: "frozen",
  })) as { id: string }
  const stored = bridgeAnswer<{
    status: string
    error?: { code: string; message: string }
    fileId?: string
    pages?: Array<{ n: number; text: string }>
  }>(
    await ctx.pdf_upload_freeze({
      fileId,
      versionId: version.id,
      sha256: out.sha256,
      pagesSha256: out.pagesSha256,
      filename: `${row.number}-v${number}.pdf`,
    }),
  )
  if (stored.status !== "ok" || !stored.fileId || !stored.pages) {
    // The row cannot be deleted; it is set aside so it is never sent or signed.
    await ctx.db.update("agreement_versions", version.id, { status: "superseded" })
    return refusal(
      stored.error?.code ?? "PDF_UNREADABLE",
      `The file of ${row.number} was not frozen: ${stored.error?.message ?? "it was not stored."}`,
    )
  }
  await ctx.db.update("agreement_versions", version.id, {
    file_id: stored.fileId,
    pages: stored.pages,
    source_text: out.scanned ? null : stored.pages.map((p) => p.text).join("\n"),
  })
  await ctx.db.update("agreement_drafts", draft.id, {
    next_number: number + 1,
    upload_file_id: null,
    upload_state: null,
  })
  const kept = keptLines(out)
  return {
    status: "ok",
    version_id: version.id,
    version: number,
    sha256: out.sha256,
    page_count: out.pageCount ?? null,
    checks,
    message: `${row.number} version ${number} is frozen from the uploaded file, as is (${out.pageCount ?? "?"} page(s), fingerprint ${out.sha256.slice(0, 12)}).${kept.length ? ` ${kept.join(" ")}` : ""} Nothing was sent. Next: agreement_send with this version_id and sha256.`,
  }
}

/** The `upload-freeze` job: finish the uploads a tool call left `checking`. */
export async function uploadFreezeJob(ctx: AgreementsCtx) {
  const drafts = (await ctx.db.findMany("agreement_drafts", {
    where: { upload_state: "checking" },
    limit: 20,
  })) as DraftRow[]
  let frozen = 0
  for (const draft of drafts) {
    if (!draft.upload_file_id) continue
    const row = (await ctx.db.findOne("agreements", draft.agreement_id)) as AgreementRow | null
    if (!row || row.status !== "draft") {
      await ctx.db.update("agreement_drafts", draft.id, { upload_state: null })
      continue
    }
    const out = await freezeUpload(ctx, row, draft, [], { inJob: true })
    if ((out as { status?: string }).status === "ok") frozen++
  }
  return { status: "ok", frozen }
}

/**
 * The `upload-rescan` job: scan again the uploaded versions whose virus scan
 * did not run, and record each answer. While the scanner still does not
 * answer it stops at the first version and tries again on its next run.
 */
export async function uploadRescanJob(ctx: AgreementsCtx) {
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { scan_state: "not_run", source_kind: "uploaded" },
    limit: 20,
  })) as Array<{ id: string; source_kind: string; scan_state: string }>
  let scanned = 0
  let infected = 0
  for (const v of versions) {
    const state = await rescannedState(ctx, v)
    if (state === "not_run" || state === null) break
    await ctx.db.update("agreement_versions", v.id, { scan_state: state })
    scanned++
    if (state === "infected") infected++
  }
  return { status: "ok", scanned, infected }
}

export async function approvalRouteRead(
  ctx: AgreementsCtx,
  p: { entityType: string; entityId: string },
) {
  if (p.entityType !== "agreements:agreement") return {}
  const row = (await ctx.db.findOne("agreements", p.entityId)) as AgreementRow | null
  if (!row) return {}
  return {
    ...(row.company_id ? { companyId: row.company_id } : {}),
    ...(row.contact_id ? { personId: row.contact_id } : {}),
  }
}
