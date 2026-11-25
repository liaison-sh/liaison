// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the offline checker page checks, as plain functions that run the same
// in a browser and in a test. Nothing here is a new primitive:
// - SHA-256 is the browser's WebCrypto digest when there is one, otherwise the
//   pure-JS SHA-256 the invoicing app already ships for its sandbox;
// - canonical JSON and every constant are the signing module's own files,
//   bundled into the page, so the page can never canonicalise differently;
// - the timestamp reply is parsed with asn1js (the signing module's pin).
//
// The page never checks the authority's signature or its certificate chain:
// that needs the authority's own published certificate, which the evidence
// file does not carry, so the page says so and gives the openssl line.
import * as asn1js from "asn1js"
import { canonicalJsonBytes } from "../../../apps/api/src/modules/signing/canonical-json"
import {
  OID_CT_TSTINFO,
  OID_SHA256,
  OID_SIGNED_DATA,
  SEAL_HASH_ALG,
  SEAL_MANIFEST_FIELDS,
  SEAL_VERSION,
  TSP_ACCEPTED_STATUSES,
} from "../../../apps/api/src/modules/signing/constants"
import { sha256Hex as pureSha256Hex } from "../../../bundled-apps/invoicing/src/einvoicing/backfill-sha256"

/** The package data a page carries, every byte field as base64. */
export interface EvidenceData {
  v: 1
  lang: "en" | "fr"
  /** Name of the organization that keeps the full event list. */
  org: string
  /** manifest.json's exact bytes. */
  manifest: string
  /** trail.json's exact bytes. */
  trail: string
  trailKind: "full" | "signer_copy"
  /** timestamp.tsr's bytes, absent while the stamp is pending. */
  token?: string
}

export type HashMethod = "webcrypto" | "builtin"

