// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What happens once every signer has signed: the signed PDF (the frozen file
// with signature pages after it), the trail, the manifest and the seal, the
// outside timestamp, the evidence file and each signer's copy, mailed to each
// signer. Then `agreements/agreement:signed`, once.
//
// Every step can be run again: a step already done is read back, never redone,
// and the write-once columns of a package are filled once. The jobs below
// finish what a failure left: `seal-retry` (no package yet), `timestamp-retry`
// (the authority was down; also resends copies that failed) and
// `evidence-verify` (weekly re-hash, never a repair).

import { type AgreementsCtx, bridgeAnswer, type ErrorEnvelope, refusal } from "./ctx"

/** Copies give up and raise one attention item after this many failed sends. */
export const COPY_MAX_ATTEMPTS = 3
/** Evidence is kept at least this long from the seal. */
export const RETENTION_YEARS = 10
/** One attention item when the stamp is still missing this long after the seal. */
export const TIMESTAMP_OVERDUE_MS = 24 * 60 * 60 * 1000
/** One attention item when a signed version still has no package this long after its last signature. */
export const SEAL_OVERDUE_MS = 60 * 60 * 1000

interface Agreement {
  id: string
  number: string
  title: string
  status: string
  language?: string | null
  ends_on?: string | null
  signed_at?: string | null
}

interface Version {
  id: string
  agreement_id: string
  number: number
  status: string
  sha256?: string | null
  file_id?: string | null
}

export interface SignatureEvent {
  id: string
  version_id: string
  client_action_id: string
  required_phrase?: string | null
  typed_phrase?: string | null
  signer_order?: number | null
  signer_contact_id?: string | null
  signer_user_id?: string | null
  invited_email: string
  invited_by: string
  typed_name: string
  capacity: string
  consent_words: string
  consent_lang: string
  level: string
  document_sha256: string
  signed_at: string
  ip?: string | null
  user_agent?: string | null
  code_verified_at?: string | null
  document_shown_at?: string | null
  reached_end_at?: string | null
}

export interface EvidencePackage {
  id: string
  version_id: string
  level: string
  hash_alg: string
  seal_version: number
  document_sha256: string
  signed_pdf_file_id?: string | null
  signed_pdf_sha256?: string | null
  trail_sha256?: string | null
  trail?: unknown
  manifest?: unknown
  seal?: string | null
  sealed_at: string
  evidence_file_id?: string | null
  signer_copy_file_ids?: Record<string, string> | null
  tsr_file_id?: string | null
  tsa_policy_oid?: string | null
  timestamped_at?: string | null
  stamped_evidence_file_id?: string | null
  stamped_signer_copy_file_ids?: Record<string, string> | null
  timestamp_status: "pending" | "stamped"
  timestamp_overdue_at?: string | null
  last_verified_at?: string | null
  last_verify_ok?: boolean | null
}

export interface CopyMail {
  id: string
  package_id: string
  client_action_id: string
  kind: "signer" | "stamped"
  status: "pending" | "sent" | "failed"
  attempts: number
  sent_at?: string | null
  alerted_at?: string | null
}

/** The bridge doors the seal uses (bridge/signing.ts and bridge/evidence.ts). */
export interface SealBridge {
  signing_seal?: (p: unknown) => Promise<unknown>
  signing_timestamp?: (p: unknown) => Promise<unknown>
  evidence_signed_pdf?: (p: unknown) => Promise<unknown>
  evidence_package_files?: (p: unknown) => Promise<unknown>
  evidence_rehash?: (p: unknown) => Promise<unknown>
  evidence_mail_copy?: (p: unknown) => Promise<unknown>
  now?: () => Date
}

export type SealCtx = AgreementsCtx & SealBridge

const nowOf = (ctx: SealCtx) => (ctx.now ? ctx.now() : new Date())
const langOf = (a: Agreement): "en" | "fr" => (a.language === "fr" ? "fr" : "en")

