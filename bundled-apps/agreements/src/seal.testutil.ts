// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tests only: a signed version in the in-memory db and recording doubles of the
// host's seal, timestamp, evidence and copy-mail doors.

import { memoryDb } from "./memory-db.testutil"
import type { SealCtx } from "./seal"

export const SIGNED_PDF = "f".repeat(64)
export const FROZEN = "e".repeat(64)
export const ACTION_A = "aaaaaaaa-0000-4000-8000-00000000000a"
export const ACTION_B = "bbbbbbbb-0000-4000-8000-00000000000b"

export interface SealCalls {
  emitted: Array<{ entity: string; action: string; data?: unknown }>
  mails: Array<{ to: string; copyFileId: string; timestamped: boolean }>
  stamps: number
  files: number
}

export interface SealWorld {
  db: ReturnType<typeof memoryDb>
  ctx: SealCtx & { calls: SealCalls }
  agreementId: string
  versionId: string
  clock: { now: Date }
  authority: { up: boolean }
  mail: { failing: Set<string> }
  storage: Map<string, string>
}

const fakeHash = (s: string) => {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, "0").repeat(8)
}

export async function signedWorld(
  opts: { holdsDevices?: boolean; endsOn?: string; authorityUp?: boolean } = {},
): Promise<SealWorld> {
  const db = memoryDb()
  const clock = { now: new Date(Date.UTC(2026, 10, 10, 9, 0, 0)) }
  const authority = { up: opts.authorityUp ?? true }
  const mail = { failing: new Set<string>() }
  const storage = new Map<string, string>()
  const { id: agreementId } = await db.insert("agreements", {
    number: "AG-2026-001",
    title: "Maison Morel website",
    status: "signed",
    language: "fr",
    ends_on: opts.endsOn ?? null,
  })
  const { id: versionId } = await db.insert("agreement_versions", {
    agreement_id: agreementId,
    number: 1,
    status: "signed",
    file_id: "file-frozen",
    sha256: FROZEN,
  })
  storage.set("file-frozen", FROZEN)
  let n = 0
  for (const [i, id] of [ACTION_A, ACTION_B].entries()) {
    await db.insert("signature_events", {
      version_id: versionId,
      client_action_id: id,
      signer_order: i + 1,
      invited_email: i === 0 ? "paul@maison-morel.example" : "anne@maison-morel.example",
      invited_by: "lea@studio.example",
      typed_name: i === 0 ? "Paul Morel" : "Anne Morel",
      capacity: i === 0 ? "Gérant" : "Associée",
      consent_words: "words",
      consent_lang: "fr",
      level: "ses",
      document_sha256: FROZEN,
      signed_at: `2026-11-10 08:0${i}:00+00`,
      ip: i === 0 ? "198.51.100.7" : "203.0.113.9",
      user_agent: i === 0 ? "UA-of-Paul" : "UA-of-Anne",
      code_verified_at: "2026-11-10 07:59:00+00",
      document_shown_at: "2026-11-10 07:58:00+00",
    })
  }
  const calls: SealCalls = { emitted: [], mails: [], stamps: 0, files: 0 }
  const ctx: SealWorld["ctx"] = {
    orgId: "org",
    userId: "",
    db,
    calls,
    now: () => clock.now,
    kernel: {
      caller: async () => ({
        kind: "person",
        userId: "u",
        roleIds: [],
        holds: { "agreements:evidence:devices": opts.holdsDevices === true },
      }),
    } as unknown as SealCtx["kernel"],
    emit: async (e) => {
      calls.emitted.push({ entity: e.entity, action: e.action, data: e.data })
      return null
    },
    files_importAttachment: async () => {
      calls.files += 1
      return { id: `file-${++n}` }
    },
    evidence_signed_pdf: async () => {
      storage.set("file-signed", SIGNED_PDF)
      return { status: "ok", fileId: "file-signed", sha256: SIGNED_PDF, pageCount: 3 }
    },
    signing_seal: async (p: unknown) => {
      const q = p as {
        documentSha256: string
        signedPdfSha256: string
        trail: unknown
        level: string
      }
      const trailSha256 = fakeHash(JSON.stringify(q.trail))
      const manifest = {
        v: 1,
        hash: "sha256",
        document_sha256: q.documentSha256,
        signed_pdf_sha256: q.signedPdfSha256,
        trail_sha256: trailSha256,
        level: q.level,
        agreement: "AG-2026-001",
        version: 1,
      }
      return {
        manifest,
        manifestJson: JSON.stringify(manifest),
        seal: fakeHash(JSON.stringify(manifest)),
        trailSha256,
        hashAlg: "sha256",
        sealVersion: 1,
      }
    },
    signing_timestamp: async () => {
      calls.stamps += 1
      return authority.up
        ? {
            status: "stamped",
            replyBase64: "MAA=",
            genTime: clock.now.toISOString(),
            policy: "1.2.3",
          }
        : { status: "pending", reason: "timeout" }
    },
    evidence_package_files: async (p: unknown) => {
      const q = p as { signerActionIds: string[] }
      const copies: Record<string, string> = {}
      for (const id of q.signerActionIds) copies[id] = `copy-${id}-${++n}`
      copies.colleague = `copy-colleague-${++n}`
      return { status: "ok", evidenceFileId: `evidence-${++n}`, signerCopyFileIds: copies }
    },
    evidence_rehash: async (p: unknown) => {
      const q = p as { files: Array<{ fileId: string }> }
      return {
        status: "ok",
        hashes: Object.fromEntries(q.files.map((f) => [f.fileId, storage.get(f.fileId) ?? null])),
      }
    },
    evidence_mail_copy: async (p: unknown) => {
      const q = p as { to: string; copyFileId: string; timestamped: boolean }
      if (mail.failing.has(q.to)) return { status: "failed", reason: "EmailProviderError" }
      calls.mails.push({ to: q.to, copyFileId: q.copyFileId, timestamped: q.timestamped })
      return { status: "sent" }
    },
  }
  return { db, ctx, agreementId, versionId, clock, authority, mail, storage }
}

export const at = (world: SealWorld, hours: number, minutes = 0) => {
  world.clock.now = new Date(world.clock.now.getTime() + (hours * 60 + minutes) * 60_000)
}
