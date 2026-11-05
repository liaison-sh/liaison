// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The signed statement of a first-party app artifact (one per name@version).
 *
 * Wire format, `statement.json`: the canonical JSON of the object below, i.e.
 * UTF-8, keys sorted by code unit at every depth, no whitespace, no trailing
 * newline. `statement.sig`: the base64 Ed25519 signature over exactly those
 * bytes. A verifier checks the signature over the bytes as received and refuses
 * bytes that are not the canonical form of what they parse to, so there is one
 * byte string per statement.
 *
 *   {
 *     "v": 1,
 *     "keyId": "<id of the signing key in APP_SIGNING_KEYS>",
 *     "name": "<app name>",
 *     "version": "<app version>",
 *     "hostApi": "<manifest host range, e.g. ^1>",
 *     "sha256": { "ui": "<hex of ui.js>", "manifest": "<hex of manifest.json>",
 *                 "package": "<hex of <name>-<version>.liaisonapp>" },
 *     "sourceDigest": "<hex tree digest of bundled-apps/<name>>",
 *     "issuedAt": "<ISO-8601 UTC>"
 *   }
 */
import { utf8 } from "./encoding"

export interface AppStatement {
  v: 1
  keyId: string
  name: string
  version: string
  hostApi: string
  sha256: { ui: string; manifest: string; package: string }
  sourceDigest: string
  issuedAt: string
}

/** JSON with object keys sorted at every depth and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function statementBytes(statement: AppStatement): Uint8Array {
  return utf8.encode(canonicalJson(statement))
}

const HEX64 = /^[0-9a-f]{64}$/
const TOP_KEYS = ["hostApi", "issuedAt", "keyId", "name", "sha256", "sourceDigest", "v", "version"]
const HASH_KEYS = ["manifest", "package", "ui"]

function sameKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** The statement these bytes hold, or null when they are not exactly one. */
export function parseStatement(bytes: Uint8Array): AppStatement | null {
  let raw: unknown
  try {
    raw = JSON.parse(utf8.decode(bytes))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (!sameKeys(s, TOP_KEYS) || s.v !== 1) return null
  const { keyId, name, version, hostApi, issuedAt, sourceDigest } = s
  if (!nonEmpty(keyId) || !nonEmpty(name) || !nonEmpty(version)) return null
  if (!nonEmpty(hostApi) || !nonEmpty(issuedAt)) return null
  if (!isHex64(sourceDigest)) return null
  const h = s.sha256
  if (h === null || typeof h !== "object" || Array.isArray(h)) return null
  const hashes = h as Record<string, unknown>
  if (!sameKeys(hashes, HASH_KEYS)) return null
  const { ui, manifest, package: pkg } = hashes
  if (!isHex64(ui) || !isHex64(manifest) || !isHex64(pkg)) return null
  return {
    v: 1,
    keyId,
    name,
    version,
    hostApi,
    sha256: { ui, manifest, package: pkg },
    sourceDigest,
    issuedAt,
  }
}

const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v)
