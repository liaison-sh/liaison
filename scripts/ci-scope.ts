#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/ci-scope.ts scope|biome|typecheck [--base <ref>] [--all] [--tool tsgo|tsc]`
//
// What a pull request has to check, and the checks themselves run on that
// scope. A pull request (GITHUB_BASE_REF set, or --base given) is scoped to the
// files it changes against the merge base; anything else (a push to main, a
// local run without --base, --all) checks everything.
//
//   scope      prints the scope; under Actions, writes `docs=true|false` to
//              $GITHUB_OUTPUT so the docs step can be skipped.
//   biome      Biome on the changed files (all files on a full run).
//   typecheck  every TypeScript project whose program contains a changed file.
//              The program is the project's own file list (`tsgo --listFilesOnly`),
//              so imports across packages, path aliases and relative reaches
//              into another package are all followed exactly; no hand-kept graph.
//              --tool tsgo (default) or tsc. Both are incremental: tsc keeps its
//              build info at the path in the project's tsconfig, tsgo beside it in
//              <name>.tsgo.tsbuildinfo (the formats differ, they must not share a file).
//
// Anything that can change every program or every lint result falls back to a
// full run: a package.json, the lockfile, a tsconfig, the Biome config, the CI
// workflow, this script. So does a deleted TypeScript file (resolution may now
// pick a different, unchanged file).

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { DOCS_EXEMPT, DOCS_FAILSAFE_ROOTS, DOCS_MAP } from "../.claude/docs-map"

const ROOT = resolve(import.meta.dir, "..")

/** Changes that make every check run in full. */
export const FULL_RUN_GLOBS = [
  "package.json",
  "**/package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig*.json",
  "**/tsconfig*.json",
  "biome.json",
  "biome.jsonc",
  ".github/workflows/**",
  "scripts/ci-scope.ts",
]

/** Files that can be part of a TypeScript program. */
const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/

/** Sources the docs check reads beyond the docs map: its own code, the docs
 * themselves and the generated reference pages' inputs (api sources, app manifests). */
const DOCS_SOURCE_GLOBS = [
  "docs/**",
  "scripts/docs/**",
  "scripts/check-docs.ts",
  ".claude/docs-map.ts",
  "apps/api/src/**",
  "bundled-apps/*/app.manifest.json",
]
const TEST_FILE =
  /(\.test\.tsx?$|\.testutil\.ts$|(^|\/)(tests|__fixtures__|fixtures|__snapshots__|test-support|__test-helpers__)\/)/

export type Change = { status: string; path: string }

export type Scope = {
  full: boolean
  reason: string
  base?: string
  changed: Change[]
  /** Existing changed files for Biome; ignored when `full`. */
  biomeFiles: string[]
  /** True when a changed file can reach a TypeScript program; ignored when `full`. */
  typescript: boolean
  /** Deleted TypeScript files force every project to check. */
  typescriptAll: boolean
  docs: boolean
}

function match(glob: string, file: string): boolean {
  return new Bun.Glob(glob).match(file)
}

export function docsRelevant(file: string): boolean {
  if (DOCS_SOURCE_GLOBS.some((g) => match(g, file))) {
    return !(file.startsWith("apps/api/src/") && TEST_FILE.test(file))
  }
  if (DOCS_MAP.some((e) => match(e.glob, file))) return true
  // A file under a fail-safe root that no entry maps or exempts fails the docs
  // check: the check has to run to say so.
  return (
    DOCS_FAILSAFE_ROOTS.some((r) => file.startsWith(r)) &&
    !DOCS_EXEMPT.some((e) => match(e.glob, file))
  )
}