/** The trail's fields of one signature event, in canonical JSON's hands (keys sorted there). */
function trailEvent(e: SignatureEvent): Record<string, unknown> {
  return {
    client_action_id: e.client_action_id,
    signer_order: e.signer_order ?? null,
    signer_contact_id: e.signer_contact_id ?? null,
    signer_user_id: e.signer_user_id ?? null,
    invited_email: e.invited_email,
    invited_by: e.invited_by,
    typed_name: e.typed_name,
    capacity: e.capacity,
    consent_words: e.consent_words,
    consent_lang: e.consent_lang,
    required_phrase: e.required_phrase ?? null,
    typed_phrase: e.typed_phrase ?? null,
    level: e.level,
    document_sha256: e.document_sha256,
    signed_at: e.signed_at,
    code_verified_at: e.code_verified_at ?? null,
    document_shown_at: e.document_shown_at ?? null,
    // A statement of the signer's browser, recorded as the client said it.
    reached_end_at: e.reached_end_at ?? null,
    ip: e.ip ?? null,
    user_agent: e.user_agent ?? null,
  }
}

/** Signature events of a version, in signing order. */
export async function eventsOf(ctx: AgreementsCtx, versionId: string): Promise<SignatureEvent[]> {
  const rows = (await ctx.db.findMany("signature_events", {
    where: { version_id: versionId },
    limit: 500,
  })) as SignatureEvent[]
  return rows.sort(
    (a, b) =>
      (a.signer_order ?? 0) - (b.signer_order ?? 0) ||
      String(a.signed_at).localeCompare(String(b.signed_at)) ||
      a.client_action_id.localeCompare(b.client_action_id),
  )
}

/** The trail of a version: what the seal's `trail_sha256` is the hash of. */
export function buildTrail(a: Agreement, v: Version, events: SignatureEvent[]) {
  return {
    v: 1,
    agreement: a.number,
    version: v.number,
    document_sha256: v.sha256,
    events: events.map(trailEvent),
  }
}

export async function packageOf(
  ctx: AgreementsCtx,
  versionId: string,
): Promise<EvidencePackage | null> {
  const rows = (await ctx.db.findMany("evidence_packages", {
    where: { version_id: versionId },
    limit: 1,
  })) as EvidencePackage[]
  return rows[0] ?? null
}

function addYears(iso: string, years: number): string {
  const d = new Date(iso)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString().slice(0, 10)
}

/** `retention_until`: the later of the seal plus 10 years and the contract's end plus the org's setting (at least 5). */
export function retentionUntil(
  sealedAt: string,
  endsOn: string | null | undefined,
  yearsAfterEnd: number,
) {
  const fromSeal = addYears(sealedAt, RETENTION_YEARS)
  if (!endsOn) return fromSeal
  const fromEnd = addYears(endsOn, Math.max(5, yearsAfterEnd))
  return fromEnd > fromSeal ? fromEnd : fromSeal
}

async function yearsAfterEndOf(ctx: AgreementsCtx): Promise<number> {
  const rows = (await ctx.db.findMany("agreements_settings", { limit: 1 })) as Array<{
    retention_years_after_end?: number | null
  }>
  return Math.max(5, Number(rows[0]?.retention_years_after_end ?? 5))
}

export type SealOutcome =
  | {
      status: "sealed"
      package_id: string
      seal: string
      timestamp: "pending" | "stamped"
      first: boolean
    }
  | { status: "not_ready"; reason: string }
  | { status: "seal_pending"; reason: string }
  | ErrorEnvelope

/**
 * Seal a version every signer signed. Idempotent: the first call that writes
 * the package emits `agreement:signed`; a later call (a retry, a replayed
 * event) finishes what is missing and emits nothing.
 */
export async function sealVersion(ctx: SealCtx, versionId: string): Promise<SealOutcome> {
  try {
    return await sealVersionSteps(ctx, versionId)
  } catch (err) {
    // A host door that failed (storage, a file not readable on this run): the
    // version stays signed and `seal-retry` tries again; the decision stands.
    return { status: "seal_pending", reason: (err as Error)?.message ?? "seal step failed" }
  }
}

