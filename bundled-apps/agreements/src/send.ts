// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending a frozen version for signature, and what follows: the person outside
// signs or declines through the kernel's client action (never through a tool
// here), and the app's subscriber writes the signature event, opens the next
// signer's turn, and moves the agreement on. Void and a new link withdraw links.
// Links are minted and withdrawn only through the kernel's bridge methods,
// inside the person's decision on the gated tool; nothing here signs.

import { currentShares } from "./access"
import { runChangeRequestEffects } from "./change-request-effects"
import {
  acceptChangeRequest,
  CHANGE_REQUEST,
  decisionFits,
  declineChangeRequest,
  RECORDED_APPROVAL,
} from "./change-requests"
import { UNFIT_TAGS } from "./checks"
import { type AgreementsCtx, actingAgentId, bridgeAnswer, type ErrorEnvelope, refusal } from "./ctx"
import { type CopyState, copyStateOf, eventsOf, type SealCtx, sealVersion } from "./seal"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const EXPIRY_CHOICES = [7, 14, 30] as const
export const TARGET_TYPE = "agreement_version"

interface Agreement {
  id: string
  number: string
  title: string
  status: string
  kind: string
  fit_tag?: string | null
  company_id?: string | null
  language?: string | null
  org_access?: string | null
}

interface Version {
  id: string
  agreement_id: string
  number: number
  status: string
  sha256?: string | null
  file_id?: string | null
  page_count?: number | null
  source?: { body?: { blocks?: unknown[] } } | null
  source_text?: string | null
  source_kind?: string | null
  pages?: Array<{ n: number; picture_file_id: string; sha256: string; text: string }> | null
  pages_sha256?: string | null
  scan_state?: string | null
}

export interface SignerInput {
  contact_id?: string
  email?: string
  name?: string
}

export interface SendParams {
  version_id: string
  sha256: string
  mode?: "sign" | "accept"
  signers: SignerInput[]
  order?: "sequential" | "any"
  expires_in_days?: number
  message?: string
  required_phrase?: string
  /** Pinned by the card's preflight; the approved call carries them unchanged. */
  sendGuard?: Record<string, unknown>
  guardKey?: string
}

interface Resolved {
  contact_id: string | null
  email: string
  name: string
}

const isError = (v: unknown): v is ErrorEnvelope =>
  !!v && typeof v === "object" && (v as { status?: unknown }).status === "error"

async function loadVersion(ctx: AgreementsCtx, id: unknown): Promise<Version | ErrorEnvelope> {
  if (typeof id !== "string" || !UUID.test(id))
    return refusal(
      "NOT_FOUND",
      "No version with this id. Freeze one with agreement_prepare. Nothing was sent.",
    )
  const v = (await ctx.db.findOne("agreement_versions", id)) as Version | null
  if (!v) return refusal("NOT_FOUND", `No version ${id} you can see. Nothing was sent or changed.`)
  return v
}

async function loadAgreementOf(ctx: AgreementsCtx, v: Version): Promise<Agreement | ErrorEnvelope> {
  const a = (await ctx.db.findOne("agreements", v.agreement_id)) as Agreement | null
  if (!a) return refusal("NOT_FOUND", `No agreement for version ${v.id}. Nothing was changed.`)
  return a
}

export async function latestOf(ctx: AgreementsCtx, agreementId: string): Promise<Version | null> {
  const all = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: agreementId },
    limit: 500,
  })) as Version[]
  return all.sort((a, b) => b.number - a.number)[0] ?? null
}

/** Normalised for the "same person twice" test: trim, lower case. */
const keyOf = (email: string) => email.trim().toLowerCase()

/**
 * The signers as the send will mint them: a contact's email read from the
 * directory, the same contact twice kept once, two contacts on one address
 * kept as two signers (the card says so), a contact with no email refused by name.
 */
export async function resolveSigners(
  ctx: AgreementsCtx,
  input: SignerInput[],
): Promise<{ signers: Resolved[]; sharedAddresses: string[] } | ErrorEnvelope> {
  if (!Array.isArray(input) || input.length === 0)
    return refusal("SIGNERS_REQUIRED", "A send needs at least one signer. Nothing was sent.")
  if (input.length > 40)
    return refusal("TOO_MANY_SIGNERS", "A send has at most 40 signers. Nothing was sent.")
  const contactIds = input
    .map((s) => s.contact_id)
    .filter((id): id is string => typeof id === "string" && UUID.test(id))
  const contacts = new Map<string, Record<string, unknown>>()
  if (contactIds.length > 0) {
    const kernel = ctx.kernel as
      | { findByIds?: (e: "contacts", ids: string[]) => Promise<Record<string, unknown>[]> }
      | undefined
    const rows = kernel?.findByIds ? await kernel.findByIds("contacts", contactIds) : []
    for (const r of rows) contacts.set(String(r.id), r)
  }
  const out: Resolved[] = []
  const seenContacts = new Set<string>()
  const seenEmails = new Set<string>()
  const noEmail: string[] = []
  for (const s of input) {
    if (s.contact_id) {
      if (!UUID.test(s.contact_id))
        return refusal("INVALID_SIGNER", `${s.contact_id} is not a contact id. Nothing was sent.`)
      if (seenContacts.has(s.contact_id)) continue
      const c = contacts.get(s.contact_id)
      if (!c)
        return refusal("NOT_FOUND", `No contact ${s.contact_id} you can see. Nothing was sent.`)
      const name = String(s.name ?? c.name ?? c.email ?? "").trim()
      const directory = String(c.email ?? "").trim()
      const given = String(s.email ?? "").trim()
      // A contact signs at the directory's address: another one is a signer of its own. A contact
      // with no address takes the one given.
      if (directory && given && keyOf(given) !== keyOf(directory))
        return refusal(
          "NOT_THE_CONTACTS_ADDRESS",
          `${name || s.contact_id}'s address in the directory is ${directory}, not ${given}. To ask ${given}, name that signer by email only, or correct the contact first. Nothing was sent.`,
        )
      const email = directory || given
      if (!email) {
        noEmail.push(name || s.contact_id)
        continue
      }
      seenContacts.add(s.contact_id)
      out.push({ contact_id: s.contact_id, email: keyOf(email), name: name || email })
      continue
    }
    const email = String(s.email ?? "").trim()
    if (!EMAIL.test(email))
      return refusal(
        "INVALID_SIGNER",
        "Each signer is a contact or an email address. Nothing was sent.",
      )
    if (out.some((o) => o.contact_id === null && o.email === keyOf(email))) continue
    out.push({ contact_id: null, email: keyOf(email), name: String(s.name ?? email).trim() })
  }
  if (noEmail.length > 0)
    return refusal(
      "SIGNER_HAS_NO_EMAIL",
      `No email address for ${noEmail.join(", ")}: add one to the contact, or leave them out. Nothing was sent.`,
    )
  const shared: string[] = []
  for (const o of out) {
    if (seenEmails.has(o.email) && !shared.includes(o.email)) shared.push(o.email)
    seenEmails.add(o.email)
  }
  return { signers: out, sharedAddresses: shared }
}

