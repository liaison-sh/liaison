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
import { type AgreementSource, inDocumentLanguage, priceInSource, UNFIT_TAGS } from "./checks"
import { type AgreementsCtx, actingAgentId, bridgeAnswer, type ErrorEnvelope, refusal } from "./ctx"
import { type CopyState, copyStateOf, eventsOf, type SealCtx, sealVersion } from "./seal"
import { backToDraft, markSent, standing, stillSending, wholeSend } from "./sent-state"

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
  parent_agreement_id?: string | null
  language?: string | null
  org_access?: string | null
  price_minor?: string | number | null
  currency?: string | null
  /** The version whose unfinished send its people were told of. */
  send_told_version_id?: string | null
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
  frozen_at?: string | null
  source_kind?: string | null
  pages?: Array<{ n: number; picture_file_id: string; sha256: string; text: string }> | null
  pages_sha256?: string | null
  scan_state?: string | null
  copy_differs_at?: string | null
  /** The links whose answer is a signature event, for people who may not read the evidence. */
  answers_recorded?: string[] | null
}

/** What says which version it is and where it stands: never its text, source or pages. */
const VERSION_STATE = [
  "id",
  "agreement_id",
  "number",
  "status",
  "sha256",
  "frozen_at",
  "source_kind",
  "copy_differs_at",
  "answers_recorded",
]

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
  /** The document as the card names it. */
  document?: SendDocument
  /**
   * On a version already sent: the signing link of the withdrawn signer the one signer named
   * here signs in place of, in the same turn.
   */
  replaces?: string
  /** Who that is, as the card says it; pinned like the document. */
  replaced?: ReplacedOnCard
}

/** Whose place it is, and what that place asks. */
export interface ReplacedOnCard {
  name: string
  email: string
  mode: "sign" | "accept"
  phrase: string | null
}

/** What a card that sends a document says it is. */
export interface SendDocument {
  number: string
  title: string
  version: number
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

/** An agreement's newest version, its state only (no text, source or pages). */
export async function latestOf(ctx: AgreementsCtx, agreementId: string): Promise<Version | null> {
  const [newest] = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: agreementId },
    orderBy: { number: "desc" },
    limit: 1,
    select: VERSION_STATE,
  })) as Version[]
  return newest ?? null
}

/** Normalised for the "same person twice" test: trim, lower case. */
const keyOf = (email: string) => email.trim().toLowerCase()

/** Who a signer without a contact is: the address and the name typed with it. */
const personKey = (email: string, name: string) => `${keyOf(email)}|${name.trim().toLowerCase()}`

/**
 * The signers as the send will mint them: a contact's email read from the
 * directory, the same contact or the same name at the same address twice kept
 * once, two people on one address kept as two signers (the card says so), a
 * contact with no email refused by name.
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
    const name = String(s.name ?? "").trim() || email
    const same = personKey(email, name)
    if (out.some((o) => o.contact_id === null && personKey(o.email, o.name) === same)) continue
    out.push({ contact_id: null, email: keyOf(email), name })
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
  /** The withdrawn signer the one signer of this send takes the place of. */
  replaced: SigningLink | null
  /** What that place asks: the kernel gives the new link the withdrawn one's kind and phrase. */
  asked: { mode: "sign" | "accept"; phrase: string | null } | null
}

/** A link its holder can answer, now or when their turn comes. */
const ANSWERABLE = ["open", "waiting_turn", "locked"]

/** A place its holder has not answered, whether or not their link ran out. */
const HELD = [...ANSWERABLE, "expired"]

/**
 * A send on the version already sent that puts another person in a withdrawn signer's place: the
 * withdrawn signer's link, or why not.
 */
async function withdrawnSigner(
  ctx: AgreementsCtx,
  agreement: Agreement,
  version: Version,
  p: SendParams,
  signers: readonly Resolved[],
): Promise<SigningLink | ErrorEnvelope> {
  const links = await linksOf(ctx, version.id)
  const link = links.find((l) => l.id === p.replaces)
  if (!WAITING.includes(agreement.status) || !link)
    return refusal(
      "NOT_FOUND",
      `${agreement.number} version ${version.number} has no signer with the link ${String(p.replaces)} to replace: agreement_get lists its links. Nothing was sent.`,
    )
  if (link.state !== "revoked")
    return refusal(
      "SIGNER_NOT_WITHDRAWN",
      `${link.invited_name} was not withdrawn from ${agreement.number} (their link is ${link.state}): withdraw it first (client_action_revoke), then send again in their place. Nothing was sent.`,
    )
  const [who] = signers
  if (signers.length !== 1 || !who)
    return refusal(
      "ONE_SIGNER_IN_PLACE",
      `One person signs in place of ${link.invited_name}: name exactly one signer. Nothing was sent.`,
    )
  // Already replaced: by the same person (asked again) the kernel answers their link, else it refuses.
  if (link.replaced === true) return link
  const holds = links.find(
    (l) => l.replaced !== true && HELD.includes(l.state) && keyOf(l.invited_email) === who.email,
  )
  if (holds)
    return refusal(
      "HOLDS_A_LINK",
      `${holds.invited_name} already holds a signing link of ${agreement.number} at ${who.email}: nobody signs on two. Nothing was sent.`,
    )
  return link
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
  // Sent on the strength of an earlier version's links, and none was ever made on this one (it
  // was prepared while that send ran): it can be sent.
  const neverSent =
    WAITING.includes(agreement.status) &&
    ctx.client_actions_record !== undefined &&
    (await linksOf(ctx, version.id)).length === 0
  const inPlace = typeof p.replaces === "string"
  if (WAITING.includes(agreement.status) && !neverSent && !inPlace)
    return refusal(
      "ALREADY_SENT",
      `${agreement.number} version ${version.number} was already sent: its signing links were made, and nothing was sent again now. agreement_get lists them and where each stands. To put someone in a withdrawn signer's place, name that signer's link in replaces. A new version is sent after a save and a freeze.`,
    )
  if (agreement.status !== "draft" && !neverSent && !inPlace)
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
  const replaced = inPlace ? await withdrawnSigner(ctx, agreement, version, p, r.signers) : null
  if (isError(replaced)) return replaced
  const asked = replaced ? await askedOf(ctx, replaced.id) : null
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
    replaced,
    asked,
  }
}