async function sealVersionSteps(ctx: SealCtx, versionId: string): Promise<SealOutcome> {
  const version = (await ctx.db.findOne("agreement_versions", versionId)) as Version | null
  if (!version) return refusal("NOT_FOUND", "No such agreement version. Nothing was sealed.")
  if (version.status !== "signed")
    return { status: "not_ready", reason: "Not every signer has signed this version yet." }
  const agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
  if (!agreement)
    return refusal("NOT_FOUND", "No agreement holds this version. Nothing was sealed.")
  const events = await eventsOf(ctx, version.id)
  if (events.length === 0)
    return { status: "not_ready", reason: "This version has no recorded signature." }

  let pkg = await packageOf(ctx, version.id)
  let first = false
  if (!pkg) {
    if (!ctx.evidence_signed_pdf || !ctx.signing_seal || !version.file_id || !version.sha256)
      return { status: "seal_pending", reason: "The seal step is not available on this run." }
    const signed = bridgeAnswer<{
      status: string
      fileId?: string
      sha256?: string
      error?: { code: string; message: string }
    }>(
      await ctx.evidence_signed_pdf({
        versionId: version.id,
        frozenFileId: version.file_id,
        documentSha256: version.sha256,
        lang: langOf(agreement),
        agreement: agreement.number,
        version: version.number,
        filename: `${agreement.number}-v${version.number}-signed.pdf`,
        signers: events.map((e) => ({
          name: e.typed_name,
          capacity: e.capacity,
          typedPhrase: e.required_phrase ? (e.typed_phrase ?? null) : null,
          signedAt: e.signed_at,
          level: e.level,
        })),
      }),
    )
    if (signed.status !== "ok" || !signed.fileId || !signed.sha256) {
      const code = signed.error?.code ?? "MERGE_FAILED"
      // The frozen file changed, or the signed copy of an upload does not read
      // as the frozen file did: no package, no seal, no copy, no repair.
      if (code === "DOCUMENT_CHANGED" || code === "COPY_DIFFERS") {
        await ctx.emit?.({
          entity: "evidence",
          action: "mismatch",
          entityId: version.id,
          data: {
            agreement_id: agreement.id,
            number: agreement.number,
            version: version.number,
            what: code === "COPY_DIFFERS" ? "signed_copy" : "frozen_file",
          },
        })
        return refusal(
          code,
          signed.error?.message ?? "The frozen file changed. Nothing was sealed.",
        )
      }
      return { status: "seal_pending", reason: signed.error?.message ?? code }
    }
    const trail = buildTrail(agreement, version, events)
    const level = events.every((e) => e.level === "demo") ? "demo" : "ses"
    const sealed = bridgeAnswer<{
      manifest: unknown
      manifestJson: string
      seal: string
      trailSha256: string
      hashAlg: string
      sealVersion: number
    }>(
      await ctx.signing_seal({
        documentSha256: version.sha256,
        signedPdfSha256: signed.sha256,
        trail,
        level,
        agreement: agreement.number,
        version: version.number,
      }),
    )
    const sealedAt = nowOf(ctx).toISOString()
    try {
      const inserted = await ctx.db.insert("evidence_packages", {
        version_id: version.id,
        level,
        hash_alg: sealed.hashAlg,
        seal_version: sealed.sealVersion,
        document_sha256: version.sha256,
        signed_pdf_file_id: signed.fileId,
        signed_pdf_sha256: signed.sha256,
        trail_sha256: sealed.trailSha256,
        trail,
        manifest: sealed.manifest,
        seal: sealed.seal,
        sealed_at: sealedAt,
        timestamp_status: "pending",
      })
      first = true
      pkg = (await ctx.db.findOne(
        "evidence_packages",
        (inserted as { id: string }).id,
      )) as EvidencePackage
    } catch {
      // Another run sealed this version first (version_id is unique): use its package.
      pkg = await packageOf(ctx, version.id)
      if (!pkg) return { status: "seal_pending", reason: "The package could not be written." }
    }
  }

  if (pkg.timestamp_status === "pending" && !pkg.tsr_file_id) await stampPackage(ctx, pkg)
  pkg = (await ctx.db.findOne("evidence_packages", pkg.id)) as EvidencePackage
  if (!pkg.evidence_file_id) {
    const built = await buildFiles(ctx, agreement, version, pkg, events, false)
    if (built.status !== "ok") return { status: "seal_pending", reason: built.reason }
    pkg = (await ctx.db.findOne("evidence_packages", pkg.id)) as EvidencePackage
  }
  await queueCopies(ctx, pkg, events, "signer")
  await sendCopies(ctx, pkg.id)

  if (first) {
    const lastSigned =
      events
        .map((e) => e.signed_at)
        .sort()
        .at(-1) ?? pkg.sealed_at
    await ctx.db.update("agreements", agreement.id, {
      signed_at: lastSigned,
      retention_until: retentionUntil(pkg.sealed_at, agreement.ends_on, await yearsAfterEndOf(ctx)),
    })
    await ctx.emit?.({
      entity: "agreement",
      action: "signed",
      entityId: agreement.id,
      data: {
        number: agreement.number,
        version: version.number,
        version_id: version.id,
        package_id: pkg.id,
        seal: pkg.seal,
      },
    })
  }
  return {
    status: "sealed",
    package_id: pkg.id,
    seal: String(pkg.seal),
    timestamp: pkg.timestamp_status,
    first,
  }
}