interface Ready {
  agreement: Agreement
  version: Version
  signers: Resolved[]
  sharedAddresses: string[]
  mode: "sign" | "accept"
  order: "sequential" | "any"
  expires: number
  /** The uploaded file's virus scan, as it stands after the send's own scan. */
  scanState: string | null
}

/** The virus scan of an uploaded version, run again while it has not run. */
export async function rescannedState(
  ctx: AgreementsCtx,
  version: { id: string; source_kind?: string | null; scan_state?: string | null },
): Promise<string | null> {
  const before = version.scan_state ?? null
  if (version.source_kind !== "uploaded" || before !== "not_run" || !ctx.pdf_upload_rescan)
    return before
  const out = bridgeAnswer<{ status: string; scanState?: string }>(
    await ctx.pdf_upload_rescan({ versionId: version.id }),
  )
  return out.status === "ok" && out.scanState ? out.scanState : before
}

/**
 * Every refusal a send has, before any card and again when it is approved.
 * `record` (the send itself, not its check) keeps a scan that now answered.
 */
async function readyToSend(
  ctx: AgreementsCtx,
  p: SendParams,
  opts: { record?: boolean } = {},
): Promise<Ready | ErrorEnvelope> {
  const version = await loadVersion(ctx, p.version_id)
  if (isError(version)) return version
  const agreement = await loadAgreementOf(ctx, version)
  if (isError(agreement)) return agreement
  const latest = await latestOf(ctx, agreement.id)
  if (
    !latest ||
    latest.id !== version.id ||
    version.status !== "frozen" ||
    version.sha256 !== p.sha256
  )
    return refusal(
      "VERSION_CHANGED",
      `${agreement.number} changed since this send was prepared: version ${version.number} is no longer the one to send. Read it again with agreement_get. Nothing was sent.`,
    )
  if (agreement.status !== "draft")
    return refusal(
      "ALREADY_SENT",
      `${agreement.number} is ${agreement.status}. A new version is sent after a save and a freeze. Nothing was sent.`,
    )
  if ((UNFIT_TAGS as readonly string[]).includes(agreement.fit_tag ?? ""))
    return refusal(
      "SIGNATURE_DOES_NOT_FIT",
      `${agreement.number} is a ${agreement.fit_tag} document: a simple electronic signature does not fit it. Nothing was sent.`,
    )
  const mode = p.mode ?? "sign"
  if (mode !== "sign" && mode !== "accept")
    return refusal("INVALID_MODE", "mode is sign or accept. Nothing was sent.")
  const order = p.order ?? "sequential"
  if (order !== "sequential" && order !== "any")
    return refusal("INVALID_ORDER", "order is sequential or any. Nothing was sent.")
  const expires = p.expires_in_days ?? 14
  if (!(EXPIRY_CHOICES as readonly number[]).includes(expires))
    return refusal("INVALID_EXPIRY", "A link lasts 7, 14 or 30 days. Nothing was sent.")
  const r = await resolveSigners(ctx, p.signers)
  if (isError(r)) return r
  const scanState = await rescannedState(ctx, version)
  if (opts.record && scanState !== (version.scan_state ?? null))
    await ctx.db.update("agreement_versions", version.id, { scan_state: scanState })
  if (scanState === "infected")
    return refusal(
      "PDF_INFECTED",
      `The virus scanner found something in the file of ${agreement.number} version ${version.number}: it is not sent. Upload a clean file and prepare it again. Nothing was sent.`,
    )
  return {
    agreement,
    version,
    signers: r.signers,
    sharedAddresses: r.sharedAddresses,
    mode,
    order,
    expires,
    scanState,
  }
}

function cardLines(ready: Ready, p: SendParams): string[] {
  const lines = [
    `Agreement: ${ready.agreement.number} "${ready.agreement.title}", version ${ready.version.number}`,
    `Fingerprint: ${String(ready.version.sha256)}`,
    `Asks: ${ready.mode === "sign" ? "a simple electronic signature" : "an acceptance"}, ${ready.order === "sequential" ? "one after the other" : "in any order"}`,
    ...ready.signers.map(
      (s, i) => `Signer ${i + 1}: ${s.name} <${s.email}>${s.contact_id ? "" : " (not a contact)"}`,
    ),
    `Links last ${ready.expires} days`,
  ]
  if (ready.scanState === "not_run") lines.push("Not checked for viruses.")
  for (const a of ready.sharedAddresses)
    lines.push(
      `Two signers share ${a}: each signs with their own name and their own code, and each copy shows that signer's device.`,
    )
  // A signer is not a reader: on a restricted agreement a colleague off its list signs by their
  // own link and reads the document only there, and the card says so before anyone approves.
  if (ready.agreement.org_access === "none")
    lines.push(
      "Restricted document: a signer who works here but is not on its list signs by their own link and reads it only there.",
    )
  if (p.required_phrase) lines.push(`Each signer types: "${p.required_phrase}"`)
  if (p.message) lines.push(`Message: ${p.message}`)
  return lines
}

