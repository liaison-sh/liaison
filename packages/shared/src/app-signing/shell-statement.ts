// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The signed statement of one web shell build (the apps/web build a desktop or
 * phone app may run in its main window when the connected server serves it).
 *
 * Same wire rules as an app statement (statement.ts): `statement.json` is the
 * canonical JSON of the object below, `statement.sig` the base64 Ed25519
 * signature over exactly those bytes, signed with an app-signing key
 * (keys.json). It is published per build id and never changes once published.
 *
 *   {
 *     "v": 1,
 *     "kind": "shell",
 *     "keyId": "<id of the signing key>",
 *     "mode": "desktop" | "native",
 *     "buildId": "<16-hex web build id, build-id.txt>",
 *     "commit": "<40-hex source commit>",
 *     "seq": <committer time of the commit, unix seconds>,
 *     "liaisonVersion": "<release or nightly name>",
 *     "bridge": { "desktop": "<semver range>", "ios": "<range>", "android": "<range>" },
 *     "settingsSchema": <settings page format version>,
 *     "files": { "<path relative to the build root>": "<sha256 hex>", ... },
 *     "issuedAt": "<ISO-8601 UTC>"
 *   }
 *
 * `kind` keeps the two statement types apart: an app statement has no `kind`
 * and the app parser refuses one that has, and this parser refuses anything
 * but `kind: "shell"`, so a signature over one can never pass as the other.
 *
 * `seq` orders shell builds of one mode: the revocation list (revocations.ts)
 * carries `{name: "shell:<mode>", below: "<seq>"}` floors, and a statement
 * below a floor never runs.
 */
import { utf8 } from "./encoding"
import type { AppRevocationEntry, AppSigningKey } from "./keys"
import { REVOCATION_FLOOR } from "./keys"
import type { RevocationList } from "./revocations"
import { canonicalJson } from "./statement"
import { verifySignedBytes } from "./verify"

export const SHELL_MODES = ["desktop", "native"] as const
export type ShellMode = (typeof SHELL_MODES)[number]

export interface ShellBridgeRanges {
  desktop: string
  ios: string
  android: string
}

export interface ShellStatement {
  v: 1
  kind: "shell"
  keyId: string
  mode: ShellMode
  buildId: string
  commit: string
  seq: number
  liaisonVersion: string
  bridge: ShellBridgeRanges
  settingsSchema: number
  files: Record<string, string>
  issuedAt: string
}

export function shellStatementBytes(statement: ShellStatement): Uint8Array {
  return utf8.encode(canonicalJson(statement))
}

const TOP_KEYS = [
  "bridge",
  "buildId",
  "commit",
  "files",
  "issuedAt",
  "keyId",
  "kind",
  "liaisonVersion",
  "mode",
  "seq",
  "settingsSchema",
  "v",
]
const BRIDGE_KEYS = ["android", "desktop", "ios"]
const HEX16 = /^[0-9a-f]{16}$/
const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0

function sameKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

export function isShellMode(v: unknown): v is ShellMode {
  return typeof v === "string" && (SHELL_MODES as readonly string[]).includes(v)
}

/**
 * A path a shell file may have: relative, forward slashes, no empty, `.` or
 * `..` segment. The client fetches each one from the server under the build
 * root, so a path must never climb out of it.
 */
export function isShellFilePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\")) return false
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
}

/** The shell statement these bytes hold, or null when they are not exactly one. */
export function parseShellStatement(bytes: Uint8Array): ShellStatement | null {
  let raw: unknown
  try {
    raw = JSON.parse(utf8.decode(bytes))
  } catch {
    return null
  }
  if (!isObject(raw) || !sameKeys(raw, TOP_KEYS)) return null
  if (raw.v !== 1 || raw.kind !== "shell") return null
  const { keyId, mode, buildId, commit, seq, liaisonVersion, settingsSchema, issuedAt } = raw
  if (!nonEmpty(keyId) || !isShellMode(mode) || !nonEmpty(liaisonVersion) || !nonEmpty(issuedAt)) {
    return null
  }
  if (typeof buildId !== "string" || !HEX16.test(buildId)) return null
  if (typeof commit !== "string" || !HEX40.test(commit)) return null
  if (!isCount(seq) || !isCount(settingsSchema)) return null
  const bridge = raw.bridge
  if (!isObject(bridge) || !sameKeys(bridge, BRIDGE_KEYS)) return null
  const { desktop, ios, android } = bridge
  if (!nonEmpty(desktop) || !nonEmpty(ios) || !nonEmpty(android)) return null
  const files = raw.files
  if (!isObject(files)) return null
  const entries = Object.entries(files)
  if (entries.length === 0) return null
  for (const [path, hash] of entries) {
    if (!isShellFilePath(path) || typeof hash !== "string" || !HEX64.test(hash)) return null
  }
  return {
    v: 1,
    kind: "shell",
    keyId,
    mode,
    buildId,
    commit,
    seq,
    liaisonVersion,
    bridge: { desktop, ios, android },
    settingsSchema,
    files: Object.fromEntries(entries) as Record<string, string>,
    issuedAt,
  }
}

/** The revocation-list name that carries the floor of one shell mode. */
export function shellRevocationName(mode: ShellMode): `shell:${ShellMode}` {
  return `shell:${mode}`
}

function belowShellFloor(
  entries: readonly AppRevocationEntry[],
  mode: ShellMode,
  seq: number,
): boolean {
  const name = shellRevocationName(mode)
  return entries.some(
    (e) => e.name === name && e.below !== undefined && seq < Number.parseInt(e.below, 10),
  )
}

export interface ShellRevocations {
  /** The verified downloaded list, or null when the client holds none. */
  list: RevocationList | null
  /** Defaults to the floor compiled into this release (keys.json). */
  floor?: readonly AppRevocationEntry[]
}

/** Why a shell build of `mode` at `seq` must not run, or null. */
export function shellRevocationFor(
  mode: ShellMode,
  seq: number,
  opts: ShellRevocations,
): "below_floor" | "revoked" | null {
  if (belowShellFloor(opts.floor ?? REVOCATION_FLOOR, mode, seq)) return "below_floor"
  if (opts.list && belowShellFloor(opts.list.entries, mode, seq)) return "revoked"
  return null
}

export type ShellStatementVerification =
  | { ok: true; statement: ShellStatement }
  | {
      ok: false
      reason:
        | "no_keys"
        | "malformed_statement"
        | "unknown_key"
        | "bad_signature"
        | "unsupported"
        | "below_floor"
        | "revoked"
    }

/**
 * Check a shell statement: canonical bytes, a signature by the pinned key it
 * names, and a seq not below its mode's floor. The files it lists are the
 * caller's to compare (each one's sha256 against `statement.files`).
 */
export async function verifyShellStatement(
  bytes: Uint8Array,
  sig: string | Uint8Array,
  keys: readonly AppSigningKey[],
  revocations: ShellRevocations,
): Promise<ShellStatementVerification> {
  if (keys.length === 0) return { ok: false, reason: "no_keys" }
  const statement = parseShellStatement(bytes)
  if (!statement || utf8.decode(bytes) !== canonicalJson(statement)) {
    return { ok: false, reason: "malformed_statement" }
  }
  const result = await verifySignedBytes(bytes, sig, statement.keyId, keys)
  if (result !== "ok") return { ok: false, reason: result }
  const revoked = shellRevocationFor(statement.mode, statement.seq, revocations)
  if (revoked) return { ok: false, reason: revoked }
  return { ok: true, statement }
}
