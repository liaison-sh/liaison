// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The file manifest of one apps/web build, the input of a signed shell
// statement (packages/shared/src/app-signing/shell-statement.ts).
//
// Two independent builders run this over their own build of the same commit
// and the signer signs only when both manifests are byte-identical, so it holds
// nothing a builder chooses: the mode, the build id, the commit and its
// committer time (`seq`), the release name, the bridge ranges and settings
// schema version compiled from the source, and the sha256 of EVERY file under
// the build root (the files a client fetches and checks).
//
// The build id is read from build-id.txt and recomputed here with the Vite
// plugin's own rule (apps/web/src/lib/web-build-id-plugin.ts): the plugin hashes
// the files Rollup emitted, before it writes the id into the HTML pages, so the
// files Vite copies from apps/web/public, the app frame files written after the
// build (apps/web/scripts/build-app-frame.ts) and build-id.txt itself are left
// out, and the id is put back to its placeholder in every HTML page.
//
// Usage:
//   bun scripts/shell-signing/build-manifest.ts <desktop|native> <distDir>
//     [--commit <40 hex>] [--seq <unix seconds>] [--liaison-version <name>]
//     [--out <file>]
// commit and seq default to `git log -1` in the current directory; the release
// name to $LIAISON_VERSION, else "dev". Prints the canonical JSON (or writes it
// to --out).
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  APP_FRAME_DOCUMENT_FILE,
  APP_FRAME_RUNTIME_FILE,
} from "../../apps/web/scripts/build-app-frame"
import { SHELL_BRIDGE_RANGE } from "../../apps/web/src/lib/shell-bridge-range"
import {
  computeWebBuildId,
  WEB_BUILD_ID_FILE,
  WEB_BUILD_ID_TOKEN,
} from "../../apps/web/src/lib/web-build-id-plugin"
import { SETTINGS_SCHEMA_VERSION } from "../../packages/app-sdk/src/app-settings"
import { sha256Hex } from "../../packages/shared/src/app-signing/encoding"
import {
  isShellFilePath,
  isShellMode,
  type ShellBridgeRanges,
  type ShellMode,
} from "../../packages/shared/src/app-signing/shell-statement"
import { canonicalJson } from "../../packages/shared/src/app-signing/statement"

export const WEB_PUBLIC_DIR = resolve(import.meta.dir, "../../apps/web/public")

export interface ShellManifest {
  mode: ShellMode
  buildId: string
  commit: string
  seq: number
  liaisonVersion: string
  bridge: ShellBridgeRanges
  settingsSchema: number
  files: Record<string, string>
}

/** Every regular file under `root`, relative, `/`-separated, in code-unit order. */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) throw new Error(`${rel}: a symbolic link in the build`)
      if (st.isDirectory()) walk(abs, rel)
      else if (st.isFile()) out.push(rel)
      else throw new Error(`${rel}: not a regular file`)
    }
  }
  walk(root, "")
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The build id the Vite plugin computed for this dist, recomputed from the
 * files on disk. `notBundled` = the paths Rollup did not emit.
 */
export function recomputeBuildId(
  files: ReadonlyMap<string, Uint8Array>,
  id: string,
  notBundled: ReadonlySet<string>,
): string {
  const decoder = new TextDecoder()
  const bundle: Record<string, { type: "asset"; fileName: string; source: string | Uint8Array }> =
    {}
  for (const [path, bytes] of files) {
    if (path === WEB_BUILD_ID_FILE || notBundled.has(path)) continue
    const source = path.endsWith(".html")
      ? decoder.decode(bytes).split(id).join(WEB_BUILD_ID_TOKEN)
      : bytes
    bundle[path] = { type: "asset", fileName: path, source }
  }
  return computeWebBuildId(bundle)
}

export interface ManifestInput {
  mode: ShellMode
  distDir: string
  commit: string
  seq: number
  liaisonVersion: string
  /** apps/web/public, whose files Vite copies into the dist unhashed. */
  publicDir?: string
}

export async function buildShellManifest(input: ManifestInput): Promise<ShellManifest> {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error("commit: not a 40-hex sha")
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error("seq: not a count")
  if (input.liaisonVersion.length === 0) throw new Error("liaison version: empty")
  const paths = listFiles(input.distDir)
  const bytes = new Map<string, Uint8Array>()
  for (const p of paths) {
    if (!isShellFilePath(p)) throw new Error(`${p}: not a shell file path`)
    bytes.set(p, new Uint8Array(readFileSync(join(input.distDir, p))))
  }
  const idBytes = bytes.get(WEB_BUILD_ID_FILE)
  if (!idBytes) throw new Error(`${WEB_BUILD_ID_FILE}: missing from the build`)
  const buildId = new TextDecoder().decode(idBytes).trim()
  if (!/^[0-9a-f]{16}$/.test(buildId)) throw new Error(`${WEB_BUILD_ID_FILE}: not a build id`)
  if (!bytes.has("index.html")) throw new Error("index.html: missing from the build")
  const publicDir = input.publicDir ?? WEB_PUBLIC_DIR
  const notBundled = new Set<string>([
    APP_FRAME_RUNTIME_FILE,
    APP_FRAME_DOCUMENT_FILE,
    ...(existsSync(publicDir) ? listFiles(publicDir) : []),
  ])
  const recomputed = recomputeBuildId(bytes, buildId, notBundled)
  if (recomputed !== buildId) {
    throw new Error(
      `${WEB_BUILD_ID_FILE} says ${buildId} but the files hash to ${recomputed} under the build id rule`,
    )
  }
  const files: Record<string, string> = {}
  for (const [p, b] of bytes) files[p] = await sha256Hex(b)
  return {
    mode: input.mode,
    buildId,
    commit: input.commit,
    seq: input.seq,
    liaisonVersion: input.liaisonVersion,
    bridge: { ...SHELL_BRIDGE_RANGE },
    settingsSchema: SETTINGS_SCHEMA_VERSION,
    files,
  }
}

/** The bytes two builders compare: canonical JSON, keys sorted, no whitespace. */
export function manifestBytes(manifest: ShellManifest): string {
  return canonicalJson(manifest)
}

function gitHead(): { commit: string; seq: number } {
  const r = spawnSync("git", ["log", "-1", "--format=%H %ct"], { encoding: "utf8" })
  const [commit = "", ct = ""] = (r.stdout ?? "").trim().split(" ")
  if (r.status !== 0 || !commit) throw new Error("no --commit/--seq given and no git history here")
  return { commit, seq: Number.parseInt(ct, 10) }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const [mode, distDir] = args
  if (!isShellMode(mode) || !distDir) {
    console.error(
      "usage: build-manifest.ts <desktop|native> <distDir> [--commit <sha>] [--seq <n>] [--liaison-version <v>] [--out <file>]",
    )
    process.exit(2)
  }
  const commitFlag = flag(args, "--commit")
  const seqFlag = flag(args, "--seq")
  const head = commitFlag && seqFlag ? null : gitHead()
  const manifest = await buildShellManifest({
    mode,
    distDir: resolve(distDir),
    commit: commitFlag ?? head?.commit ?? "",
    seq: seqFlag ? Number(seqFlag) : (head?.seq ?? -1),
    liaisonVersion: flag(args, "--liaison-version") ?? process.env.LIAISON_VERSION ?? "dev",
  })
  const out = flag(args, "--out")
  if (out) writeFileSync(out, manifestBytes(manifest))
  else process.stdout.write(`${manifestBytes(manifest)}\n`)
}