interface MintAnswer {
  status: string
  error?: { code: string; message: string }
  group_id?: string
  actions?: Array<{
    id: string
    status: string
    sign_order: number | null
    invited_name: string
    signer_is_staff: boolean
    mail_queued: boolean
  }>
}

/** One send's key: the version, its fingerprint and every signer's address. */
export function sendGuardKey(ready: Pick<Ready, "version" | "signers">): string {
  const emails = [...new Set(ready.signers.map((x) => x.email))].sort()
  return `${ready.version.id}:${String(ready.version.sha256)}:${emails.join(",")}`
}

/** The service-mail check the card pins: every signer's address, checked again when it goes. */
function sendGuardOf(ready: Ready): Record<string, unknown> {
  const at = new Date().toISOString()
  return {
    v: 1,
    applies: true,
    mode: "plain",
    since: at,
    stagedAt: at,
    addresses: ready.signers.map((x) => x.email),
    contactIds: ready.signers.flatMap((x) => (x.contact_id ? [x.contact_id] : [])),
    refs: [],
    classification: "service",
  }
}

/**
 * Checked before the card is staged: the same refusals the send has when it is approved.
 * Pins the send check and the send's key, so the approved call is held to the card.
 */
export async function agreementSendPreflight(
  ctx: AgreementsCtx,
  p: SendParams,
): Promise<
  | { ok: true; pinnedParams: { sendGuard: Record<string, unknown>; guardKey: string } }
  | { error: { code: string; message: string } }
> {
  const ready = await readyToSend(ctx, p)
  if (isError(ready)) return { error: ready.error }
  return {
    ok: true,
    pinnedParams: { sendGuard: sendGuardOf(ready), guardKey: sendGuardKey(ready) },
  }
}

/** `agreement_send`: an agent's call parks one card; the person's decision mints every link. */
export async function agreementSend(ctx: AgreementsCtx, p: SendParams) {
  const ready = await readyToSend(ctx, p, { record: true })
  if (isError(ready)) return ready
  const agent = await actingAgentId(ctx)
  if (agent !== null && !ctx.approval) {
    if (!ctx.requestApproval)
      return refusal(
        "APPROVAL_REQUIRED",
        `Sending ${ready.agreement.number} needs a person's decision. Nothing was sent.`,
      )
    const a = await ctx.requestApproval({
      tool_name: "agreements:agreement_send",
      summary: `Send ${ready.agreement.number} for signature`,
      summary_detail: { subtitle: "Send for signature", lines: cardLines(ready, p) },
      current_payload: p,
      editable_fields: [],
      noAutoApprove: true,
    })
    return {
      status: "pending_approval",
      approval_id: a.approval_id,
      message: `Nothing was sent yet: ${ready.agreement.number} version ${ready.version.number} goes to ${ready.signers.length} signer(s) only when a person approves card ${a.approval_id}.`,
    }
  }
  // An approved call is the one its card showed: the pinned check and key must still match.
  if (ctx.approval || p.sendGuard !== undefined || p.guardKey !== undefined) {
    const guard = p.sendGuard
    const addresses = Array.isArray(guard?.addresses) ? (guard.addresses as unknown[]) : []
    if (
      !guard ||
      p.guardKey !== sendGuardKey(ready) ||
      !ready.signers.every((x) => addresses.includes(x.email))
    )
      return refusal(
        "SEND_GUARD_MISMATCH",
        `${ready.agreement.number} version ${ready.version.number} no longer matches the card that was approved (another signer, address or version). Nothing was sent. Next: send it again for a new decision.`,
      )
  }
  if (!ctx.client_actions_mint)
    return refusal(
      "LINKS_NOT_AVAILABLE",
      "This server cannot make signing links. Nothing was sent.",
    )
  // A restricted agreement's links are seen only by its list: the client actions carry it, so
  // the kernel lists them for those people alone and opens no automatic portal share.
  const visibleTo =
    ready.agreement.org_access === "none"
      ? (await currentShares(ctx, ready.agreement.id)).map((s) => s.user_id)
      : null
  const out = bridgeAnswer<MintAnswer>(
    await ctx.client_actions_mint({
      send: {
        ...(visibleTo ? { visible_to: visibleTo } : {}),
        target_type: TARGET_TYPE,
        target_id: ready.version.id,
        sha256: ready.version.sha256,
        kind: ready.mode,
        expires_in_days: ready.expires,
        order: ready.order,
        message: p.message ?? null,
        required_phrase: p.required_phrase ?? null,
        company_id: ready.agreement.company_id ?? null,
        signers: ready.signers,
        ...(p.sendGuard ? { send_guard: p.sendGuard } : {}),
      },
    }),
  )
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "SEND_FAILED",
      `${ready.agreement.number} was not sent: ${out.error?.message ?? "no link was made"}`,
    )
  await ctx.db.update("agreements", ready.agreement.id, { status: "sent" })
  await ctx.emit?.({
    entity: "agreement",
    action: "sent",
    entityId: ready.agreement.id,
    data: { number: ready.agreement.number, version: ready.version.number },
  })
  const actions = out.actions ?? []
  const first = actions.filter((a) => a.status === "open")
  const waiting = actions.filter((a) => a.status === "waiting_turn")
  const staff = actions.filter((a) => a.signer_is_staff && a.status === "open")
  return {
    status: "ok",
    agreement: { id: ready.agreement.id, number: ready.agreement.number, status: "sent" },
    version: { id: ready.version.id, number: ready.version.number },
    client_actions: actions.map((a) => ({
      id: a.id,
      signer: a.invited_name,
      sign_order: a.sign_order,
      state: a.status,
      signs_in_session: a.signer_is_staff,
    })),
    message: `${ready.agreement.number} version ${ready.version.number} was sent: ${first.map((a) => a.invited_name).join(", ")} can ${ready.mode} now${staff.length ? ` (${staff.map((a) => a.invited_name).join(", ")} in their own session, no mailed link)` : ""}${waiting.length ? `; ${waiting.map((a) => a.invited_name).join(", ")} get a link only after the signer before them` : ""}. Nothing else was sent.`,
  }
}

