// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sign the shell statements of one commit from the file manifests of two
// independent builds (build-manifest.ts), never from a build of its own.
//
// It runs where the signing key is, so it builds nothing, installs nothing and
// imports only the signing code (packages/shared/src/app-signing, the key
// loader of scripts/app-signing/sign-artifact.ts). The workflow runs it from a
// pinned, reviewed liaison commit, never from the commit being signed.
//
// Each mode stands alone: a mode it refuses or skips never stops the other.
// For each mode it refuses unless:
//   - both manifests parse, with exactly the manifest's keys,
//   - their canonical JSON is byte-identical (same build id, same files, same
//     hashes, same bridge ranges and settings schema),
//   - they name the commit, seq and release name given here (the signer's job
//     computes those from its own checkout, not from either builder).
// What the downloads host already holds for that mode's build id
// (`--existing <dir>/<mode>/<buildId>/statement.{json,sig}`, read by another
// job, so untrusted):
//   - a statement.sig: the mode is skipped (published; a build id names its
//     bytes, so a later commit with the same build id needs no new statement),
//   - a statement.json and no .sig (a publish that died between the two): it
//     signs THOSE bytes, never a fresh pair, once they parse as a canonical
//     shell statement by this key that says exactly what the manifests and
//     this signer say (only issuedAt may differ); else the mode is refused and
//     a person removes the orphan file.
// Then it writes `<out>/<mode>/<buildId>/statement.json` (canonical JSON) and
// `statement.sig` (base64 Ed25519), verifies its own output with the public
// half, and always writes `<out>/result.json` (`{signed, skipped, refused}`):
// the publish job publishes what was signed, then fails on any refusal.
//
// Usage:
//   bun scripts/shell-signing/sign-statement.ts --a <dir> --b <dir>
//     --commit <40 hex> --seq <unix seconds> --liaison-version <name>
//     --key <pem> --out <dir> [--existing <dir>]
// <dir> holds shell-manifest-desktop.json and shell-manifest-native.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bytesToBase64, utf8 } from "../../packages/shared/src/app-signing/encoding"
import {
  parseShellStatement,
  SHELL_MODES,
  type ShellMode,
  type ShellStatement,
  shellStatementBytes,
  verifyShellStatement,
} from "../../packages/shared/src/app-signing/shell-statement"
import { canonicalJson } from "../../packages/shared/src/app-signing/statement"
import { loadPrivateKey } from "../app-signing/sign-artifact"

/** A build's file manifest: a shell statement without the signer's fields. */
export type ShellManifest = Omit<ShellStatement, "v" | "kind" | "keyId" | "issuedAt">

export const manifestFileName = (mode: ShellMode) => `shell-manifest-${mode}.json`

const PLACEHOLDER_KEY = "manifest-check"
const PLACEHOLDER_TIME = "1970-01-01T00:00:00.000Z"

/** The manifest in `text`, or null when it is not exactly one. */
export function parseShellManifest(text: string): ShellManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  // A manifest is a statement minus four fields: check it through the
  // statement's own strict parser, so the two can never disagree on a field.
  const asStatement = {
    ...(raw as Record<string, unknown>),
    v: 1,
    kind: "shell",
    keyId: PLACEHOLDER_KEY,
    issuedAt: PLACEHOLDER_TIME,
  }
  const parsed = parseShellStatement(utf8.encode(JSON.stringify(asStatement)))
  if (!parsed || Object.keys(raw).some((k) => ["v", "kind", "keyId", "issuedAt"].includes(k))) {
    return null
  }
  const { v: _v, kind: _kind, keyId: _keyId, issuedAt: _issuedAt, ...manifest } = parsed
  return manifest
}

export interface SignInput {
  a: string
  b: string
  commit: string
  seq: number
  liaisonVersion: string
  keyPath: string
  out: string
  /** What the downloads host holds: `<dir>/<mode>/<buildId>/statement.{json,sig}`. */
  existing?: string
  /** Defaults to now. */
  issuedAt?: string
}

export interface SignedShell {
  mode: ShellMode
  buildId: string
  dir: string
  /** True when it signed the unsigned statement.json the host already held. */
  resigned: boolean
}

export interface SignResult {
  signed: SignedShell[]
  /** Modes whose statement the host already holds, signed. */
  skipped: Array<{ mode: ShellMode; buildId: string }>
  /** Modes refused, with the reason. */
  refused: Partial<Record<ShellMode, string>>
}

export const RESULT_FILE = "result.json"

function readManifest(dir: string, mode: ShellMode, builder: string): ShellManifest {
  const path = join(dir, manifestFileName(mode))
  if (!existsSync(path)) throw new Error(`${builder} ${mode}: no manifest (${path})`)
  const manifest = parseShellManifest(readFileSync(path, "utf8"))
  if (!manifest) throw new Error(`${builder} ${mode}: not a shell manifest (${path})`)
  if (manifest.mode !== mode)
    throw new Error(`${builder} ${mode}: the manifest says ${manifest.mode}`)
  return manifest
}

