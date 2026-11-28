// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sign the shell statements of one commit from the file manifests of two
// independent builds (build-manifest.ts), never from a build of its own.
//
// It runs where the signing key is, so it builds nothing, installs nothing and
// imports only the signing code (packages/shared/src/app-signing, the key
// loader of scripts/app-signing/sign-artifact.ts). For each mode it refuses
// unless:
//   - both manifests parse, with exactly the manifest's keys,
//   - their canonical JSON is byte-identical (same build id, same files, same
//     hashes, same bridge ranges and settings schema),
//   - they name the commit and seq given here (the signer reads those from the
//     forge, not from either builder).
// Then it writes `<out>/<mode>/<buildId>/statement.json` (canonical JSON) and
// `statement.sig` (base64 Ed25519), and verifies its own output with the
// public half and the compiled shell floor before returning.
//
// Usage:
//   bun scripts/shell-signing/sign-statement.ts --a <dir> --b <dir>
//     --commit <40 hex> --seq <unix seconds> --key <pem> --out <dir>
// <dir> holds shell-manifest-desktop.json and shell-manifest-native.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  keyPath: string
  out: string
  /** Defaults to now. */
  issuedAt?: string
}

export interface SignedShell {
  mode: ShellMode
  buildId: string
  dir: string
}

function readManifest(dir: string, mode: ShellMode, builder: string): ShellManifest {
  const path = join(dir, manifestFileName(mode))
  const manifest = parseShellManifest(readFileSync(path, "utf8"))
  if (!manifest) throw new Error(`${builder} ${mode}: not a shell manifest (${path})`)
  if (manifest.mode !== mode)
    throw new Error(`${builder} ${mode}: the manifest says ${manifest.mode}`)
  return manifest
}

export async function signShellManifests(input: SignInput): Promise<SignedShell[]> {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error("--commit: not a 40-hex sha")
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error("--seq: not a count")
  const pairs = SHELL_MODES.map((mode) => {
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
    return a
  })
  const key = await loadPrivateKey(input.keyPath)
  const issuedAt = input.issuedAt ?? new Date().toISOString()
  const signed: SignedShell[] = []
  for (const manifest of pairs) {
    const statement: ShellStatement = {
      v: 1,
      kind: "shell",
      keyId: key.keyId,
      issuedAt,
      ...manifest,
    }
    const bytes = shellStatementBytes(statement)
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
    if (!check.ok)
      throw new Error(`${manifest.mode}: own statement does not verify (${check.reason})`)
    const dir = join(input.out, manifest.mode, manifest.buildId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "statement.json"), bytes)
    writeFileSync(join(dir, "statement.sig"), sigText)
    signed.push({ mode: manifest.mode, buildId: manifest.buildId, dir })
  }
  return signed
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name)
  const v = i >= 0 ? args[i + 1] : undefined
  if (!v) throw new Error(`missing ${name}`)
  return v
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const signed = await signShellManifests({
    a: resolve(flag(args, "--a")),
    b: resolve(flag(args, "--b")),
    commit: flag(args, "--commit"),
    seq: Number(flag(args, "--seq")),
    keyPath: flag(args, "--key"),
    out: resolve(flag(args, "--out")),
  })
  for (const s of signed) console.log(`signed shell/${s.mode}/${s.buildId}`)
}