interface ViewParams {
  targetType: string
  targetId: string
}

/**
 * `client_action_view_get` (internal): what a person outside is shown for one
 * version, and the hash of exactly that. Called by the kernel only.
 */
export async function clientActionViewGet(ctx: AgreementsCtx, p: ViewParams) {
  if (p.targetType !== TARGET_TYPE) return refusal("NOT_FOUND", "Not an agreement version.")
  const v = await loadVersion(ctx, p.targetId)
  if (isError(v)) return v
  const a = await loadAgreementOf(ctx, v)
  if (isError(a)) return a
  if (!v.sha256) return refusal("NOT_FROZEN", `Version ${v.number} has no file yet.`)
  return {
    title: `${a.number} ${a.title}`,
    summary: [
      { k: "Agreement", v: a.number },
      { k: "Version", v: String(v.number) },
      { k: "Pages", v: String(v.page_count ?? "") },
    ],
    source_blocks: Array.isArray(v.source?.body?.blocks) ? v.source?.body?.blocks : null,
    text: v.source_text ?? null,
    // A file a later scan found infected is never handed out; its pictures stay.
    pdf_file_id: v.scan_state === "infected" ? null : (v.file_id ?? null),
    ...(v.source_kind === "uploaded" && Array.isArray(v.pages)
      ? {
          pages: v.pages.map((pg) => ({
            n: pg.n,
            picture_file_id: pg.picture_file_id,
            sha256: pg.sha256,
            text: pg.text,
          })),
          pages_sha256: v.pages_sha256 ?? null,
        }
      : {}),
    sha256: v.sha256,
    words_params: { number: a.number, version: String(v.number) },
    copies: await copyStatesOf(ctx, v.id),
    // A send to a portal client of the company opens it on their portal under this kind.
    portal_share_kind: a.kind === "change_request" ? "change_request" : "agreement",
  }
}

/** Each signer's copy state of a version, by client action id (the token page's last frame). */
async function copyStatesOf(
  ctx: AgreementsCtx,
  versionId: string,
): Promise<Record<string, CopyState>> {
  const out: Record<string, CopyState> = {}
  for (const e of await eventsOf(ctx, versionId))
    out[e.client_action_id] = await copyStateOf(ctx, versionId, e.client_action_id)
  return out
}

interface DecidedEvent {
  data?: {
    id?: string
    target?: { app?: string; type?: string; id?: string }
    decision?: string
  }
}

interface ActionRecord {
  id: string
  target_id?: string
  decision: string | null
  decided_at: string | null
  invited_email: string
  invited_name: string
  invited_by: string
  sign_order: number | null
  contact_id: string | null
  signer_user_id: string | null
  typed_name: string | null
  capacity: string | null
  words_shown: string | null
  words_lang: string | null
  required_phrase: string | null
  typed_phrase: string | null
  code_verified_at: string | null
  document_shown_at: string | null
  reached_end_at: string | null
  ip: string | null
  user_agent: string | null
  target_sha256: string
  /** A later link of the same signer replaced this one: its decision no longer counts. */
  replaced?: boolean
  group: Array<{ id: string; sign_order: number | null; decision: string | null; open: boolean }>
}

/** One signature event per client action: the decision as the kernel recorded it. */
async function writeSignatureEvent(
  ctx: AgreementsCtx,
  agreement: Agreement,
  version: Version,
  rec: ActionRecord,
): Promise<void> {
  const seen = async () =>
    (
      await ctx.db.findMany("signature_events", {
        where: { client_action_id: rec.id },
        limit: 1,
      })
    ).length > 0
  if (await seen()) return
  try {
    await ctx.db.insert("signature_events", {
      version_id: version.id,
      client_action_id: rec.id,
      required_phrase: rec.required_phrase,
      typed_phrase: rec.typed_phrase,
      signer_order: rec.sign_order,
      signer_contact_id: rec.contact_id,
      signer_user_id: rec.signer_user_id,
      invited_email: rec.invited_email,
      invited_by: rec.invited_by,
      typed_name: rec.typed_name ?? "",
      capacity: rec.capacity ?? "",
      consent_words: rec.words_shown ?? "",
      consent_lang: rec.words_lang ?? agreement.language ?? "en",
      level: agreement.kind === CHANGE_REQUEST ? RECORDED_APPROVAL : "ses",
      document_sha256: rec.target_sha256,
      signed_at: rec.decided_at ?? new Date().toISOString(),
      ip: rec.ip,
      user_agent: rec.user_agent,
      code_verified_at: rec.code_verified_at,
      document_shown_at: rec.document_shown_at,
      reached_end_at: rec.reached_end_at,
    })
  } catch (err) {
    // Another run wrote the same decision first: one event stands.
    if (!(await seen())) throw err
  }
}

/**
 * Writes the signature event of every live signer of the send whose decision is recorded but
 * whose event is not (a lost or concurrent delivery), from each one's own record. Answers how
 * many signers still have no event: a version is marked signed only at zero.
 */