/** The one manifest both builders agree on for `mode`, or throws why not. */
function agreedManifest(input: SignInput, mode: ShellMode): ShellManifest {
  const a = readManifest(input.a, mode, "builder A")
  const b = readManifest(input.b, mode, "builder B")
  if (canonicalJson(a) !== canonicalJson(b)) {
    const files = new Set([...Object.keys(a.files), ...Object.keys(b.files)])
    const differ = [...files].filter((f) => a.files[f] !== b.files[f]).slice(0, 10)
    throw new Error(
      `${mode}: the two builds differ (build ids ${a.buildId} / ${b.buildId}; files ${differ.join(", ") || "none"}); refusing to sign`,
    )
  }
  if (a.commit !== input.commit)
    throw new Error(`${mode}: built from ${a.commit}, not ${input.commit}`)
  if (a.seq !== input.seq) throw new Error(`${mode}: seq ${a.seq}, not ${input.seq}`)
  if (a.liaisonVersion !== input.liaisonVersion) {
    throw new Error(`${mode}: release ${a.liaisonVersion}, not ${input.liaisonVersion}`)
  }
  return a
}

/**
 * The bytes to sign for an unsigned statement.json the host already holds:
 * those bytes when they are exactly the statement this signer would issue
 * (issuedAt aside), else throws.
 */
function existingBytes(path: string, fresh: ShellStatement): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path))
  const there = parseShellStatement(bytes)
  if (!there || utf8.decode(bytes) !== canonicalJson(there)) {
    throw new Error(`${fresh.mode}: the host's unsigned statement.json is not a shell statement`)
  }
  if (canonicalJson({ ...there, issuedAt: "" }) !== canonicalJson({ ...fresh, issuedAt: "" })) {
    throw new Error(
      `${fresh.mode}: the host holds an unsigned statement.json for build ${fresh.buildId} that says something else (commit ${there.commit}, seq ${there.seq}); it is never replaced, a person removes it`,
    )
  }
  return bytes
}

export async function signShellManifests(input: SignInput): Promise<SignResult> {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error("--commit: not a 40-hex sha")
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error("--seq: not a count")
  if (input.liaisonVersion.length === 0) throw new Error("--liaison-version: empty")
  const key = await loadPrivateKey(input.keyPath)
  const issuedAt = input.issuedAt ?? new Date().toISOString()
  const result: SignResult = { signed: [], skipped: [], refused: {} }
  for (const mode of SHELL_MODES) {
    try {
      const manifest = agreedManifest(input, mode)
      const here = input.existing ? join(input.existing, mode, manifest.buildId) : null
      if (here && existsSync(join(here, "statement.sig"))) {
        result.skipped.push({ mode, buildId: manifest.buildId })
        continue
      }
      const fresh: ShellStatement = { v: 1, kind: "shell", keyId: key.keyId, issuedAt, ...manifest }
      const orphan = here ? join(here, "statement.json") : null
      const resigned = orphan !== null && existsSync(orphan)
      const bytes = resigned ? existingBytes(orphan, fresh) : shellStatementBytes(fresh)
      const sig = new Uint8Array(
        await crypto.subtle.sign("Ed25519", key.privateKey, new Uint8Array(bytes)),
      )
      const sigText = bytesToBase64(sig)
      const check = await verifyShellStatement(
        bytes,
        sigText,
        [{ keyId: key.keyId, publicKey: key.publicKey }],
        { list: null },
      )
      if (!check.ok) throw new Error(`${mode}: own statement does not verify (${check.reason})`)
      const dir = join(input.out, mode, manifest.buildId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "statement.json"), bytes)
      writeFileSync(join(dir, "statement.sig"), sigText)
      result.signed.push({ mode, buildId: manifest.buildId, dir, resigned })
    } catch (err) {
      result.refused[mode] = err instanceof Error ? err.message : String(err)
    }
  }
  mkdirSync(input.out, { recursive: true })
  writeFileSync(
    join(input.out, RESULT_FILE),
    canonicalJson({
      signed: result.signed.map((s) => `${s.mode}/${s.buildId}`),
      skipped: result.skipped.map((s) => `${s.mode}/${s.buildId}`),
      refused: result.refused,
    }),
  )
  return result
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name)
  const v = i >= 0 ? args[i + 1] : undefined
  if (!v) throw new Error(`missing ${name}`)
  return v
}

function optional(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const existing = optional(args, "--existing")
  const result = await signShellManifests({
    a: resolve(flag(args, "--a")),
    b: resolve(flag(args, "--b")),
    commit: flag(args, "--commit"),
    seq: Number(flag(args, "--seq")),
    liaisonVersion: flag(args, "--liaison-version"),
    keyPath: flag(args, "--key"),
    out: resolve(flag(args, "--out")),
    existing: existing ? resolve(existing) : undefined,
  })
  for (const s of result.signed) {
    console.log(
      `signed shell/${s.mode}/${s.buildId}${s.resigned ? " (the host's statement.json)" : ""}`,
    )
  }
  for (const s of result.skipped)
    console.log(`skipped shell/${s.mode}/${s.buildId}: already signed`)
  for (const [mode, why] of Object.entries(result.refused)) console.log(`REFUSED ${mode}: ${why}`)
  // Exit 0 with a refusal on record: the publish job publishes the other mode,
  // then fails on result.json's refusals.
}