export function classify(changed: Change[], base?: string): Scope {
  const empty = { changed, biomeFiles: [], typescript: false, typescriptAll: false }
  if (!base) return { ...empty, full: true, reason: "not a pull request", docs: true }
  const trigger = changed.find((c) => FULL_RUN_GLOBS.some((g) => match(g, c.path)))
  if (trigger) {
    return { ...empty, base, full: true, reason: `${trigger.path} changed`, docs: true }
  }
  const live = changed.filter((c) => c.status !== "D")
  return {
    full: false,
    reason: `${changed.length} changed files`,
    base,
    changed,
    biomeFiles: live.map((c) => c.path),
    typescript: live.some((c) => TS_LIKE.test(c.path)),
    typescriptAll: changed.some((c) => c.status === "D" && TS_LIKE.test(c.path)),
    docs: changed.some((c) => docsRelevant(c.path)),
  }
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`)
  return r.stdout
}

export function changedFiles(base: string): Change[] {
  // Three dots: against the merge base, so commits on the base branch since the
  // PR branched are not counted. No rename detection: a rename is a delete and an add.
  return git(["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t")
      return { status: status.charAt(0), path }
    })
}

function resolveBase(argv: string[], env = process.env): string | undefined {
  if (argv.includes("--all")) return undefined
  const at = argv.indexOf("--base")
  if (at !== -1 && argv[at + 1]) return argv[at + 1]
  return env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_BASE_REF
    ? `origin/${env.GITHUB_BASE_REF}`
    : undefined
}

export function computeScope(argv: string[]): Scope {
  const base = resolveBase(argv)
  return classify(base ? changedFiles(base) : [], base)
}

// ── TypeScript projects ───────────────────────────────────────────────────

export type Project = { dir: string; tsconfig: string }

/** Every workspace package with a `typecheck` script, plus scripts/. */
export function projects(root: string = ROOT): Project[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: string[]
  }
  const dirs: string[] = []
  for (const pattern of pkg.workspaces) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2)
      for (const d of readdirSync(join(root, parent)).sort()) dirs.push(`${parent}/${d}`)
    } else dirs.push(pattern)
  }
  const out: Project[] = []
  for (const dir of [...new Set(dirs)].sort()) {
    const manifest = join(root, dir, "package.json")
    if (!existsSync(manifest) || !existsSync(join(root, dir, "tsconfig.json"))) continue
    const scripts = (JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {}) as Record<
      string,
      string
    >
    if (scripts.typecheck) out.push({ dir, tsconfig: `${dir}/tsconfig.json` })
  }
  out.push({ dir: "scripts", tsconfig: "scripts/tsconfig.json" })
  return out
}

function bin(name: string): string {
  return join(ROOT, "node_modules/.bin", name)
}

/** The project's buildinfo for `tool`: tsc's from its tsconfig, tsgo's beside it. */
function buildInfoArgs(p: Project, tool: "tsc" | "tsgo"): string[] {
  if (tool === "tsc") return []
  const config = readFileSync(join(ROOT, p.tsconfig), "utf8")
  const m = config.match(/"tsBuildInfoFile"\s*:\s*"([^"]+)\.tsbuildinfo"/)
  if (!m)
    throw new Error(`${p.tsconfig} sets no tsBuildInfoFile: typecheck is incremental everywhere`)
  return ["--incremental", "--tsBuildInfoFile", resolve(ROOT, p.dir, `${m[1]}.tsgo.tsbuildinfo`)]
}

export function programFiles(p: Project): Set<string> {
  const r = spawnSync(bin("tsgo"), ["-p", join(ROOT, p.tsconfig), "--listFilesOnly"], {
    cwd: join(ROOT, p.dir),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`listing ${p.tsconfig} failed: ${r.stderr || r.stdout}`)
  return new Set(
    r.stdout
      .split("\n")
      .filter((f) => f && !f.includes("/node_modules/"))
      .map((f) => relative(ROOT, resolve(ROOT, p.dir, f))),
  )
}

export function selectProjects(scope: Scope, all: Project[] = projects()): Project[] {
  if (scope.full || scope.typescriptAll) return all
  if (!scope.typescript) return []
  const touched = scope.changed.filter((c) => c.status !== "D").map((c) => c.path)
  return all.filter((p) => {
    const files = programFiles(p)
    return touched.some((f) => files.has(f))
  })
}

function run(cmd: string[], cwd = ROOT): number {
  console.log(
    `$ ${cmd.map((c) => relative(ROOT, c) || c).join(" ")}  (in ${relative(ROOT, cwd) || "."})`,
  )
  return spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" }).status ?? 1
}

function describe(scope: Scope): string {
  if (scope.full) return `full run (${scope.reason})`
  return `${scope.reason} vs ${scope.base}`
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv
  const scope = computeScope(argv)
  if (command === "scope") {
    console.log(`scope: ${describe(scope)}`)
    console.log(
      `docs check: ${scope.docs ? "runs" : "skipped (no file the docs check reads changed)"}`,
    )
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `docs=${scope.docs}\n`)
    }
    return 0
  }
  if (command === "biome") {
    if (scope.full) return run([bin("biome"), "check", "."])
    if (scope.biomeFiles.length === 0) {
      console.log(`biome: no changed files (${describe(scope)})`)
      return 0
    }
    console.log(`biome: ${scope.biomeFiles.length} changed files (${describe(scope)})`)
    return run([
      bin("biome"),
      "check",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
      ...scope.biomeFiles,
    ])
  }
  if (command === "typecheck") {
    const at = argv.indexOf("--tool")
    const tool = (at !== -1 ? argv[at + 1] : "tsgo") as "tsc" | "tsgo"
    if (tool !== "tsc" && tool !== "tsgo")
      throw new Error(`--tool must be tsc or tsgo, not ${tool}`)
    const all = projects()
    const selected = selectProjects(scope, all)
    const skipped = all.filter((p) => !selected.includes(p)).map((p) => p.dir)
    console.log(
      `typecheck (${tool}): ${selected.length}/${all.length} projects (${describe(scope)})` +
        (skipped.length > 0
          ? `; skipped, no changed file in their program: ${skipped.join(", ")}`
          : ""),
    )
    let failed = 0
    for (const p of selected) {
      const cmd = [bin(tool), "--noEmit", "-p", join(ROOT, p.tsconfig), ...buildInfoArgs(p, tool)]
      if (run(cmd, join(ROOT, p.dir)) !== 0) failed++
    }
    return failed === 0 ? 0 : 1
  }
  console.error(
    "Usage: bun run scripts/ci-scope.ts scope|biome|typecheck [--base <ref>] [--all] [--tool tsgo|tsc]",
  )
  return 2
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