export async function recordEverySigner(
  ctx: AgreementsCtx,
  agreement: Agreement,
  version: Version,
  group: ActionRecord["group"],
): Promise<number> {
  let missing = 0
  for (const g of group) {
    const had = await ctx.db.findMany("signature_events", {
      where: { client_action_id: g.id },
      limit: 1,
    })
    if (had.length > 0) continue
    const rec = ctx.client_actions_record
      ? bridgeAnswer<{ status: string; record?: ActionRecord }>(
          await ctx.client_actions_record({ id: g.id }),
        ).record
      : undefined
    if (
      !rec ||
      rec.replaced === true ||
      (rec.target_id !== undefined && rec.target_id !== version.id) ||
      !decisionFits(agreement.kind, rec.decision)
    ) {
      missing += 1
      continue
    }
    await writeSignatureEvent(ctx, agreement, version, rec)
  }
  return missing
}

/**
 * `kernel/client_action:decided`: for this app's versions only. A signature
 * becomes one signature event (once per client action), opens the next signer's
 * turn under "one after the other", and moves the agreement to partly signed;
 * the last one marks the version signed (the seal follows). A decline closes the
 * agreement as declined, with no signature.
 */
export async function onClientActionDecided(ctx: AgreementsCtx, event: DecidedEvent) {
  const d = event?.data
  if (d?.target?.app !== "agreements" || d.target.type !== TARGET_TYPE || !d.id || !d.target.id)
    return { status: "ignored" }
  if (!ctx.client_actions_record) return { status: "ignored" }
  const rec = bridgeAnswer<{ status: string; record?: ActionRecord }>(
    await ctx.client_actions_record({ id: d.id }),
  ).record
  if (!rec) return { status: "ignored" }
  const version = (await ctx.db.findOne("agreement_versions", d.target.id)) as Version | null
  if (!version) return { status: "ignored" }
  const agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
  if (!agreement) return { status: "ignored" }
  // A link a later one replaced counts for nothing: its signer answers on the new link.
  if (rec.replaced === true) return { status: "ignored" }
  const isChangeRequest = agreement.kind === CHANGE_REQUEST
  if (rec.decision === "declined") {
    if (agreement.status === "sent" || agreement.status === "partly_signed") {
      await ctx.db.update("agreements", agreement.id, { status: "declined" })
      await ctx.emit?.({
        entity: "agreement",
        action: "declined",
        entityId: agreement.id,
        data: { number: agreement.number, version: version.number, signer: rec.invited_name },
      })
      if (isChangeRequest) await declineChangeRequest(ctx, agreement)
    }
    return { status: "declined" }
  }
  // A change request is approved (a recorded approval), never signed; anything else is signed
  // or accepted, never approved.
  if (!decisionFits(agreement.kind, rec.decision)) return { status: "ignored" }
  // Only a version this app sent and still waits on is signed and sealed: never one of a voided,
  // declined, draft or replaced agreement, whoever minted the link.
  if (!WAITING.includes(agreement.status) || version.status !== "frozen")
    return { status: "ignored" }
  await writeSignatureEvent(ctx, agreement, version, rec)
  const positive = (x: string | null) => decisionFits(agreement.kind, x)
  let done = rec.group.filter((g) => positive(g.decision) || g.id === rec.id).length
  const all = rec.group.length
  // Every signer's decision is a recorded signature event before the version is marked signed:
  // a decision whose own delivery was lost, or whose handler runs at the same moment, is
  // written here from its record. A signer whose event cannot be written keeps it waiting.
  if (done >= all) {
    const missing = await recordEverySigner(ctx, agreement, version, rec.group)
    if (missing > 0) done = all - missing
  }
  if (done >= all && isChangeRequest) {
    // Accepted, its version marked for the seal and the parent's amended total raised, in one
    // transaction, once; then sealed and stamped like a signature.
    const accepted = await acceptChangeRequest(ctx, agreement, WAITING, version.id)
    const sealed = await sealVersion(ctx as SealCtx, version.id)
    // The work follows the recorded approval: the task, then the time plan, from the change
    // request's own claim (a crash resumes from the job, never twice).
    const effects = accepted.accepted
      ? await runChangeRequestEffects(ctx, agreement.id).catch(() => ({ status: "stopped" }))
      : undefined
    return {
      status: accepted.accepted ? "accepted" : "ignored",
      signed: done,
      of: all,
      seal: sealed.status,
      ...(effects ? { effects: effects.status } : {}),
    }
  }
  if (done >= all) {
    await ctx.db.update("agreement_versions", version.id, { status: "signed" })
    await ctx.db.update("agreements", agreement.id, { status: "signed" })
    // The seal follows at once; a failure leaves the version signed for `seal-retry`.
    const sealed = await sealVersion(ctx as SealCtx, version.id)
    return { status: "signed", signed: done, of: all, seal: sealed.status }
  }
  await ctx.db.update("agreements", agreement.id, { status: "partly_signed" })
  // The next signer of the approved send, when they wait for this one.
  if (rec.sign_order !== null && ctx.client_actions_mint)
    await ctx.client_actions_mint({ next_turn_after: rec.id })
  return { status: "partly_signed", signed: done, of: all }
}

/**
 * A document waiting for signatures, or a signed one whose signed copy read differently from
 * the frozen file (nothing was sealed): voided so a person sends it again from a clean file.
 */
async function voidable(ctx: AgreementsCtx, a: Agreement): Promise<boolean> {
  if (a.status === "sent" || a.status === "partly_signed") return true
  if (a.status !== "signed") return false
  const v = (await latestOf(ctx, a.id)) as (Version & { copy_differs_at?: string | null }) | null
  return !!v?.copy_differs_at
}

