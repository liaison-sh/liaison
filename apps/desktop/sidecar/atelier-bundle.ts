// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BUNDLED ATELIER (P2-T12; S38, A14, A33, D4).
//
// The desktop ships atelier-cc (MIT) at a pinned tag, vendored by
// scripts/vendor-atelier.ts into vendor/atelier/ with VERSION and
// MANIFEST.json (path -> sha256). The compiled sidecar embeds every vendored
// file (build.ts writes vendor/atelier.embed.gen.ts, the CLI's own
// `with { type: "file" }` pattern) and registers them here before main runs;
// from source, the files are read from vendor/atelier/ itself.
//
// On use, the tree is extracted to `<appDataDir>/atelier/<tag>/`, rewritten
// whole when any file is missing or its sha256 differs (written to a temp dir,
// then renamed in), with every file that starts with a shebang made 0755 (the
// hooks are run as commands).
//
// Who gets it: owner-config sessions only, never an isolated run (A14). The
// owner's own Atelier wins (D4): when the session's effective settings enable
// any `atelier@<marketplace>`, nothing is added (atelierSource "user"); when
// they name one switched off, nothing either (D41, atelierSource "none").

import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

export type AtelierSource = "bundled" | "user" | "none"
export type AtelierHooks = "ok" | "bash<4" | "no jq"

export interface AtelierEmbedFile {
  /** The file's path inside the plugin. */
  path: string
  /** Where its bytes are read from: the vendored file, or its `$bunfs` copy. */
  source: string
  /** Its sha256 as MANIFEST.json records it. */
  sha256: string
}

export interface AtelierEmbed {
  /** VERSION's first word: the tag (`v0.4.0`). */
  version: string
  /** VERSION's second word: the tag's commit. */
  commit: string
  files: AtelierEmbedFile[]
}

export const ATELIER_VENDOR_DIR = path.join(import.meta.dir, "vendor", "atelier")
const ATELIER_PLUGIN_ID = /^atelier@[^@]+$/

let registered: AtelierEmbed | null = null

/**
 * The compiled entry registers the embedded files (build.ts writes the call).
 * @public
 */
export function registerEmbeddedAtelier(embed: AtelierEmbed): void {
  registered = embed
}

/** VERSION and MANIFEST.json of a vendored tree, as an embed reading the files in place. */
export function vendoredAtelier(dir: string = ATELIER_VENDOR_DIR): AtelierEmbed {
  const [version, commit] = readFileSync(path.join(dir, "VERSION"), "utf8").trim().split(/\s+/)
  if (!version || !commit) throw new Error(`${dir}/VERSION names no tag and commit`)
  const manifest = JSON.parse(readFileSync(path.join(dir, "MANIFEST.json"), "utf8")) as Record<
    string,
    string
  >
  return {
    version,
    commit,
    files: Object.entries(manifest).map(([rel, sha256]) => ({
      path: rel,
      source: path.join(dir, rel),
      sha256,
    })),
  }
}