/** Ask the authority once; on a verified stamp store the reply and fill the write-once columns. */
async function stampPackage(ctx: SealCtx, pkg: EvidencePackage): Promise<"stamped" | "pending"> {
  if (!ctx.signing_timestamp || !pkg.manifest) return "pending"
  let answer: unknown
  try {
    answer = await ctx.signing_timestamp({ manifest: pkg.manifest })
  } catch {
    // An authority that cannot be asked at all is down for the seal: the stamp stays
    // pending for `timestamp-retry`, and the evidence and copies go out unstamped.
    return "pending"
  }
  const out = bridgeAnswer<{
    status: string
    replyBase64?: string
    genTime?: string
    policy?: string
  }>(answer)
  if (out.status !== "stamped" || !out.replyBase64 || !ctx.files_importAttachment) return "pending"
  const stored = bridgeAnswer<{ id: string }>(
    await ctx.files_importAttachment({
      targetApp: "agreements",
      targetEntityType: "evidence_package",
      targetEntityId: pkg.id,
      filename: "timestamp.tsr",
      mimeType: "application/timestamp-reply",
      bytesBase64: out.replyBase64,
    }),
  )
  await ctx.db.update("evidence_packages", pkg.id, {
    tsr_file_id: stored.id,
    tsa_policy_oid: out.policy ?? null,
    timestamped_at: out.genTime ?? nowOf(ctx).toISOString(),
    timestamp_status: "stamped",
  })
  return "stamped"
}

async function buildFiles(
  ctx: SealCtx,
  agreement: Agreement,
  version: Version,
  pkg: EvidencePackage,
  events: SignatureEvent[],
  stampedSet: boolean,
): Promise<{ status: "ok" } | { status: "failed"; reason: string }> {
  if (!ctx.evidence_package_files || !pkg.signed_pdf_file_id || !version.file_id)
    return { status: "failed", reason: "The evidence files cannot be built on this run." }
  const manifestJson =
    typeof pkg.manifest === "string" ? pkg.manifest : canonicalManifest(pkg.manifest)
  const out = bridgeAnswer<{
    status: string
    evidenceFileId?: string
    signerCopyFileIds?: Record<string, string>
    error?: { message: string }
  }>(
    await ctx.evidence_package_files({
      packageId: pkg.id,
      versionId: version.id,
      signedFileId: pkg.signed_pdf_file_id,
      frozenFileId: version.file_id,
      tsrFileId: pkg.tsr_file_id ?? null,
      trail: pkg.trail,
      manifestJson,
      seal: pkg.seal,
      sealedAt: pkg.sealed_at,
      lang: langOf(agreement),
      title: agreement.title,
      agreement: agreement.number,
      version: version.number,
      signers: events.map((e) => ({ name: e.typed_name, capacity: e.capacity })),
      signerActionIds: events.map((e) => e.client_action_id),
      stamped: stampedSet,
    }),
  )
  if (out.status !== "ok" || !out.evidenceFileId)
    return {
      status: "failed",
      reason: out.error?.message ?? "The evidence files were not written.",
    }
  const stamped = pkg.tsr_file_id !== null && pkg.tsr_file_id !== undefined
  const data: Record<string, unknown> = stampedSet
    ? {
        stamped_evidence_file_id: out.evidenceFileId,
        stamped_signer_copy_file_ids: out.signerCopyFileIds ?? {},
      }
    : {
        evidence_file_id: out.evidenceFileId,
        signer_copy_file_ids: out.signerCopyFileIds ?? {},
        // Stamped at seal time: the first set is already the stamped one.
        ...(stamped
          ? {
              stamped_evidence_file_id: out.evidenceFileId,
              stamped_signer_copy_file_ids: out.signerCopyFileIds ?? {},
            }
          : {}),
      }
  await ctx.db.update("evidence_packages", pkg.id, data)
  return { status: "ok" }
}