/** Checked before the card is staged: a reason, and a document still waiting for signatures. */
export async function agreementVoidPreflight(
  ctx: AgreementsCtx,
  p: { id: string; reason: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  if (typeof p.reason !== "string" || p.reason.trim() === "")
    return {
      error: { code: "REASON_REQUIRED", message: "A void needs a reason. Nothing was changed." },
    }
  const a =
    typeof p.id === "string" && UUID.test(p.id)
      ? ((await ctx.db.findOne("agreements", p.id)) as Agreement | null)
      : null
  if (!a)
    return {
      error: {
        code: "NOT_FOUND",
        message: `No agreement ${p.id} you can see. Nothing was changed.`,
      },
    }
  if (!(await voidable(ctx, a)))
    return {
      error: {
        code: "NOT_SENT",
        message: `${a.number} is ${a.status}: only a document waiting for signatures is voided. Nothing was changed.`,
      },
    }
  return { ok: true }
}

/** `agreement_void`: withdraws every open link of the sent version; signed rows stay. */
export async function agreementVoid(ctx: AgreementsCtx, p: { id: string; reason: string }) {
  if (typeof p.reason !== "string" || p.reason.trim() === "")
    return refusal("REASON_REQUIRED", "A void needs a reason. Nothing was changed.")
  const a =
    typeof p.id === "string" && UUID.test(p.id)
      ? ((await ctx.db.findOne("agreements", p.id)) as Agreement | null)
      : null
  if (!a) return refusal("NOT_FOUND", `No agreement ${p.id} you can see. Nothing was changed.`)
  if (!(await voidable(ctx, a)))
    return refusal(
      "NOT_SENT",
      `${a.number} is ${a.status}: only a document waiting for signatures is voided. Nothing was changed.`,
    )
  const v = await latestOf(ctx, a.id)
  if (!v) return refusal("NOT_SENT", `${a.number} has no sent version. Nothing was changed.`)
  const agent = await actingAgentId(ctx)
  if (agent !== null && !ctx.approval) {
    if (!ctx.requestApproval)
      return refusal(
        "APPROVAL_REQUIRED",
        `Voiding ${a.number} needs a person. Nothing was changed.`,
      )
    const ap = await ctx.requestApproval({
      tool_name: "agreements:agreement_void",
      summary: `Void ${a.number}`,
      summary_detail: {
        subtitle: "Withdraw every open signing link",
        lines: [`Agreement: ${a.number} "${a.title}", version ${v.number}`, `Reason: ${p.reason}`],
      },
      current_payload: p,
      editable_fields: [],
      noAutoApprove: true,
    })
    return {
      status: "pending_approval",
      approval_id: ap.approval_id,
      message: `Nothing was withdrawn yet: ${a.number} is voided only when a person approves card ${ap.approval_id}.`,
    }
  }
  if (!ctx.client_actions_revoke)
    return refusal("LINKS_NOT_AVAILABLE", "This server cannot withdraw links. Nothing was changed.")
  const out = bridgeAnswer<{
    status: string
    revoked_ids?: string[]
    error?: { code: string; message: string }
  }>(
    await ctx.client_actions_revoke({
      target_type: TARGET_TYPE,
      target_id: v.id,
      reason: "sender_voided",
    }),
  )
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "VOID_FAILED",
      `${a.number} was not voided: ${out.error?.message ?? ""}`,
    )
  await ctx.db.update("agreements", a.id, { status: "voided", void_reason: p.reason.trim() })
  await ctx.emit?.({
    entity: "agreement",
    action: "voided",
    entityId: a.id,
    data: { number: a.number, version: v.number },
  })
  const n = out.revoked_ids?.length ?? 0
  return {
    status: "ok",
    agreement: { id: a.id, number: a.number, status: "voided" },
    message: `${a.number} is voided: ${n} open link(s) withdrawn; signatures already given stay on version ${v.number}. Nothing was mailed.`,
  }
}

const WAITING = ["sent", "partly_signed"]

/** An agent's call with no decision yet parks; null when the call may go on. */
async function parkUnlessDecided(
  ctx: AgreementsCtx,
  tool: string,
  summary: string,
  lines: string[],
  payload: unknown,
): Promise<object | null> {
  const agent = await actingAgentId(ctx)
  if (agent === null || ctx.approval) return null
  if (!ctx.requestApproval)
    return refusal("APPROVAL_REQUIRED", `${summary} needs a person's decision. Nothing was sent.`)
  const ap = await ctx.requestApproval({
    tool_name: `agreements:${tool}`,
    summary,
    summary_detail: { subtitle: summary, lines },
    current_payload: payload,
    editable_fields: [],
    noAutoApprove: true,
  })
  return {
    status: "pending_approval",
    approval_id: ap.approval_id,
    message: `Nothing was sent yet: ${summary} happens only when a person approves card ${ap.approval_id}.`,
  }
}

interface ReminderParams {
  client_action_ids: string[]
  sendGuard?: Record<string, unknown>
  guardKey?: string
}

interface ReminderTarget {
  a: Agreement
  v: Version
  records: ActionRecord[]
}

/** The links a reminder names: all of one agreement version that waits for signatures. */
async function reminderTarget(
  ctx: AgreementsCtx,
  p: ReminderParams,
): Promise<ReminderTarget | ErrorEnvelope> {
  const ids = Array.isArray(p?.client_action_ids) ? p.client_action_ids : []
  if (ids.length === 0 || ids.length > 40)
    return refusal(
      "SIGNERS_REQUIRED",
      "A reminder names 1 to 40 signing links (client_action_ids). Nothing was sent.",
    )
  if (!ctx.client_actions_record || !ctx.client_actions_mint)
    return refusal(
      "LINKS_NOT_AVAILABLE",
      "This server cannot mail signing links. Nothing was sent.",
    )
  const records: ActionRecord[] = []
  for (const id of ids) {
    const rec = bridgeAnswer<{ status: string; record?: ActionRecord }>(
      await ctx.client_actions_record({ id: String(id) }),
    ).record
    if (!rec?.target_id)
      return refusal(
        "NOT_FOUND",
        `No signing link ${String(id)} of an agreement. Nothing was sent.`,
      )
    records.push(rec)
  }
  const target = records[0]?.target_id as string
  if (records.some((r) => r.target_id !== target))
    return refusal(
      "INVALID_SIGNERS",
      "One reminder covers the links of one agreement version. Nothing was sent.",
    )
  const v = (await ctx.db.findOne("agreement_versions", target)) as Version | null
  const a = v ? ((await ctx.db.findOne("agreements", v.agreement_id)) as Agreement | null) : null
  if (!v || !a)
    return refusal("NOT_FOUND", "No agreement you can see holds these links. Nothing was sent.")
  if (!WAITING.includes(a.status))
    return refusal(
      "NOT_SENT",
      `${a.number} is ${a.status}: a reminder goes only for a document waiting for signatures. Nothing was sent.`,
    )
  return { a, v, records }
}