/** What a link asks of its signer, as the kernel holds it. */
async function askedOf(
  ctx: AgreementsCtx,
  id: string,
): Promise<{ mode: "sign" | "accept"; phrase: string | null }> {
  const rec = ctx.client_actions_record
    ? bridgeAnswer<{ record?: Pick<ActionRecord, "kind" | "required_phrase"> }>(
        await ctx.client_actions_record({ id }),
      ).record
    : undefined
  return {
    mode: rec?.kind === "accept" ? "accept" : "sign",
    phrase: rec?.required_phrase ?? null,
  }
}

function cardLines(ready: Ready, p: SendParams): string[] {
  const mode = ready.asked?.mode ?? ready.mode
  const phrase = ready.asked ? ready.asked.phrase : p.required_phrase
  const what = mode === "sign" ? "a simple electronic signature" : "an acceptance"
  const lines = [
    `Agreement: ${ready.agreement.number} "${ready.agreement.title}", version ${ready.version.number}`,
    `Fingerprint: ${String(ready.version.sha256)}`,
    ready.replaced
      ? `In place of: ${ready.replaced.invited_name} <${ready.replaced.invited_email}> (withdrawn), in the same turn. Asks: ${what}`
      : `Asks: ${what}, ${ready.order === "sequential" ? "one after the other" : "in any order"}`,
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
  if (phrase) lines.push(`Each signer types: "${phrase}"`)
  if (p.message) lines.push(`Message: ${p.message}`)
  return lines
}

interface MintAnswer {
  status: string
  error?: { code: string; message: string }
  group_id?: string
  /** The same send had made these links before: nothing was made or mailed now. */
  already_sent?: boolean
  actions?: Array<{
    id: string
    status: string
    sign_order: number | null
    invited_name: string
    signer_is_staff: boolean
    mail_queued: boolean
    /** Where its mail is: `owed` leaves later, `failed` left no link that opens. */
    mail?: "owed" | "sent" | "failed" | null
  }>
}

/**
 * One send's key: the version, its fingerprint and every signer's address, with the names of
 * those who share one.
 */
export function sendGuardKey(
  ready: Pick<Ready, "version" | "signers"> & { replaced?: { id: string } | null },
): string {
  const shared = (email: string) => ready.signers.filter((x) => x.email === email).length > 1
  const signers = [
    ...new Set(ready.signers.map((x) => (shared(x.email) ? personKey(x.email, x.name) : x.email))),
  ].sort()
  const inPlace = ready.replaced ? `:in-place-of:${ready.replaced.id}` : ""
  return `${ready.version.id}:${String(ready.version.sha256)}:${signers.join(",")}${inPlace}`
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
  | {
      ok: true
      pinnedParams: {
        sendGuard: Record<string, unknown>
        guardKey: string
        document: SendDocument
        replaced?: ReplacedOnCard
      }
    }
  | { error: { code: string; message: string } }
> {
  const ready = await readyToSend(ctx, p)
  if (isError(ready)) return { error: ready.error }
  return {
    ok: true,
    pinnedParams: {
      sendGuard: sendGuardOf(ready),
      guardKey: sendGuardKey(ready),
      document: {
        number: ready.agreement.number,
        title: ready.agreement.title,
        version: ready.version.number,
      },
      ...(ready.replaced && ready.asked
        ? {
            replaced: {
              name: ready.replaced.invited_name,
              email: ready.replaced.invited_email,
              ...ready.asked,
            },
          }
        : {}),
    },
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
  if (ready.replaced) return sendInPlace(ctx, ready, ready.replaced, p)
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
  const { agreement, version } = ready
  if (out.status !== "ok" && out.error?.code === "ALREADY_SENT") {
    // Links of an earlier send stand on this version: a whole one went out, whatever its state
    // said. One that may have stopped half way is never taken for sent.
    const cut = await interruptedSend(ctx, agreement)
    if (cut && !cut.whole)
      return refusal(
        "ALREADY_SENT",
        `${agreement.number} version ${version.number}: ${out.error.message} ${unfinishedWords(cut)} It stays a draft: void it or save a new version, then send it to everyone.`,
      )
    if (cut) await markSent(ctx, agreement, version)
    return refusal(
      "ALREADY_SENT",
      `${agreement.number} version ${version.number}: ${out.error.message} To ask other signers, void it or save a new version first.`,
    )
  }
  if (out.status !== "ok" && out.error?.code === "SEND_NOT_CONFIRMED")
    return refusal("SEND_NOT_CONFIRMED", `${agreement.number}: ${out.error.message}`)
  if (out.status !== "ok")
    return refusal(
      out.error?.code ?? "SEND_FAILED",
      `${agreement.number} was not sent: ${out.error?.message ?? "no link was made"}`,
    )
  // A newer version was prepared while the links were made: they are of a document nobody sends
  // any more, so they are withdrawn and nothing is called sent.
  const newest = await latestOf(ctx, agreement.id)
  if (newest && newest.id !== version.id) {
    await ctx.client_actions_revoke?.({
      target_type: TARGET_TYPE,
      target_id: version.id,
      reason: "replaced",
    })
    return refusal(
      "VERSION_CHANGED",
      `${agreement.number} version ${newest.number} was prepared while version ${version.number} was being sent: the links of version ${version.number} were withdrawn, so a signer who got one can no longer open it. Next: send version ${newest.number}.`,
    )
  }
  // The links are out from here on. Its state is written now, and again by the kernel's word
  // of the links (`onLinksMade`) when this run is cut off or the write fails.
  let late = false
  try {
    await markSent(ctx, agreement, version)
  } catch {
    late = true
  }
  const actions = out.actions ?? []
  const first = actions.filter((a) => a.status === "open")
  const waiting = actions.filter((a) => a.status === "waiting_turn")
  const staff = actions.filter((a) => a.signer_is_staff && a.status === "open")
  const client_actions = actions.map((a) => ({
    id: a.id,
    signer: a.invited_name,
    sign_order: a.sign_order,
    state: a.status,
    signs_in_session: a.signer_is_staff,
  }))
  const lateNote = late ? " It still reads as a draft: its state follows in a few minutes." : ""
  if (out.already_sent) {
    const now = (await ctx.db.findOne("agreements", agreement.id)) as Agreement | null
    return {
      status: "ok",
      already_sent: true,
      agreement: {
        id: agreement.id,
        number: agreement.number,
        status: late ? "draft" : (now?.status ?? "sent"),
      },
      version: { id: version.id, number: version.number },
      client_actions,
      message: `${agreement.number} version ${version.number} had already been sent to ${actions.map((a) => a.invited_name).join(", ")}: their links stand, and nothing was made or mailed again.${mailNote(actions)}${lateNote}`,
    }
  }
  return {
    status: "ok",
    agreement: { id: agreement.id, number: agreement.number, status: late ? "draft" : "sent" },
    version: { id: version.id, number: version.number },
    client_actions,
    message: `${agreement.number} version ${version.number} was sent: ${first.map((a) => a.invited_name).join(", ")} can ${ready.mode} now${staff.length ? ` (${staff.map((a) => a.invited_name).join(", ")} in their own session, no mailed link)` : ""}${waiting.length ? `; ${waiting.map((a) => a.invited_name).join(", ")} ${waiting.length === 1 ? "gets" : "get"} a link only after the signer before them` : ""}. Nothing else was sent.${lateNote}`,
  }
}

/**
 * A void or a newer version while a link was being made: that link is withdrawn with the others,
 * and nothing is called sent. The kernel's word of the link (`onLinksMade`) and the word of the void
 * or the save (`onAgreementClosed`) do the same when this run is cut off here.
 */
async function closedMeanwhile(
  ctx: AgreementsCtx,
  agreement: Agreement,
  version: Version,
): Promise<ErrorEnvelope | null> {
  const now = (await ctx.db.findOne("agreements", agreement.id)) as Agreement | null
  const latest = await latestOf(ctx, agreement.id)
  const voided = !!now && CLOSED.includes(now.status)
  const replaced = !!latest && (latest.id !== version.id || latest.status === "superseded")
  if (!voided && !replaced) return null
  await ctx.client_actions_revoke?.({
    target_type: TARGET_TYPE,
    target_id: version.id,
    reason: voided ? "sender_voided" : "replaced",
  })
  return voided
    ? refusal(
        "NOT_SENT",
        `${agreement.number} was voided while this link was being made: the link was withdrawn, so a signer who got it can no longer open it.`,
      )
    : refusal(
        "VERSION_CHANGED",
        `${agreement.number} version ${version.number} was replaced while this link was being made: the link was withdrawn, so a signer who got it can no longer open it. Next: send the new version.`,
      )
}

/** The approved send of one person in a withdrawn signer's place, on the version already out. */
async function sendInPlace(ctx: AgreementsCtx, ready: Ready, replaced: SigningLink, p: SendParams) {
  const { agreement, version } = ready
  const out = bridgeAnswer<{
    status: string
    error?: { code: string; message: string }
    action?: {
      id: string
      status: string
      invited_name: string
      invited_email: string
      signer_is_staff?: boolean
      deduped?: boolean
    }
  }>(
    await (ctx.client_actions_mint as (x: unknown) => Promise<unknown>)({
      replace_signer: {
        after: replaced.id,
        signer: ready.signers[0],
        company_id: agreement.company_id ?? null,
        expires_in_days: ready.expires,
        message: p.message ?? null,
        ...(p.sendGuard ? { send_guard: p.sendGuard } : {}),
      },
    }),
  )
  if (out.status !== "ok" || !out.action)
    return refusal(
      out.error?.code ?? "SEND_FAILED",
      `${agreement.number} version ${version.number}: ${out.error?.message ?? "no link was made"}`,
    )
  const closed = await closedMeanwhile(ctx, agreement, version)
  if (closed) return closed
  const who = out.action.invited_name
  const how = out.action.deduped
    ? "already signs in their place: nothing was made or mailed again"
    : out.action.status === "waiting_turn"
      ? "signs in their place: their link is mailed after the signer before them signs"
      : out.action.signer_is_staff
        ? "signs in their place now, in their own session, no mailed link"
        : `signs in their place: a link went to ${out.action.invited_email}`
  return {
    status: "ok",
    agreement: { id: agreement.id, number: agreement.number, status: agreement.status },
    version: { id: version.id, number: version.number },
    client_actions: [
      {
        id: out.action.id,
        signer: who,
        sign_order: replaced.sign_order,
        state: out.action.status,
        replaces: replaced.id,
      },
    ],
    message: `${agreement.number} version ${version.number}: ${replaced.invited_name} was withdrawn, and ${who} ${how}. Signatures already given stand. Nothing else was sent.`,
  }
}

/** What a send asked again says of the mails that did not go. */
function mailNote(actions: NonNullable<MintAnswer["actions"]>): string {
  const named = (mail: string) =>
    actions
      .filter((a) => a.mail === mail)
      .map((a) => a.invited_name)
      .join(", ")
  const failed = named("failed")
  const owed = named("owed")
  return `${failed ? ` The mail to ${failed} failed, so nobody holds that link: agreement_reminder_send mails a new one.` : ""}${owed ? ` The mail to ${owed} has not left yet: it goes in the next minutes.` : ""}`
}

/** A draft whose latest frozen version went out: its links stand, its state was never written. */
export interface InterruptedSend {
  version: Version
  links: SigningLink[]
  /**
   * The links are one whole send and the draft still reads as what went out: it is taken for
   * sent by itself. Otherwise a person decides.
   */
  whole: boolean
  /** The draft was changed after it went out. */
  edited: boolean
}

/** One JSON value as text that does not depend on its keys' order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`
  return JSON.stringify(v ?? null)
}

/** Whether the draft no longer reads as a version frozen from it. */
async function editedSince(ctx: AgreementsCtx, agreementId: string, v: Version): Promise<boolean> {
  const [draft] = (await ctx.db.findMany("agreement_drafts", {
    where: { agreement_id: agreementId },
    limit: 1,
  })) as Array<{ source?: AgreementSource | null; upload_file_id?: string | null }>
  if (!draft) return false
  if (draft.upload_file_id) return true
  if (v.source_kind === "uploaded") {
    const blocks = draft.source?.body?.blocks
    return Array.isArray(blocks) && blocks.length > 0
  }
  const row = (await ctx.db.findOne("agreements", agreementId)) as Agreement | null
  const frozen = (await ctx.db.findOne("agreement_versions", v.id)) as Version | null
  if (!row || !frozen || !draft.source) return false
  return (
    canonical(inDocumentLanguage(row, priceInSource(row, draft.source))) !==
    canonical(frozen.source)
  )
}

/**
 * The interrupted send of a draft, or null. Read only. A voided, declined or replaced
 * agreement is never one, nor is a version that is no longer the latest.
 */
export async function interruptedSend(
  ctx: AgreementsCtx,
  a: { id: string; status: string },
): Promise<InterruptedSend | null> {
  if (a.status !== "draft") return null
  const version = await latestOf(ctx, a.id)
  if (version?.status !== "frozen" || !version.sha256) return null
  const links = standing(await linksOf(ctx, version.id))
  if (links.length === 0) return null
  const edited = await editedSince(ctx, a.id, version)
  return { version, links, edited, whole: wholeSend(links) && !edited }
}

/** Why a draft with links that stand is not taken for sent, for the person who decides. */
export function unfinishedWords(cut: InterruptedSend): string {
  const names = cut.links.map((l) => l.invited_name).join(", ")
  return cut.edited
    ? `The draft changed after version ${cut.version.number} went out, so it is not taken for sent.`
    : `The send of version ${cut.version.number} may have stopped before every signer had a link (${names} ${cut.links.length === 1 ? "has" : "have"} one), so it is not taken for sent.`
}

/** The answers given on a version's links that the app has not recorded yet. */
async function unrecordedAnswers(
  ctx: AgreementsCtx,
  a: Agreement,
  version: Version,
  opts: { declines: boolean },
): Promise<SigningLink[]> {
  if (version.status !== "frozen") return []
  // The signature events are the evidence's: whoever saves or voids may not read them.
  const recorded = new Set(version.answers_recorded ?? [])
  const out: SigningLink[] = []
  for (const l of await linksOf(ctx, version.id)) {
    if (l.replaced === true) continue
    if (l.state === "declined" && opts.declines) out.push(l)
    if (l.state !== "decided" || recorded.has(l.id)) continue
    // An answer that will never be recorded (another kind of decision) holds nothing.
    const rec = ctx.client_actions_record
      ? bridgeAnswer<{ record?: ActionRecord }>(await ctx.client_actions_record({ id: l.id }))
          .record
      : undefined
    if (rec && !decisionFits(a.kind, rec.decision)) continue
    out.push(l)
  }
  return out
}

/**
 * An answer a send already holds and the app has not recorded: what would lose it (a save, a
 * void) waits until it is, whatever the agreement reads as. A cut send is marked sent so the job
 * records it. Only the system writes a signature, never a person's run.
 */
export async function answerBeingRecorded(
  ctx: AgreementsCtx,
  a: Agreement,
  cut: InterruptedSend | null,
): Promise<ErrorEnvelope | null> {
  const version = cut?.version ?? (WAITING.includes(a.status) ? await latestOf(ctx, a.id) : null)
  if (!version) return null
  const answered = await unrecordedAnswers(ctx, a, version, { declines: cut?.whole !== false })
  if (answered.length === 0) return null
  if (cut?.whole) await markSent(ctx, a, cut.version)
  return refusal(
    "ANSWER_BEING_RECORDED",
    `${a.number} version ${version.number} was sent and ${answered.map((l) => l.invited_name).join(", ")} answered: the answer is being recorded. Read it again in 10 minutes, then decide. Nothing was changed.`,
  )
}

/**
 * Withdraws the links of a version a newer one replaced while it was being sent. The answers
 * given on it are kept as they were given, on that version; an agreement that read as sent on the
 * strength of those links alone is a draft again, and its people are told. System runs only.
 */
async function withdrawReplaced(
  ctx: AgreementsCtx,
  a: Agreement,
  version: Version,
  latest: Version,
): Promise<void> {
  const links = standing(await linksOf(ctx, version.id))
  await recordEverySigner(
    ctx,
    a,
    version,
    links
      .filter((l) => l.state === "decided")
      .map((l) => ({ id: l.id, sign_order: l.sign_order, decision: null, open: false })),
  )
  await ctx.client_actions_revoke?.({
    target_type: TARGET_TYPE,
    target_id: version.id,
    reason: "replaced",
  })
  if (version.status === "frozen")
    await ctx.db.update("agreement_versions", version.id, { status: "superseded" })
  if (latest.id === version.id || (await linksOf(ctx, latest.id)).length > 0) return
  if (!(await backToDraft(ctx, a))) return
  await tellPeople(ctx, a, {
    version: version.number,
    why: `version ${latest.number} was prepared while version ${version.number} was being sent, so the links of version ${version.number} were withdrawn and it is a draft again. Send version ${latest.number}.`,
  })
}

/** One Home line to the people who look after an agreement whose send did not go as it reads. */
async function tellPeople(
  ctx: AgreementsCtx,
  a: Agreement,
  d: { version: number; why: string },
): Promise<void> {
  const row = (await ctx.db.findOne("agreements", a.id)) as {
    created_by_user_id?: string | null
    org_access?: string | null
  } | null
  const version = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: a.id, number: d.version },
    limit: 1,
    select: ["id", "frozen_by_user_id"],
  })) as Array<{ frozen_by_user_id?: string | null }>
  // Of a restricted agreement, only who is on its list is told.
  const list =
    row?.org_access === "none" ? (await currentShares(ctx, a.id)).map((s) => s.user_id) : null
  const people = [row?.created_by_user_id, version[0]?.frozen_by_user_id].filter(
    (id): id is string => typeof id === "string" && (list === null || list.includes(id)),
  )
  await ctx.emit?.({
    entity: "agreement",
    action: "send_unfinished",
    entityId: a.id,
    data: { number: a.number, why: d.why, personIds: [...new Set(people)] },
  })
}