/**
 * The manifest's canonical bytes (RFC 8785 for this flat object of strings and
 * integers: keys sorted, no whitespace), the exact text the seal hashes.
 */
export function canonicalManifest(manifest: unknown): string {
  const m = (manifest ?? {}) as Record<string, unknown>
  const keys = Object.keys(m).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(m[k])}`).join(",")}}`
}

async function queueCopies(
  ctx: AgreementsCtx,
  pkg: EvidencePackage,
  events: SignatureEvent[],
  kind: CopyMail["kind"],
) {
  const existing = (await ctx.db.findMany("copy_mails", {
    where: { package_id: pkg.id, kind },
    limit: 500,
  })) as CopyMail[]
  const have = new Set(existing.map((c) => c.client_action_id))
  for (const e of events) {
    if (have.has(e.client_action_id)) continue
    await ctx.db.insert("copy_mails", {
      package_id: pkg.id,
      client_action_id: e.client_action_id,
      kind,
      status: "pending",
      attempts: 0,
    })
  }
}

/**
 * Send every copy of a package not sent yet, each to its signer's invited
 * address only. A failure counts; the third raises one attention item naming
 * the signer.
 */
export async function sendCopies(ctx: SealCtx, packageId: string) {
  if (!ctx.evidence_mail_copy) return { sent: 0, failed: 0 }
  const pkg = (await ctx.db.findOne("evidence_packages", packageId)) as EvidencePackage | null
  if (!pkg) return { sent: 0, failed: 0 }
  const version = (await ctx.db.findOne("agreement_versions", pkg.version_id)) as Version | null
  const agreement = version
    ? ((await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null)
    : null
  if (!version || !agreement) return { sent: 0, failed: 0 }
  const events = await eventsOf(ctx, version.id)
  const byAction = new Map(events.map((e) => [e.client_action_id, e]))
  const copies = (await ctx.db.findMany("copy_mails", {
    where: { package_id: packageId },
    limit: 500,
  })) as CopyMail[]
  let sent = 0
  let failed = 0
  for (const c of copies) {
    if (c.status === "sent" || c.attempts >= COPY_MAX_ATTEMPTS) continue
    const e = byAction.get(c.client_action_id)
    const files = c.kind === "stamped" ? pkg.stamped_signer_copy_file_ids : pkg.signer_copy_file_ids
    const copyFileId = files?.[c.client_action_id]
    if (!e || !copyFileId || !pkg.signed_pdf_file_id) continue
    const out = bridgeAnswer<{ status: string }>(
      await ctx.evidence_mail_copy({
        to: e.invited_email,
        lang: langOf(agreement),
        agreement: agreement.number,
        version: version.number,
        title: agreement.title,
        documentSha256: pkg.document_sha256,
        seal: pkg.seal,
        timestamped: c.kind === "stamped" || pkg.timestamp_status === "stamped",
        senderEmail: e.invited_by.includes("@") ? e.invited_by : null,
        versionId: version.id,
        packageId: pkg.id,
        signedFileId: pkg.signed_pdf_file_id,
        copyFileId,
      }),
    )
    if (out.status === "sent") {
      await ctx.db.update("copy_mails", c.id, {
        status: "sent",
        attempts: c.attempts + 1,
        sent_at: nowOf(ctx).toISOString(),
      })
      sent += 1
      continue
    }
    failed += 1
    const attempts = c.attempts + 1
    await ctx.db.update("copy_mails", c.id, { status: "failed", attempts })
    if (attempts >= COPY_MAX_ATTEMPTS && !c.alerted_at) {
      await ctx.db.update("copy_mails", c.id, { alerted_at: nowOf(ctx).toISOString() })
      await ctx.emit?.({
        entity: "evidence",
        action: "copy_failed",
        entityId: agreement.id,
        data: {
          number: agreement.number,
          version: version.number,
          signer: e.typed_name,
          attempts,
        },
      })
    }
  }
  return { sent, failed }
}

/**
 * Where a signer's copy stands, for the token page's last frame:
 * `waiting_for_others` (not every signer signed), `on_its_way` (sealed, the
 * mail not sent yet or being retried), `sent`, or `not_sent` (three sends
 * failed; the sender was told).
 */
export type CopyState = "waiting_for_others" | "on_its_way" | "sent" | "not_sent"

export async function copyStateOf(
  ctx: AgreementsCtx,
  versionId: string,
  clientActionId: string,
): Promise<CopyState> {
  const pkg = await packageOf(ctx, versionId)
  if (!pkg) {
    const version = (await ctx.db.findOne("agreement_versions", versionId)) as Version | null
    return version?.status === "signed" ? "on_its_way" : "waiting_for_others"
  }
  const rows = (await ctx.db.findMany("copy_mails", {
    where: { package_id: pkg.id, client_action_id: clientActionId, kind: "signer" },
    limit: 1,
  })) as CopyMail[]
  const c = rows[0]
  if (!c) return "on_its_way"
  if (c.status === "sent") return "sent"
  return c.attempts >= COPY_MAX_ATTEMPTS ? "not_sent" : "on_its_way"
}

/** `seal-retry`: every signed version with no complete package; one attention item after an hour. */
export async function sealRetry(ctx: SealCtx) {
  const versions = (await ctx.db.findMany("agreement_versions", {
    where: { status: "signed" },
    limit: 500,
  })) as Version[]
  let sealed = 0
  let waiting = 0
  for (const v of versions) {
    const pkg = await packageOf(ctx, v.id)
    if (pkg?.evidence_file_id) continue
    const out = await sealVersion(ctx, v.id)
    if (out.status === "sealed") {
      sealed += 1
      continue
    }
    waiting += 1
    const events = await eventsOf(ctx, v.id)
    const last = events
      .map((e) => e.signed_at)
      .sort()
      .at(-1)
    if (!last || nowOf(ctx).getTime() - new Date(last).getTime() < SEAL_OVERDUE_MS) continue
    const a = (await ctx.db.findOne("agreements", v.agreement_id)) as
      | (Agreement & { seal_overdue_at?: string | null })
      | null
    if (!a || a.seal_overdue_at) continue
    await ctx.db.update("agreements", a.id, { seal_overdue_at: nowOf(ctx).toISOString() })
    await ctx.emit?.({
      entity: "evidence",
      action: "seal_overdue",
      entityId: a.id,
      data: { number: a.number, version: v.number },
    })
  }
  return { status: "ok", sealed, waiting }
}

/**
 * `timestamp-retry`: every package still pending asks the authority again; a
 * stamp fills the write-once columns, builds the stamped evidence file and
 * copies and mails them. After 24 hours pending, one attention item, never a
 * second.
 */
export async function timestampRetry(ctx: SealCtx) {
  const pending = (await ctx.db.findMany("evidence_packages", {
    where: { timestamp_status: "pending" },
    limit: 500,
  })) as EvidencePackage[]
  let stamped = 0
  for (const pkg of pending) {
    const got = await stampPackage(ctx, pkg)
    const fresh = (await ctx.db.findOne("evidence_packages", pkg.id)) as EvidencePackage
    if (got === "stamped") {
      stamped += 1
      const version = (await ctx.db.findOne("agreement_versions", fresh.version_id)) as Version
      const agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement
      const events = await eventsOf(ctx, version.id)
      if (!fresh.stamped_evidence_file_id)
        await buildFiles(ctx, agreement, version, fresh, events, true)
      const after = (await ctx.db.findOne("evidence_packages", pkg.id)) as EvidencePackage
      await queueCopies(ctx, after, events, "stamped")
      await sendCopies(ctx, pkg.id)
      continue
    }
    const age = nowOf(ctx).getTime() - new Date(fresh.sealed_at).getTime()
    if (age > TIMESTAMP_OVERDUE_MS && !fresh.timestamp_overdue_at) {
      await ctx.db.update("evidence_packages", pkg.id, {
        timestamp_overdue_at: nowOf(ctx).toISOString(),
      })
      const version = (await ctx.db.findOne("agreement_versions", fresh.version_id)) as Version
      const agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement
      await ctx.emit?.({
        entity: "evidence",
        action: "timestamp_overdue",
        entityId: agreement.id,
        data: { number: agreement.number, version: version.number },
      })
    }
  }
  return { status: "ok", checked: pending.length, stamped }
}

/** `copies-retry`: every copy not sent yet and under its three tries, sent again. */
export async function copiesRetry(ctx: SealCtx) {
  const retry = (await ctx.db.findMany("copy_mails", {
    where: { status: { in: ["failed", "pending"] } },
    limit: 500,
  })) as CopyMail[]
  let sent = 0
  for (const id of new Set(
    retry.filter((c) => c.attempts < COPY_MAX_ATTEMPTS).map((c) => c.package_id),
  ))
    sent += (await sendCopies(ctx, id)).sent
  return { status: "ok", sent }
}

export type VerifyOutcome =
  | {
      status: "ok"
      agreement: string
      version: number
      seal: string
      matches: boolean
      checked: string[]
      message: string
    }
  | ErrorEnvelope

/**
 * `agreement_verify`: re-hash the stored files and recompute the seal. A
 * mismatch records `last_verify_ok = false` and raises `evidence:mismatch`
 * (attention and a monitoring incident). Nothing is ever repaired: the signers'
 * copies are the reference.
 */
export async function verifyPackage(ctx: SealCtx, pkg: EvidencePackage): Promise<VerifyOutcome> {
  const version = (await ctx.db.findOne("agreement_versions", pkg.version_id)) as Version | null
  const agreement = version
    ? ((await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null)
    : null
  if (!version || !agreement || !ctx.evidence_rehash || !ctx.signing_seal)
    return refusal("NOT_AVAILABLE", "This package cannot be checked on this run. Nothing changed.")
  const files: Array<{ fileId: string; parent: { entityType: string; entityId: string } }> = []
  if (version.file_id)
    files.push({
      fileId: version.file_id,
      parent: { entityType: "agreement_version", entityId: version.id },
    })
  if (pkg.signed_pdf_file_id)
    files.push({
      fileId: pkg.signed_pdf_file_id,
      parent: { entityType: "agreement_version", entityId: version.id },
    })
  const { hashes } = bridgeAnswer<{ hashes: Record<string, string | null> }>(
    await ctx.evidence_rehash({ files }),
  )
  const problems: string[] = []
  if (version.file_id && hashes[version.file_id] !== pkg.document_sha256)
    problems.push("the frozen document")
  if (pkg.signed_pdf_file_id && hashes[pkg.signed_pdf_file_id] !== pkg.signed_pdf_sha256)
    problems.push("the signed PDF")
  const resealed = bridgeAnswer<{ seal: string; trailSha256: string }>(
    await ctx.signing_seal({
      documentSha256: pkg.document_sha256,
      signedPdfSha256: pkg.signed_pdf_sha256,
      trail: pkg.trail,
      level: pkg.level,
      agreement: agreement.number,
      version: version.number,
    }),
  )
  if (resealed.trailSha256 !== pkg.trail_sha256) problems.push("the trail")
  if (resealed.seal !== pkg.seal) problems.push("the seal")
  const matches = problems.length === 0
  const at = nowOf(ctx).toISOString()
  await ctx.db.update("evidence_packages", pkg.id, {
    last_verified_at: at,
    last_verify_ok: matches,
  })
  if (!matches)
    await ctx.emit?.({
      entity: "evidence",
      action: "mismatch",
      entityId: agreement.id,
      data: {
        number: agreement.number,
        version: version.number,
        package_id: pkg.id,
        what: problems.join(", "),
      },
    })
  return {
    status: "ok",
    agreement: agreement.number,
    version: version.number,
    seal: String(pkg.seal),
    matches,
    checked: ["the frozen document", "the signed PDF", "the trail", "the seal"],
    message: matches
      ? `${agreement.number} version ${version.number}: the stored files and the trail match the seal.`
      : `${agreement.number} version ${version.number}: the seal does not match (${problems.join(", ")}). Nothing was repaired; the signers' copies are the reference. An incident was opened.`,
  }
}

/** `evidence-verify`: every package, weekly. */
export async function evidenceVerify(ctx: SealCtx) {
  const all = (await ctx.db.findMany("evidence_packages", { limit: 1000 })) as EvidencePackage[]
  let mismatches = 0
  for (const pkg of all) {
    if (!pkg.seal) continue
    const out = await verifyPackage(ctx, pkg)
    if (out.status === "ok" && !out.matches) mismatches += 1
  }
  return { status: "ok", checked: all.length, mismatches }
}

/** `agreement_verify`. */
export async function agreementVerify(ctx: SealCtx, p: { id: string }) {
  const resolved = await resolvePackage(ctx, p?.id)
  if ("status" in resolved) return resolved
  return verifyPackage(ctx, resolved.pkg)
}

async function resolvePackage(
  ctx: AgreementsCtx,
  id: unknown,
): Promise<{ pkg: EvidencePackage; version: Version; agreement: Agreement } | ErrorEnvelope> {
  if (typeof id !== "string" || id.length === 0)
    return refusal("INVALID_PARAMS", "Give the agreement id or the version id.")
  let version = (await ctx.db.findOne("agreement_versions", id)) as Version | null
  let agreement: Agreement | null = null
  if (version) {
    agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as Agreement | null
  } else {
    agreement = (await ctx.db.findOne("agreements", id)) as Agreement | null
    if (agreement) {
      const signed = (await ctx.db.findMany("agreement_versions", {
        where: { agreement_id: agreement.id, status: "signed" },
        limit: 50,
      })) as Version[]
      version = signed.sort((a, b) => b.number - a.number)[0] ?? null
    }
  }
  if (!agreement) return refusal("NOT_FOUND", "No agreement you can see has this id.")
  if (!version)
    return refusal("NOT_SIGNED", `${agreement.number} has no signed version, so no evidence yet.`)
  const pkg = await packageOf(ctx, version.id)
  if (!pkg)
    return refusal(
      "NOT_SEALED",
      `${agreement.number} version ${version.number} is signed but not sealed yet; the seal is retried every 10 minutes.`,
    )
  return { pkg, version, agreement }
}

/**
 * `agreement_evidence_get`: the package of a signed version. IP and user agent
 * only for a holder of `agreements:evidence:devices`; withheld otherwise.
 */
export async function agreementEvidenceGet(ctx: AgreementsCtx, p: { id: string }) {
  const resolved = await resolvePackage(ctx, p?.id)
  if ("status" in resolved) return resolved
  const { pkg, version, agreement } = resolved
  const devices = await holdsDevices(ctx)
  const events = await eventsOf(ctx, version.id)
  const copies = (await ctx.db.findMany("copy_mails", {
    where: { package_id: pkg.id },
    limit: 500,
  })) as CopyMail[]
  const signers = events.map((e) => {
    const copy = copies.find(
      (c) => c.client_action_id === e.client_action_id && c.kind === "signer",
    )
    return {
      name: e.typed_name,
      capacity: e.capacity,
      email: e.invited_email,
      signed_at: e.signed_at,
      level: e.level,
      code_verified_at: e.code_verified_at ?? null,
      document_shown_at: e.document_shown_at ?? null,
      typed_phrase: e.typed_phrase ?? null,
      copy: copy ? copy.status : "not_queued",
      ...(devices ? { ip: e.ip ?? null, user_agent: e.user_agent ?? null } : {}),
    }
  })
  return {
    status: "ok",
    agreement: { id: agreement.id, number: agreement.number, title: agreement.title },
    version: { id: version.id, number: version.number },
    document_sha256: pkg.document_sha256,
    signed_pdf_sha256: pkg.signed_pdf_sha256 ?? null,
    seal: pkg.seal ?? null,
    sealed_at: pkg.sealed_at,
    timestamp: pkg.timestamp_status,
    timestamped_at: pkg.timestamped_at ?? null,
    last_verified_at: pkg.last_verified_at ?? null,
    last_verify_ok: pkg.last_verify_ok ?? null,
    retention_until:
      (agreement as Agreement & { retention_until?: string }).retention_until ?? null,
    signers,
    devices: devices ? "shown" : "withheld",
    message: `${agreement.number} version ${version.number}: sealed with ${signers.length} signature(s); timestamp ${pkg.timestamp_status}.${devices ? "" : " IP and browser are withheld (they need agreements:evidence:devices)."} Check it with agreement_verify.`,
  }
}

async function holdsDevices(ctx: AgreementsCtx): Promise<boolean> {
  if (!ctx.kernel) return false
  const c = await ctx.kernel.caller(["agreements:evidence:devices"])
  return c.holds?.["agreements:evidence:devices"] === true
}