function reminderKey(t: ReminderTarget): string {
  return `remind:${t.v.id}:${t.records
    .map((r) => r.id)
    .sort()
    .join(",")}`
}

/** Checked before the card is staged; pins the mail check over the reminded addresses. */
export async function agreementReminderSendPreflight(ctx: AgreementsCtx, p: ReminderParams) {
  const t = await reminderTarget(ctx, p)
  if (isError(t)) return { error: t.error }
  const at = new Date().toISOString()
  const sendGuard = {
    v: 1,
    applies: true,
    mode: "plain",
    since: at,
    stagedAt: at,
    addresses: t.records.map((r) => r.invited_email),
    contactIds: t.records.flatMap((r) => (r.contact_id ? [r.contact_id] : [])),
    refs: [],
    classification: "service",
  }
  return { ok: true, pinnedParams: { sendGuard, guardKey: reminderKey(t) } }
}

/**
 * `agreement_reminder_send`: each named signer whose link is still open gets a fresh link by
 * mail; the link mailed before stops working. Signers who answered, and one still waiting for
 * the signer before them, get nothing.
 */
export async function agreementReminderSend(ctx: AgreementsCtx, p: ReminderParams) {
  const t = await reminderTarget(ctx, p)
  if (isError(t)) return t
  const { a, v, records } = t
  const parked = await parkUnlessDecided(
    ctx,
    "agreement_reminder_send",
    `Remind the signers of ${a.number}`,
    [
      `Agreement: ${a.number} "${a.title}", version ${v.number}`,
      ...records.map((r) => `Signer: ${r.invited_name} <${r.invited_email}>`),
    ],
    p,
  )
  if (parked) return parked
  if (ctx.approval || p.sendGuard !== undefined || p.guardKey !== undefined) {
    if (!p.sendGuard || p.guardKey !== reminderKey(t))
      return refusal(
        "SEND_GUARD_MISMATCH",
        `The reminder for ${a.number} no longer matches the card that was approved. Nothing was sent.`,
      )
  }
  const out = bridgeAnswer<{
    status: string
    reminded?: Array<{ id: string; invited_name: string }>
    error?: { code: string; message: string }
  }>(
    await (ctx.client_actions_mint as (x: unknown) => Promise<unknown>)({
      remind: {
        ids: records.map((r) => r.id),
        ...(p.sendGuard ? { send_guard: p.sendGuard } : {}),
      },
    }),
  )
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "REMIND_FAILED",
      `No reminder for ${a.number}: ${out.error?.message ?? "nothing was mailed"}`,
    )
  const names = (out.reminded ?? []).map((r) => r.invited_name)
  return {
    status: "ok",
    agreement: { id: a.id, number: a.number, status: a.status },
    reminded: out.reminded ?? [],
    message:
      names.length === 0
        ? `${a.number} version ${v.number}: none of these signers has an open link to remind (each answered, waits for their turn, or signs in their own session). Nothing was mailed.`
        : `${a.number} version ${v.number}: a fresh link went to ${names.join(", ")}; the links mailed before stop working. Nothing else was sent.`,
  }
}

