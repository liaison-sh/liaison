// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bundled-app version guard (`bun run check:bundled-app-version [--base <ref>]`).
//
// A bundled app whose source changed must raise `version` in its
// app.manifest.json. An installed version directory is never rewritten
// (apps/api/src/modules/apps/version-dir.ts: old and new processes share it
// during a rolling deploy), so an image that carries other files under a version
// already installed fails the catalog reconcile of its `migrate` step, and the
// deploy stops there. The UI bundle is also served at a version-keyed immutable
// URL, so browsers would keep the old one.
//
// A package also carries code from outside its directory: the bundlers inline
// the workspace packages it imports (`packages/app-sdk`, `packages/app-ui`, ...;
// scripts/check-bundled-app-purity.ts keeps every other import out). When files
// under `packages/` changed, each app whose package they reach (the `sources`
// scripts/freeze-app.ts reports) is frozen twice: as it is, and with those files
// at their base contents (served to the bundlers, the tree is not touched). The
// app changed when the two packages differ, so a shared change the bundler drops
// from an app (tree-shaken code) asks for no bump. When the second freeze cannot
// be made (a file new or deleted since the base that it needs, a JSX file of a
// UI bundle), the app counts as changed.
//
// The base is `--base`, else `origin/$GITHUB_BASE_REF`; without either (a push to
// main) the check is skipped. Paths the source digest leaves out
// (scripts/app-signing/source-digest.ts: build output, installs, logs) and test
// files do not count.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { freezeApp } from "./freeze-app"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
  ".vite",
  "test-results",
  "logs",
  ".chaos",
  ".DS_Store",
  "bun.lock",
])

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? "" }
}

/** Test files never reach the package, so a test-only change keeps its version. */
function counts(path: string): boolean {
  const parts = path.split("/")
  if (parts.some((p) => IGNORED_SEGMENTS.has(p) || p.endsWith(".log") || p === "__tests__"))
    return false
  return !/\.test\.[cm]?[jt]sx?$/.test(parts.at(-1) ?? "")
}

function versionAt(root: string, ref: string | null, app: string): string | null {
  const file = `bundled-apps/${app}/app.manifest.json`
  let raw: string
  if (ref) {
    const r = git(root, ["show", `${ref}:${file}`])
    if (!r.ok) return null
    raw = r.out
  } else {
    if (!existsSync(join(root, file))) return null
    raw = readFileSync(join(root, file), "utf8")
  }
  try {
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === "string" ? v : null
  } catch {
    return null
  }
}

function newer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return !a.includes("-") && b.includes("-")
}

export interface VersionIssue {
  app: string
  base: string
  head: string | null
  files: string[]
}

/**
 * Freeze `app` as the tree holds it, or with `overrides` (repo path → contents) in place of
 * those files: the package's bytes and the repo files it was made from (repo-relative).
 */
export type FreezePackage = (
  root: string,
  app: string,
  overrides?: ReadonlyMap<string, string>,
) => Promise<{ bytes: Uint8Array; sources: string[] }>

/** The real packager, into a scratch directory. */
export const freezePackage: FreezePackage = async (root, app, overrides) => {
  const outDir = mkdtempSync(join(tmpdir(), `bundled-version-${app}-`))
  try {
    const { tarballPath, sources } = await freezeApp({
      appName: app,
      repoRoot: root,
      appDir: join(root, "bundled-apps", app),
      outDir,
      sourceOverrides: overrides,
    })
    return { bytes: new Uint8Array(readFileSync(tarballPath)), sources }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Apps changed in `<base>...HEAD` (and in the working tree) whose version was not raised.
 * A changed file is an app's own file under `bundled-apps/<app>/`, or a workspace package
 * file (`packages/...`) whose change reaches the app's package (see the header).
 */
export async function checkBundledAppVersions(
  root: string,
  base: string,
  freeze: FreezePackage = freezePackage,
): Promise<VersionIssue[]> {
  const committed = git(root, ["diff", "--name-only", `${base}...HEAD`])
  if (!committed.ok) throw new Error(`git diff ${base}...HEAD failed`)
  const local = git(root, ["diff", "--name-only", "HEAD"])
  const changed = new Map<string, string[]>()
  const add = (app: string, file: string) => {
    const list = changed.get(app) ?? []
    if (!list.includes(file)) list.push(file)
    changed.set(app, list)
  }
  const shared = new Set<string>()
  for (const raw of `${committed.out}\n${local.out}`.split("\n")) {
    const path = raw.trim()
    const m = /^bundled-apps\/([^/]+)\/(.+)$/.exec(path)
    if (m) {
      if (counts(m[2])) add(m[1], m[2])
    } else if (path.startsWith("packages/") && counts(path)) {
      shared.add(path)
    }
  }
  if (shared.size > 0) {
    // The shared files as they were on the base; one deleted since cannot be served.
    const before = new Map<string, string>()
    for (const path of shared) {
      const r = git(root, ["show", `${base}:${path}`])
      if (r.ok) before.set(path, r.out)
    }
    const appsRoot = join(root, "bundled-apps")
    const apps = existsSync(appsRoot) ? readdirSync(appsRoot).sort() : []
    for (const app of apps) {
      // Only an app that exists on both sides can keep a version it should have raised;
      // one whose own files changed is already counted.
      if (changed.has(app) || !versionAt(root, base, app) || !versionAt(root, null, app)) continue
      const now = await freeze(root, app)
      const reached = now.sources.filter((s) => shared.has(s))
      if (reached.length === 0) continue
      let differs = true
      try {
        differs = !sameBytes(now.bytes, (await freeze(root, app, before)).bytes)
      } catch {
        // The package cannot be made with the base contents: count it as changed.
      }
      if (differs) for (const source of reached) add(app, source)
    }
  }
  const issues: VersionIssue[] = []
  for (const [app, files] of changed) {
    const before = versionAt(root, base, app)
    if (!before) continue // a new app
    const after = versionAt(root, null, app)
    if (after === null) continue // the app was removed
    if (!newer(after, before)) issues.push({ app, base: before, head: after, files })
  }
  return issues
}

export async function main(
  argv: string[],
  env = process.env,
  root = ROOT,
  freeze: FreezePackage = freezePackage,
): Promise<number> {
  const at = argv.indexOf("--base")
  const base =
    at !== -1 && argv[at + 1]
      ? argv[at + 1]
      : env.GITHUB_BASE_REF
        ? `origin/${env.GITHUB_BASE_REF}`
        : undefined
  if (!base) {
    console.log(
      "[check-bundled-app-version] skipped (no base: pass --base <ref> or set GITHUB_BASE_REF)",
    )
    return 0
  }
  const issues = await checkBundledAppVersions(root, base, freeze)
  if (issues.length === 0) {
    console.log(
      `[check-bundled-app-version] ok: every changed bundled app raised its version vs ${base}`,
    )
    return 0
  }
  for (const i of issues) {
    console.error(
      `[check-bundled-app-version] the package of bundled-apps/${i.app} changed (${i.files.slice(0, 5).join(", ")}${i.files.length > 5 ? ", ..." : ""}) but its version is ${i.head} (was ${i.base} on ${base}). Raise "version" in bundled-apps/${i.app}/app.manifest.json (and its manifest.test.ts): an installed version directory is never rewritten, so the same version with other files fails the deploy's migrate step.`,
    )
  }
  return 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
