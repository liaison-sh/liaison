// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seal of a signed agreement version: SHA-256 over the canonical JSON
// (RFC 8785) of a fixed manifest holding the frozen document's fingerprint,
// the signed PDF's hash and the trail's hash. It has no key and no HMAC:
// anyone who changes every input can recompute it, which is why the outside
// timestamp over it and the copy mailed to each signer exist.
import { createHash } from "node:crypto"
import { canonicalJsonBytes } from "~/modules/signing/canonical-json"
import { SEAL_HASH_ALG, SEAL_MANIFEST_FIELDS, SEAL_VERSION } from "~/modules/signing/constants"

export interface SealManifest {
  v: typeof SEAL_VERSION
  hash: typeof SEAL_HASH_ALG
  document_sha256: string
  signed_pdf_sha256: string
  trail_sha256: string
  level: string
  agreement: string
  version: number
}

export interface SealInput {
  documentSha256: string
  signedPdfSha256: string
  trailSha256: string
  level: string
  agreement: string
  version: number
}

export interface Seal {
  manifest: SealManifest
  /** The canonical bytes the seal is the hash of (the manifest file of the evidence zip). */
  manifestBytes: Uint8Array
  /** Lowercase hex SHA-256 of `manifestBytes`. */
  seal: string
  hashAlg: typeof SEAL_HASH_ALG
  sealVersion: typeof SEAL_VERSION
}

export class SealInputError extends Error {
  readonly code = "invalid_seal_input"
  constructor(message: string) {
    super(message)
    this.name = "SealInputError"
  }
}

const HEX_SHA256 = /^[0-9a-f]{64}$/

/** Lowercase hex SHA-256 of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash(SEAL_HASH_ALG).update(bytes).digest("hex")
}

/** The trail hash: SHA-256 of the trail's canonical JSON. */
export function trailSha256(trail: unknown): string {
  return sha256Hex(canonicalJsonBytes(trail))
}

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) {
    throw new SealInputError(`${name} must be a lowercase hex SHA-256 (64 characters)`)
  }
  return value
}

/** Build the manifest from its inputs, refusing anything that is not exactly its shape. */
export function buildSealManifest(input: SealInput): SealManifest {
  if (typeof input.level !== "string" || input.level.length === 0 || input.level.length > 64) {
    throw new SealInputError("level must be a non-empty string of at most 64 characters")
  }
  if (
    typeof input.agreement !== "string" ||
    input.agreement.length === 0 ||
    input.agreement.length > 200
  ) {
    throw new SealInputError("agreement must be a non-empty string of at most 200 characters")
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new SealInputError("version must be a positive integer")
  }
  return {
    v: SEAL_VERSION,
    hash: SEAL_HASH_ALG,
    document_sha256: requireHash("document_sha256", input.documentSha256),
    signed_pdf_sha256: requireHash("signed_pdf_sha256", input.signedPdfSha256),
    trail_sha256: requireHash("trail_sha256", input.trailSha256),
    level: input.level,
    agreement: input.agreement,
    version: input.version,
  }
}

/** Read a stored manifest back, refusing extra or missing fields and another version. */
export function parseSealManifest(value: unknown): SealManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SealInputError("manifest must be an object")
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = [...SEAL_MANIFEST_FIELDS].sort()
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new SealInputError(`manifest fields must be exactly: ${SEAL_MANIFEST_FIELDS.join(", ")}`)
  }
  if (record.v !== SEAL_VERSION || record.hash !== SEAL_HASH_ALG) {
    throw new SealInputError(`manifest must be v ${SEAL_VERSION} with hash ${SEAL_HASH_ALG}`)
  }
  return buildSealManifest({
    documentSha256: record.document_sha256 as string,
    signedPdfSha256: record.signed_pdf_sha256 as string,
    trailSha256: record.trail_sha256 as string,
    level: record.level as string,
    agreement: record.agreement as string,
    version: record.version as number,
  })
}

/** Seal a manifest already built: canonical bytes and their SHA-256. */
export function sealManifest(manifest: SealManifest): Seal {
  const manifestBytes = canonicalJsonBytes(manifest)
  return {
    manifest,
    manifestBytes,
    seal: sha256Hex(manifestBytes),
    hashAlg: SEAL_HASH_ALG,
    sealVersion: SEAL_VERSION,
  }
}

/** Build and seal in one call. */
export function computeSeal(input: SealInput): Seal {
  return sealManifest(buildSealManifest(input))
}