export interface Hasher {
  method: HashMethod
  sha256Hex(bytes: Uint8Array): Promise<string>
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/**
 * The browser's SHA-256 when it has one (`crypto.subtle` exists only in a
 * secure context, which a file opened from disk is in most browsers), the
 * bundled pure-JS one otherwise.
 */
export function pickHasher(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Hasher {
  if (subtle && typeof subtle.digest === "function") {
    return {
      method: "webcrypto",
      async sha256Hex(bytes) {
        // A copy owns a plain ArrayBuffer, which digest() takes.
        return toHex(new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes))))
      },
    }
  }
  return {
    method: "builtin",
    async sha256Hex(bytes) {
      return pureSha256Hex(bytes)
    },
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface Manifest {
  v: number
  hash: string
  document_sha256: string
  signed_pdf_sha256: string
  trail_sha256: string
  level: string
  agreement: string
  version: number
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

/** Read manifest.json, refusing anything that is not exactly its shape. */
export function parseManifest(bytes: Uint8Array): Manifest | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = [...SEAL_MANIFEST_FIELDS].sort()
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return null
  if (record.v !== SEAL_VERSION || record.hash !== SEAL_HASH_ALG) return null
  for (const f of ["document_sha256", "signed_pdf_sha256", "trail_sha256"] as const) {
    if (typeof record[f] !== "string" || !HEX_SHA256.test(record[f] as string)) return null
  }
  if (typeof record.level !== "string" || typeof record.agreement !== "string") return null
  if (!Number.isSafeInteger(record.version)) return null
  return record as unknown as Manifest
}

/** The manifest's canonical bytes (RFC 8785, the signing module's own code). */
export function canonicalManifestBytes(manifest: Manifest): Uint8Array {
  return canonicalJsonBytes(manifest)
}

/** The seal of a manifest: SHA-256 of its canonical bytes. */
export async function recomputeSeal(manifest: Manifest, hasher: Hasher): Promise<string> {
  return hasher.sha256Hex(canonicalManifestBytes(manifest))
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

export interface TrailEvent {
  name: string
  capacity: string
  signedAt: string
  ip: string | null
  userAgent: string | null
}

export type TrailCheck =
  /** The full list: its fingerprint is the manifest's. */
  | { kind: "sealed" }
  /** The full list, and its fingerprint is not the manifest's. */
  | { kind: "mismatch"; sha256: string }
  /** A signer's copy: other people's devices left out, never checked. */
  | { kind: "copy" }
  | { kind: "unreadable" }

export type TokenCheck =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "refused"; status: number }
  | {
      kind: "read"
      /** The imprint is SHA-256 and its bytes are this package's seal. */
      namesSeal: boolean
      imprintAlgorithm: string
      imprintHex: string
      genTime: Date
      serialHex: string
      policy: string
    }

export interface PackageCheck {
  manifest: Manifest
  /** manifest.json's bytes are the canonical form of what they say. */
  manifestCanonical: boolean
  /** SHA-256 of manifest.json's bytes: the seal. */
  seal: string
  /** SHA-256 recomputed from the manifest's canonical form. */
  recomputedSeal: string
  trail: TrailCheck
  events: TrailEvent[]
  token: TokenCheck
  /** Something in the package does not hold together. */
  problems: Array<"manifest_not_canonical" | "trail_mismatch" | "token_not_this_seal">
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function readEvents(trail: unknown): TrailEvent[] {
  const events = (trail as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return []
  return events.map((e) => {
    const r = (e && typeof e === "object" ? e : {}) as Record<string, unknown>
    return {
      name: str(r.typed_name),
      capacity: str(r.capacity),
      signedAt: str(r.signed_at),
      ip: strOrNull(r.ip),
      userAgent: strOrNull(r.user_agent),
    }
  })
}

// ---- timestamp reply (RFC 3161 TimeStampResp), read only -------------------

type Node = asn1js.AsnType

function children(n: Node | undefined): Node[] {
  const v = (n as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock?.value
  return Array.isArray(v) ? (v as Node[]) : []
}

function isContext(n: Node | undefined, tag: number): boolean {
  const id = (n as { idBlock?: { tagClass: number; tagNumber: number } } | undefined)?.idBlock
  return id?.tagClass === 3 && id.tagNumber === tag
}

function oid(n: Node | undefined): string | null {
  return n instanceof asn1js.ObjectIdentifier ? n.valueBlock.toString() : null
}

function intHex(n: Node | undefined): string | null {
  return n instanceof asn1js.Integer ? toHex(n.valueBlock.valueHexView) : null
}

function intSmall(n: Node | undefined): number | null {
  return n instanceof asn1js.Integer ? n.valueBlock.valueDec : null
}

/**
 * Read a timestamp reply: its status, and from its TSTInfo the imprint, the
 * time, the serial and the policy. One DER value with nothing after it. This
 * reads; it does not verify the authority's signature.
 */
export function readTimestampReply(bytes: Uint8Array): Exclude<TokenCheck, { kind: "absent" }> & {
  kind: "unreadable" | "refused" | "read"
} {
  const unreadable = { kind: "unreadable" as const }
  try {
    const parsed = asn1js.fromBER(bytes)
    if (parsed.offset === -1 || parsed.offset !== bytes.byteLength) return unreadable
    const resp = parsed.result
    if (!(resp instanceof asn1js.Sequence)) return unreadable
    const [statusInfo, token] = children(resp)
    const status = intSmall(children(statusInfo)[0])
    if (status === null) return unreadable
    if (!(TSP_ACCEPTED_STATUSES as readonly number[]).includes(status)) {
      return { kind: "refused", status }
    }
    const [contentType, explicitContent] = children(token)
    if (oid(contentType) !== OID_SIGNED_DATA || !isContext(explicitContent, 0)) return unreadable
    const signedData = children(explicitContent)[0]
    const encap = children(signedData)[2]
    const [eContentType, explicitEContent] = children(encap)
    if (oid(eContentType) !== OID_CT_TSTINFO || !isContext(explicitEContent, 0)) return unreadable
    const octets = children(explicitEContent)[0]
    // A chunked (constructed) OCTET STRING is refused, as the signing module does.
    if (!(octets instanceof asn1js.OctetString) || octets.idBlock.isConstructed) return unreadable
    const tstBytes = octets.valueBlock.valueHexView
    const tstParsed = asn1js.fromBER(tstBytes)
    if (tstParsed.offset !== tstBytes.byteLength) return unreadable
    const [version, policy, imprint, serial, genTime] = children(tstParsed.result)
    if (intSmall(version) !== 1) return unreadable
    const [algId, hashed] = children(imprint)
    const algorithm = oid(children(algId)[0])
    const policyOid = oid(policy)
    const serialHex = intHex(serial)
    if (!algorithm || !policyOid || serialHex === null) return unreadable
    if (!(hashed instanceof asn1js.OctetString) || hashed.idBlock.isConstructed) return unreadable
    if (!(genTime instanceof asn1js.GeneralizedTime)) return unreadable
    return {
      kind: "read",
      namesSeal: false,
      imprintAlgorithm: algorithm,
      imprintHex: toHex(hashed.valueBlock.valueHexView),
      genTime: genTime.toDate(),
      serialHex,
      policy: policyOid,
    }
  } catch {
    return unreadable
  }
}

/** Check the package a page carries. `null` when its manifest cannot be read at all. */
export async function checkPackage(
  data: EvidenceData,
  hasher: Hasher,
): Promise<PackageCheck | null> {
  const manifestBytes = base64ToBytes(data.manifest)
  const manifest = parseManifest(manifestBytes)
  if (!manifest) return null
  const problems: PackageCheck["problems"] = []
  const canonical = canonicalManifestBytes(manifest)
  const manifestCanonical = sameBytes(canonical, manifestBytes)
  if (!manifestCanonical) problems.push("manifest_not_canonical")
  const seal = await hasher.sha256Hex(manifestBytes)
  const recomputedSeal = await hasher.sha256Hex(canonical)

  let trail: TrailCheck = { kind: "unreadable" }
  let events: TrailEvent[] = []
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(data.trail)),
    ) as unknown
    events = readEvents(value)
    if (data.trailKind === "full") {
      const sha256 = await hasher.sha256Hex(canonicalJsonBytes(value))
      trail = sha256 === manifest.trail_sha256 ? { kind: "sealed" } : { kind: "mismatch", sha256 }
      if (trail.kind === "mismatch") problems.push("trail_mismatch")
    } else {
      trail = { kind: "copy" }
    }
  } catch {
    trail = { kind: "unreadable" }
  }

  let token: TokenCheck = { kind: "absent" }
  if (data.token) {
    const read = readTimestampReply(base64ToBytes(data.token))
    if (read.kind === "read") {
      read.namesSeal = read.imprintAlgorithm === OID_SHA256 && read.imprintHex === seal
      if (!read.namesSeal) problems.push("token_not_this_seal")
    }
    token = read
  }
  return { manifest, manifestCanonical, seal, recomputedSeal, trail, events, token, problems }
}

export type FileMatch = "document" | "signed_pdf" | "other"

/** Compare a dropped file with the manifest's two fingerprints. */
export async function checkFile(
  bytes: Uint8Array,
  manifest: Manifest,
  hasher: Hasher,
): Promise<{ match: FileMatch; sha256: string }> {
  const sha256 = await hasher.sha256Hex(bytes)
  if (sha256 === manifest.document_sha256) return { match: "document", sha256 }
  if (sha256 === manifest.signed_pdf_sha256) return { match: "signed_pdf", sha256 }
  return { match: "other", sha256 }
}

/** The command that checks the authority's signature, with only files of the evidence zip. */
export const OPENSSL_VERIFY_LINE =
  "openssl ts -verify -in timestamp.tsr -data manifest.json -CAfile tsa-chain.pem"