/** The link a new one replaces, its version and agreement, with every refusal of the tool. */
async function newLinkTarget(
  ctx: AgreementsCtx,
  p: { client_action_id: string; email?: string; expires_in_days?: number },
): Promise<{ rec: ActionRecord; version: Version; a: Agreement; expires: number } | ErrorEnvelope> {
  if (!ctx.client_actions_record || !ctx.client_actions_mint)
    return refusal(
      "LINKS_NOT_AVAILABLE",
      "This server cannot make signing links. Nothing was sent.",
    )
  const rec = bridgeAnswer<{ status: string; record?: ActionRecord }>(
    await ctx.client_actions_record({ id: String(p?.client_action_id ?? "") }),
  ).record
  const version = rec?.target_id
    ? ((await ctx.db.findOne("agreement_versions", rec.target_id)) as Version | null)
    : null
  const a = version
    ? ((await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null)
    : null
  if (!rec || !version || !a)
    return refusal(
      "NOT_FOUND",
      `No signing link ${p?.client_action_id} on an agreement you can see. Nothing was sent.`,
    )
  if (![...WAITING, "declined"].includes(a.status))
    return refusal(
      "NOT_SENT",
      `${a.number} is ${a.status}: a new link goes only for a document waiting for signatures, or declined without the emailed code. Nothing was sent.`,
    )
  if (rec.decision !== null && rec.decision !== "declined")
    return refusal(
      "ALREADY_DECIDED",
      `${rec.invited_name} already answered on ${a.number} (${rec.decision}). Nothing was sent.`,
    )
  if (rec.decision === "declined" && rec.code_verified_at)
    return refusal(
      "DECLINED_BY_SIGNER",
      `${rec.invited_name} declined ${a.number} after proving the emailed code: a new version is sent for a new answer. Nothing was sent.`,
    )
  const expires = p.expires_in_days ?? 14
  if (!(EXPIRY_CHOICES as readonly number[]).includes(expires))
    return refusal("INVALID_EXPIRY", "A link lasts 7, 14 or 30 days. Nothing was sent.")
  return { rec, version, a, expires }
}

/** Checked before the card is staged: the refusals the new link has when it is approved. */
export async function agreementNewLinkPreflight(
  ctx: AgreementsCtx,
  p: { client_action_id: string; email?: string; expires_in_days?: number },
) {
  const t = await newLinkTarget(ctx, p)
  return isError(t) ? { error: t.error } : { ok: true }
}

/**
 * `agreement_new_link`: one signer gets a new link, at the same or a corrected address, in the
 * same turn of the same send: after their link expired or was withdrawn, or after a decline
 * made without the emailed code. Signatures already given stand.
 */
export async function agreementNewLink(
  ctx: AgreementsCtx,
  p: { client_action_id: string; email?: string; expires_in_days?: number },
) {
  const t = await newLinkTarget(ctx, p)
  if (isError(t)) return t
  const { rec, version, a, expires } = t
  const parked = await parkUnlessDecided(
    ctx,
    "agreement_new_link",
    `A new signing link for ${rec.invited_name} on ${a.number}`,
    [
      `Agreement: ${a.number} "${a.title}", version ${version.number}`,
      `Signer: ${rec.invited_name} <${p.email ?? rec.invited_email}>`,
    ],
    p,
  )
  if (parked) return parked
  const out = bridgeAnswer<{
    status: string
    replaced_id?: string
    action?: { id: string; status: string; invited_name: string; invited_email: string }
    error?: { code: string; message: string }
  }>(
    await (ctx.client_actions_mint as (x: unknown) => Promise<unknown>)({
      new_link: { after: rec.id, email: p.email ?? null, expires_in_days: expires },
    }),
  )
  if (out.status !== "ok" || !out.action)
    return refusal(
      out.error?.code ?? "NEW_LINK_FAILED",
      `No new link for ${rec.invited_name} on ${a.number}: ${out.error?.message ?? "nothing was sent"}`,
    )
  let status = a.status
  if (a.status === "declined") {
    const signed = await ctx.db.findMany("signature_events", {
      where: { version_id: version.id },
      limit: 1,
    })
    status = signed.length > 0 ? "partly_signed" : "sent"
    await ctx.db.update("agreements", a.id, { status })
  }
  return {
    status: "ok",
    agreement: { id: a.id, number: a.number, status },
    client_action: { id: out.action.id, replaces: out.replaced_id ?? rec.id },
    message: `${a.number} version ${version.number}: a new link went to ${out.action.invited_name} <${out.action.invited_email}>, valid ${expires} days; their earlier link no longer works and signatures already given stand. Nothing else was sent.`,
  }
}

export interface SigningLink {
  id: string
  invited_name: string
  invited_email: string
  sign_order: number | null
  state: string
  decided_at: string | null
  code_verified: boolean
  expires_at: string
  /** A later link of the same signer replaced this one. */
  replaced?: boolean
  /** The member who signs with this link (a staff signer), else null. */
  signer_user_id?: string | null
}

/** The signing links of one version, as the kernel lists them (no token, code or device). */
export async function linksOf(ctx: AgreementsCtx, versionId: string): Promise<SigningLink[]> {
  if (!ctx.client_actions_record) return []
  const out = bridgeAnswer<{ status: string; links?: SigningLink[] }>(
    await (ctx.client_actions_record as (x: unknown) => Promise<unknown>)({
      target_type: TARGET_TYPE,
      target_id: versionId,
    }),
  )
  return out.links ?? []
}

/**
 * Job `decided-reconcile` (every 10 minutes): a decision whose event this app never handled
 * (a lost delivery) is handled now. For each agreement waiting for signatures, every decided
 * link of its latest version without a signature event, and a decline the agreement does not
 * show yet, goes through the same handler as the event, so nothing is written twice.
 */
export async function decidedReconcile(ctx: AgreementsCtx) {
  const waiting = (await ctx.db.findMany("agreements", {
    where: { status: { in: WAITING } },
    limit: 500,
  })) as Agreement[]
  let handled = 0
  for (const a of waiting) {
    const v = await latestOf(ctx, a.id)
    if (!v) continue
    for (const l of await linksOf(ctx, v.id)) {
      if (l.replaced === true) continue
      if (l.state !== "decided" && l.state !== "declined") continue
      if (l.state === "decided") {
        const seen = await ctx.db.findMany("signature_events", {
          where: { client_action_id: l.id },
          limit: 1,
        })
        if (seen.length > 0) continue
      }
      await onClientActionDecided(ctx, {
        data: { id: l.id, target: { app: "agreements", type: TARGET_TYPE, id: v.id } },
      })
      handled += 1
      if (l.state === "declined") break
    }
  }
  // A version marked signed (or accepted) with fewer events than its signers, and not sealed:
  // the missing events are written from their records, and the seal tried again.
  const marked = (await ctx.db.findMany("agreements", {
    where: { status: { in: ["signed", "accepted"] } },
    limit: 500,
  })) as Agreement[]
  let repaired = 0
  for (const a of marked) {
    const v = await latestOf(ctx, a.id)
    if (!v || v.status !== "signed") continue
    const sealed = await ctx.db.findMany("evidence_packages", {
      where: { version_id: v.id },
      limit: 1,
    })
    if (sealed.length > 0) continue
    const live = (await linksOf(ctx, v.id)).filter((l) => l.replaced !== true)
    const events = await eventsOf(ctx, v.id)
    if (events.some((e) => e.level === "demo")) continue
    const have = new Set(events.map((e) => e.client_action_id))
    if (live.every((l) => have.has(l.id))) continue
    await recordEverySigner(
      ctx,
      a,
      v,
      live.map((l) => ({ id: l.id, sign_order: l.sign_order, decision: null, open: false })),
    )
    await sealVersion(ctx as SealCtx, v.id)
    repaired += 1
  }
  return { status: "ok", checked: waiting.length, handled, repaired }
}