/** The embed this process ships: the registered one, else the vendored tree. */
export function shippedAtelier(): AtelierEmbed {
  return registered ?? vendoredAtelier()
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function safeRel(rel: string): boolean {
  return (
    rel.length > 0 &&
    !path.isAbsolute(rel) &&
    !rel.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
}

/**
 * D44: the extracted tree is exactly the manifest: the same regular files and
 * the folders that hold them, no link (symbolic, or a hard link: a file with
 * a second name), nothing more (a file the session or anything else planted
 * makes it not intact), and every file's sha256.
 *
 * The file tools never write the bundle at any level, and the sandbox denies
 * it to Bash below Open. Bash at Open runs without a sandbox, so it (or any
 * process running as the owner) can rewrite the bundle; this check, run
 * before every session start, finds that and extracts the tree again, so the
 * next session always starts on the shipped bytes.
 */
function intact(dir: string, embed: AtelierEmbed): boolean {
  const files = new Set(embed.files.map((f) => f.path))
  const dirs = new Set<string>()
  for (const f of files) {
    for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) dirs.add(d)
  }
  const walk = (rel: string): boolean => {
    let names: string[]
    try {
      names = readdirSync(rel ? path.join(dir, rel) : dir)
    } catch {
      return false
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(path.join(dir, child))
      } catch {
        return false
      }
      if (st.isDirectory()) {
        if (!dirs.has(child) || !walk(child)) return false
      } else if (!st.isFile() || !files.has(child) || st.nlink !== 1) {
        // Batch-2 F6: a hard link is a second name someone can write through.
        return false
      }
    }
    return true
  }
  try {
    if (!lstatSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  if (!walk("")) return false
  for (const f of embed.files) {
    try {
      if (sha256(readFileSync(path.join(dir, f.path))) !== f.sha256) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * The bundled plugin's directory, extracted under the app's data dir when
 * absent or altered. An embedded file whose bytes do not match the manifest
 * is refused (nothing is extracted).
 */
export function ensureBundledAtelier(
  dataDir: string,
  embed: AtelierEmbed = shippedAtelier(),
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(embed.version)) {
    throw new Error(`the bundled Atelier's version ${JSON.stringify(embed.version)} is not a name`)
  }
  const parent = path.join(dataDir, "atelier")
  const dir = path.join(parent, embed.version)
  if (existsSync(dir) && intact(dir, embed)) return dir
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const tmp = path.join(parent, `.tmp-${randomBytes(6).toString("hex")}`)
  try {
    for (const f of embed.files) {
      if (!safeRel(f.path)) throw new Error(`the bundled Atelier names an unsafe path ${f.path}`)
      const bytes = readFileSync(f.source)
      if (sha256(bytes) !== f.sha256) {
        throw new Error(`the bundled Atelier's ${f.path} does not match its manifest`)
      }
      const out = path.join(tmp, f.path)
      mkdirSync(path.dirname(out), { recursive: true })
      const exec = bytes[0] === 0x23 && bytes[1] === 0x21 // "#!"
      writeFileSync(out, bytes, { mode: exec ? 0o755 : 0o644 })
      chmodSync(out, exec ? 0o755 : 0o644)
    }
    const old = existsSync(dir) ? path.join(parent, `.old-${randomBytes(6).toString("hex")}`) : null
    if (old) renameSync(dir, old)
    renameSync(tmp, dir)
    if (old) rmSync(old, { recursive: true, force: true })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return dir
}

/**
 * The owner's own Atelier as the session's effective settings name it in
 * `enabledPlugins`: any `atelier@<marketplace>` set to true is "enabled" (D4:
 * it wins); one named but not true is "disabled" (D41: installed and switched
 * off, so no bundled copy either); none named is "absent".
 */
export function ownerAtelier(settingsFile: string): "enabled" | "disabled" | "absent" {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsFile, "utf8"))
  } catch {
    return "absent"
  }
  const plugins = (raw as { enabledPlugins?: unknown } | null)?.enabledPlugins
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return "absent"
  const named = Object.entries(plugins).filter(([id]) => ATELIER_PLUGIN_ID.test(id))
  if (named.some(([, on]) => on === true)) return "enabled"
  return named.length > 0 ? "disabled" : "absent"
}

/** Whether the session's effective settings enable the owner's own Atelier. */
export function settingsEnableAtelier(settingsFile: string): boolean {
  return ownerAtelier(settingsFile) === "enabled"
}

/**
 * S38: which Atelier a session gets, before any extraction. The bundled copy
 * loads only when the owner has no Atelier install at all (D41).
 */
export function atelierSourceFor(args: {
  configKind: "owner" | "isolated"
  settingsFile: string
}): AtelierSource {
  if (args.configKind !== "owner") return "none"
  const owner = ownerAtelier(args.settingsFile)
  return owner === "enabled" ? "user" : owner === "disabled" ? "none" : "bundled"
}

const hooksByPath = new Map<string, AtelierHooks>()

/**
 * GF-53: Atelier's hooks need bash 4 or later and jq on the session's PATH.
 * Measured once per PATH.
 */
export function atelierHooksStatus(
  pathValue: string,
  run: (cmd: string[], env: Record<string, string>) => { exitCode: number; stdout: string } = (
    cmd,
    env,
  ) => {
    try {
      const r = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "ignore" })
      return { exitCode: r.exitCode, stdout: r.stdout.toString() }
    } catch {
      return { exitCode: 127, stdout: "" }
    }
  },
): AtelierHooks {
  const known = hooksByPath.get(pathValue)
  if (known) return known
  const env = { PATH: pathValue }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
  const bash = run(["bash", "-c", "echo ${BASH_VERSINFO[0]}"], env)
  const major = bash.exitCode === 0 ? Number.parseInt(bash.stdout.trim(), 10) : Number.NaN
  let status: AtelierHooks
  if (!(major >= 4)) status = "bash<4"
  else status = run(["bash", "-c", "command -v jq"], env).exitCode === 0 ? "ok" : "no jq"
  hooksByPath.set(pathValue, status)
  return status
}