/**
 * `kernel/client_action:links_made`: a send's links exist, told by the transaction that made
 * them. The agreement is marked sent when the run that asked was cut off before it could. Links
 * made on a version replaced meanwhile, or on an agreement voided meanwhile, are withdrawn. Told
 * again when a person sends again links that were already answered: those answers count then. A
 * change request's own run writes its state, after the reply it goes with.
 */
export async function onLinksMade(ctx: AgreementsCtx, event: DecidedEvent) {
  const t = event?.data?.target
  if (t?.app !== "agreements" || t.type !== TARGET_TYPE || !t.id) return { status: "ignored" }
  const version = (await ctx.db.findOne("agreement_versions", t.id)) as Version | null
  if (!version) return { status: "ignored" }
  const a = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
  if (!a) return { status: "ignored" }
  const latest = await latestOf(ctx, a.id)
  if (latest && (latest.id !== version.id || version.status === "superseded")) {
    await withdrawReplaced(ctx, a, version, latest)
    return { status: "replaced" }
  }
  if (CLOSED.includes(a.status)) {
    await ctx.client_actions_revoke?.({
      target_type: TARGET_TYPE,
      target_id: version.id,
      reason: "sender_voided",
    })
    return { status: "withdrawn" }
  }
  if (version.status !== "frozen") return { status: "ignored" }
  let status = "ignored"
  if (a.status === "draft" && a.kind !== CHANGE_REQUEST && (await markSent(ctx, a, version)))
    status = "sent"
  // Answers its links already hold (kept on a draft whose send was not taken for whole) count now.
  const now = status === "sent" ? { ...a, status } : a
  if (WAITING.includes(now.status)) await recordAnswers(ctx, now, version)
  return { status }
}

/** An agreement its sender closed: no link of it stays open. */
const CLOSED = ["voided", "withdrawn"]

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
      // The price frozen into this version, never the draft's current one.
      ...frozenPrice(v.source),
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

/** The price a version was frozen with (`agreement.price` of its source), as a summary row. */
function frozenPrice(source: unknown): Array<{ k: string; v: string }> {
  const price = (source as { data?: { agreement?: { price?: unknown } } } | null)?.data?.agreement
    ?.price
  return typeof price === "string" && price ? [{ k: "Price", v: price }] : []
}

/**
 * Each signer's copy state of a version, by client action id (the token page's last frame). The
 * page reads as its sender, who may not read the signature events: who signed is the kernel's word.
 */
async function copyStatesOf(
  ctx: AgreementsCtx,
  versionId: string,
): Promise<Record<string, CopyState>> {
  const signed = new Set((await eventsOf(ctx, versionId)).map((e) => e.client_action_id))
  for (const l of await linksOf(ctx, versionId)) if (l.state === "decided") signed.add(l.id)
  const out: Record<string, CopyState> = {}
  for (const id of signed) out[id] = await copyStateOf(ctx, versionId, id)
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
  kind?: string
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

/** Notes on the version which links' answers are recorded, so a save or a void sees it too. */
async function noteRecorded(
  ctx: AgreementsCtx,
  versionId: string,
  linkIds: readonly string[],
): Promise<void> {
  const v = (await ctx.db.findOne("agreement_versions", versionId)) as Version | null
  const had = v?.answers_recorded ?? []
  const missing = linkIds.filter((id) => !had.includes(id))
  if (!v || missing.length === 0) return
  await ctx.db.update("agreement_versions", versionId, { answers_recorded: [...had, ...missing] })
}

/** One signature event per client action: the decision as the kernel recorded it. */
async function writeSignatureEvent(
  ctx: AgreementsCtx,
  agreement: Agreement,
  version: Version,
  rec: ActionRecord,
): Promise<void> {
  await insertSignatureEvent(ctx, agreement, version, rec)
  await noteRecorded(ctx, version.id, [rec.id])
}

async function insertSignatureEvent(
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
  let agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
  if (!agreement) return { status: "ignored" }
  // A link a later one replaced counts for nothing: its signer answers on the new link. Nor does
  // one of another document.
  if (rec.replaced === true || (rec.target_id !== undefined && rec.target_id !== version.id))
    return { status: "ignored" }
  // An answer counts on the document it was given for, and only while that is the latest one.
  const latest = await latestOf(ctx, agreement.id)
  if (latest?.id !== version.id) return { status: "ignored" }
  // Someone answered a draft's link: its send went out and was cut off before its state was
  // written.
  if (agreement.status === "draft" && version.status === "frozen") {
    if (rec.target_sha256 !== version.sha256) return { status: "ignored" }
    const cut = await interruptedSend(ctx, agreement)
    if (!cut) return { status: "ignored" }
    if (!cut.whole) {
      // Perhaps half a send, or of a text the draft left behind: the signature is kept as it was
      // given, and completes nothing until a person sends the agreement.
      if (rec.decision === "declined" || !decisionFits(agreement.kind, rec.decision))
        return { status: "ignored" }
      await writeSignatureEvent(ctx, agreement, version, rec)
      return { status: "kept" }
    }
    await markSent(ctx, agreement, version)
    agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
    if (!agreement) return { status: "ignored" }
  }
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
  // declined or replaced agreement, whoever minted the link.
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
 * A document waiting for signatures (a draft whose send was cut off is one), or a signed one
 * whose signed copy read differently from the frozen file (nothing was sealed): voided so a
 * person sends it again from a clean file.
 */
async function voidable(ctx: AgreementsCtx, a: Agreement): Promise<boolean> {
  if (a.status === "sent" || a.status === "partly_signed") return true
  if (a.status === "draft") return (await interruptedSend(ctx, a)) !== null
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
  const recording = await answerBeingRecorded(ctx, a, await interruptedSend(ctx, a))
  if (recording) return recording
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
    recently_mailed?: Array<{ id: string; invited_name: string }>
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
  const recent = (out.recently_mailed ?? []).map((r) => r.invited_name)
  const recentNote =
    recent.length > 0
      ? ` ${recent.join(", ")} got a fresh link minutes ago: that link stands, and no second mail went to them.`
      : ""
  return {
    status: "ok",
    agreement: { id: a.id, number: a.number, status: a.status },
    reminded: out.reminded ?? [],
    ...(recent.length > 0 ? { recently_mailed: out.recently_mailed } : {}),
    message:
      names.length > 0
        ? `${a.number} version ${v.number}: a fresh link went to ${names.join(", ")}; the links mailed before stop working.${recentNote} Nothing else was sent.`
        : recent.length > 0
          ? `${a.number} version ${v.number}: nothing was mailed now.${recentNote}`
          : `${a.number} version ${v.number}: none of these signers has an open link to remind (each answered, waits for their turn, or signs in their own session). Nothing was mailed.`,
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
  const closed = await closedMeanwhile(ctx, a, version)
  if (closed) return closed
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
    message:
      out.action.status === "waiting_turn"
        ? `${a.number} version ${version.number}: ${out.action.invited_name} <${out.action.invited_email}> has their turn back; their link is mailed after the signer before them signs. Signatures already given stand. Nothing was sent.`
        : `${a.number} version ${version.number}: a new link went to ${out.action.invited_name} <${out.action.invited_email}>, valid ${expires} days; their earlier link no longer works and signatures already given stand. Nothing else was sent.`,
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
  /** How many signers the send that wrote it has; null for a link not written as part of one. */
  send_size?: number | null
  /** Where its mail is, while it can be answered. */
  mail?: "owed" | "sent" | "failed" | null
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

/** Runs one agreement's repair; its failure is the run's to report, never the others' to wait on. */
async function repairEach<T extends { id: string }>(
  rows: readonly T[],
  repair: (row: T) => Promise<number>,
): Promise<{ done: number; failed: number }> {
  let done = 0
  let failed = 0
  for (const row of rows) {
    try {
      done += await repair(row)
    } catch {
      failed += 1
    }
  }
  return { done, failed }
}

/** What the drafts among the newest frozen versions are, without any version's text. */
async function draftsWithAVersion(ctx: AgreementsCtx): Promise<Agreement[]> {
  const frozen = (await ctx.db.findMany("agreement_versions", {
    where: { status: "frozen" },
    orderBy: { frozen_at: "desc" },
    limit: 500,
    select: ["id", "agreement_id"],
  })) as Version[]
  const ids = [...new Set(frozen.map((v) => v.agreement_id))]
  if (ids.length === 0) return []
  return (await ctx.db.findMany("agreements", {
    where: { id: { in: ids }, status: "draft" },
    limit: 500,
  })) as Agreement[]
}

/** The versions of an agreement older than its latest, still frozen, whose links stand. */
async function withdrawOlderLinks(ctx: AgreementsCtx, a: Agreement): Promise<number> {
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { agreement_id: a.id },
    orderBy: { number: "desc" },
    limit: 500,
    select: VERSION_STATE,
  })) as Version[]
  const latest = versions[0]
  let withdrawn = 0
  for (const v of versions.slice(1)) {
    if (!latest || v.status !== "frozen" || !v.sha256) continue
    if (standing(await linksOf(ctx, v.id)).length === 0) continue
    await withdrawReplaced(ctx, a, v, latest)
    withdrawn += 1
  }
  return withdrawn
}

/**
 * A draft whose send was cut off: marked sent when the links are one whole send of what it still
 * reads; otherwise its people are told, once per version, and decide. Answers whether it was
 * marked.
 */
async function resumeInterruptedSend(ctx: AgreementsCtx, a: Agreement): Promise<boolean> {
  await withdrawOlderLinks(ctx, a)
  const cut = await interruptedSend(ctx, a)
  if (!cut || stillSending(a, cut.version)) return false
  if (cut.whole) {
    if (!(await markSent(ctx, a, cut.version))) return false
    // A change request goes with a reply to the client's mail: nobody knows whether it left.
    if (a.kind === CHANGE_REQUEST)
      await tellPeople(ctx, a, {
        version: cut.version.number,
        why: `its approval link went to ${cut.links.map((l) => l.invited_name).join(", ")}, but the send stopped before the reply it goes with was confirmed. Look at the conversation, and answer the client's mail if the reply is not there.`,
      })
    return true
  }
  await recordAnswers(ctx, a, cut.version)
  if (a.send_told_version_id === cut.version.id) return false
  await ctx.db.update("agreements", a.id, { send_told_version_id: cut.version.id })
  await tellPeople(ctx, a, {
    version: cut.version.number,
    why: `${unfinishedWords(cut)} Send it again to the same signers to say it is whole, save a change to replace it, or void it.`,
  })
  return false
}

/**
 * The recorded answer to go over again when a version's links say more than its agreement does:
 * an answer kept before it was sent, or a handler stopped after it wrote the signature. Null when
 * the two agree. Its handler writes nothing twice.
 */
function answerToReplay(links: readonly SigningLink[], status: string): string | null {
  const live = links.filter((l) => l.replaced !== true)
  const decided = live.filter((l) => l.state === "decided")
  const last = decided.at(-1)
  if (!last || live.some((l) => l.state === "declined")) return null
  if (status === "sent" || decided.length === live.length) return last.id
  // A turn that should have opened: everyone before a waiting signer signed.
  const waits = live.find((l) => l.state === "waiting_turn" && l.sign_order !== null)
  const before = live.filter(
    (l) => l.sign_order !== null && l.sign_order < Number(waits?.sign_order ?? 0),
  )
  if (!waits || before.length === 0 || before.some((l) => l.state !== "decided")) return null
  return before.at(-1)?.id ?? null
}

/**
 * Every answer of a version's links the app has not handled, through the event's own handler, and
 * then one it recorded when the agreement never moved on with it.
 */
async function recordAnswers(ctx: AgreementsCtx, a: Agreement, v: Version): Promise<number> {
  let handled = 0
  const recorded: string[] = []
  const links = await linksOf(ctx, v.id)
  const decided = (id: string) =>
    onClientActionDecided(ctx, {
      data: { id, target: { app: "agreements", type: TARGET_TYPE, id: v.id } },
    })
  for (const l of links) {
    if (l.replaced === true) continue
    if (l.state !== "decided" && l.state !== "declined") continue
    if (l.state === "decided") {
      const seen = await ctx.db.findMany("signature_events", {
        where: { client_action_id: l.id },
        limit: 1,
      })
      if (seen.length > 0) {
        recorded.push(l.id)
        continue
      }
    } else if (a.status === "draft") continue
    await decided(l.id)
    handled += 1
    if (l.state === "declined") break
  }
  if (handled === 0 && recorded.length > 0) {
    const now = (await ctx.db.findOne("agreements", a.id)) as Agreement | null
    const again = now && WAITING.includes(now.status) ? answerToReplay(links, now.status) : null
    if (again && recorded.includes(again) && (await decided(again)).status !== "ignored")
      handled += 1
  }
  // Recorded by an earlier release, or by a run stopped before it noted it.
  if (recorded.some((id) => !(v.answers_recorded ?? []).includes(id)))
    await noteRecorded(ctx, v.id, recorded)
  return handled
}

/**
 * `agreement:voided` and `agreement:updated`, heard once the void or the save is committed: a link
 * written beside it was neither there to withdraw nor, when the kernel told of it, on a document
 * that read as closed yet. It is withdrawn now.
 */
export async function onAgreementClosed(ctx: AgreementsCtx, event: { entityId?: string }) {
  const id = event?.entityId
  const a = id ? ((await ctx.db.findOne("agreements", id)) as Agreement | null) : null
  const v = a ? await latestOf(ctx, a.id) : null
  if (!a || !v) return { status: "ignored" }
  const voided = CLOSED.includes(a.status)
  if (!voided && v.status !== "superseded") return { status: "ignored" }
  if (!(await linksOf(ctx, v.id)).some((l) => ANSWERABLE.includes(l.state)))
    return { status: "ignored" }
  await ctx.client_actions_revoke?.({
    target_type: TARGET_TYPE,
    target_id: v.id,
    reason: voided ? "sender_voided" : "replaced",
  })
  return { status: "withdrawn" }
}

/**
 * Job `decided-reconcile` (every 10 minutes). A decision whose event this app never handled (a
 * lost delivery) is handled now: for each agreement waiting for signatures, every decided link of
 * its latest version without a signature event, and a decline the agreement does not show yet,
 * goes through the same handler as the event, so nothing is written twice; so does one recorded
 * whose agreement never moved on with it. Then the sends cut off before their agreement left draft.
 * One agreement that cannot be repaired stops no other.
 */
export async function decidedReconcile(ctx: AgreementsCtx) {
  const recordWaiting = async (a: Agreement): Promise<number> => {
    await withdrawOlderLinks(ctx, a)
    const v = await latestOf(ctx, a.id)
    return v ? recordAnswers(ctx, a, v) : 0
  }
  const waiting = (await ctx.db.findMany("agreements", {
    where: { status: { in: WAITING } },
    limit: 500,
  })) as Agreement[]
  const recorded = await repairEach(waiting, recordWaiting)
  let late = 0
  const resumed = await repairEach(await draftsWithAVersion(ctx), async (a) => {
    if (!(await resumeInterruptedSend(ctx, a))) return 0
    late += await recordWaiting({ ...a, status: "sent" })
    return 1
  })
  // A version marked signed (or accepted) with fewer events than its signers, and not sealed:
  // the missing events are written from their records, and the seal tried again.
  const marked = (await ctx.db.findMany("agreements", {
    where: { status: { in: ["signed", "accepted"] } },
    limit: 500,
  })) as Agreement[]
  const repaired = await repairEach(marked, async (a) => {
    const v = await latestOf(ctx, a.id)
    if (v?.status !== "signed") return 0
    const sealed = await ctx.db.findMany("evidence_packages", {
      where: { version_id: v.id },
      limit: 1,
    })
    if (sealed.length > 0) return 0
    const live = (await linksOf(ctx, v.id)).filter((l) => l.replaced !== true)
    const events = await eventsOf(ctx, v.id)
    if (events.some((e) => e.level === "demo")) return 0
    const have = new Set(events.map((e) => e.client_action_id))
    if (live.every((l) => have.has(l.id))) return 0
    await recordEverySigner(
      ctx,
      a,
      v,
      live.map((l) => ({ id: l.id, sign_order: l.sign_order, decision: null, open: false })),
    )
    await sealVersion(ctx as SealCtx, v.id)
    return 1
  })
  const failed = recorded.failed + resumed.failed + repaired.failed
  return {
    status: "ok",
    checked: waiting.length,
    resumed: resumed.done,
    handled: recorded.done + late,
    repaired: repaired.done,
    ...(failed > 0 ? { failed } : {}),
  }
}
