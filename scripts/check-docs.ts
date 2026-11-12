// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Docs guard (`bun run check:docs [--base <ref>]`). Four rules:
 *
 *   1. Freshness: the generated reference pages (docs/reference/*) match
 *      `bun run docs:gen`.
 *   2. Nav integrity: every page in docs/nav.ts has a file, every docs page
 *      is in the nav, every page id in .claude/docs-map.ts is in the nav, the
 *      docs build succeeds (broken links fail), and every authored page has
 *      its sources sidecar `docs/.sources/<id>.txt`.
 *   3. Coverage: every shipped app has its page; every CLI command, manifest
 *      settings key and manifest scope appears verbatim in at least one
 *      hand-written page (docs/reference/* does not count); every env var is
 *      in the generated reference/env page. Each group must collect at least
 *      one item, or its extractor is broken.
 *   4. Diff rule: a changed file mapped in .claude/docs-map.ts needs one of
 *      its pages changed in the same range (a generated page counts only when
 *      its file changed, i.e. it was regenerated), unless a `Docs-skip: <reason>`
 *      line is in the PR body (`PR_BODY`) or a commit message of the range.
 *      The base is `--base`, else `origin/$GITHUB_BASE_REF`; without either
 *      (a push to main) the rule is skipped.
 *
 * Exit 0 when every rule passes, 1 otherwise.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DOCS_EXEMPT, DOCS_FAILSAFE_ROOTS, DOCS_MAP } from "../.claude/docs-map"
import { COMMANDS } from "../apps/api/src/cli/commands"
import { LANDING, NAV, type NavPage, type NavSection } from "../docs/nav"
import { buildDocs, DocsBuildError } from "./docs/build"
import {
  collectAppScopes,
  collectEnvVars,
  collectManifestSettings,
  generateAll,
  loadManifests,
  ROOT,
  writeOrCheck,
} from "./docs/gen-reference"

export interface DocsMapConfig {
  map: { glob: string; pages: string[] }[]
  exempt: { glob: string; reason: string }[]
  failsafeRoots: string[]
}

export interface Nav {
  landing: NavPage
  sections: NavSection[]
}

export interface RuleResult {
  rule: string
  ok: boolean
  /** One line of counts. */
  summary: string
  problems: string[]
  notes: string[]
  skipped?: boolean
}

export const REAL_CONFIG: DocsMapConfig = {
  map: DOCS_MAP,
  exempt: DOCS_EXEMPT,
  failsafeRoots: DOCS_FAILSAFE_ROOTS,
}

/** Markdown files under docs/ that are not pages (paths relative to docs/). */
export const DOCS_NOT_PAGES: string[] = ["README.md"]

/** Generated pages: kept by docs:gen, so they need no sidecar and do not count as hand-written coverage. */
const isGeneratedPage = (id: string) => id.startsWith("reference/")

/**
 * Pages that predate the docs site and need no sources sidecar: the developer
 * docs at the docs/ root and the runbooks.
 */
const isLegacyPage = (id: string) => !id.includes("/") || id.startsWith("runbooks/")

const ESCAPE_HATCH =
  "Update one of those pages, or add a line `Docs-skip: <reason, at least 10 characters>` to the PR body or a commit message."

function navPages(nav: Nav): NavPage[] {
  return [nav.landing, ...nav.sections.flatMap((s) => s.pages)]
}

function globMatch(glob: string, file: string): boolean {
  return new Bun.Glob(glob).match(file)
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Freshness
// ──────────────────────────────────────────────────────────────────────────

export function checkFreshness(
  root: string = ROOT,
  generate: (root: string) => Map<string, string> = generateAll,
): RuleResult {
  const files = generate(root)
  const stale = writeOrCheck(root, files, true)
  return {
    rule: "freshness",
    ok: stale.length === 0,
    summary: `${files.size} generated pages, ${stale.length} stale`,
    problems:
      stale.length > 0
        ? [`stale generated pages (run bun run docs:gen):`, ...stale.map((s) => `  ${s}`)]
        : [],
    notes: [],
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Nav integrity
// ──────────────────────────────────────────────────────────────────────────

function listMarkdown(docsDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const full = join(dir, entry)
      const r = rel ? `${rel}/${entry}` : entry
      if (statSync(full).isDirectory()) walk(full, r)
      else if (entry.endsWith(".md")) out.push(r)
    }
  }
  walk(docsDir, "")
  return out
}

export async function checkNav(opts: {
  root?: string
  nav?: Nav
  cfg?: DocsMapConfig
  notPages?: string[]
}): Promise<RuleResult> {
  const root = opts.root ?? ROOT
  const nav = opts.nav ?? { landing: LANDING, sections: NAV }
  const cfg = opts.cfg ?? REAL_CONFIG
  const notPages = new Set(opts.notPages ?? DOCS_NOT_PAGES)
  const docsDir = join(root, "docs")
  const problems: string[] = []
  const pages = navPages(nav)
  const ids = new Set(pages.map((p) => p.id))

  const noFile = pages.filter((p) => !existsSync(join(docsDir, `${p.id}.md`)))
  for (const p of noFile) problems.push(`nav page without a file: docs/${p.id}.md`)

  const files = listMarkdown(docsDir)
  const notInNav = files.filter((f) => {
    if (notPages.has(f) || f.startsWith("runbooks/")) return false
    return !ids.has(f.replace(/\.md$/, ""))
  })
  for (const f of notInNav) problems.push(`docs page not in docs/nav.ts: docs/${f}`)

  const mapIds = new Set(cfg.map.flatMap((e) => e.pages))
  const badMapIds = [...mapIds].filter((id) => !ids.has(id)).sort()
  for (const id of badMapIds)
    problems.push(`.claude/docs-map.ts names a page not in docs/nav.ts: ${id}`)

  const authored = pages.filter((p) => !isGeneratedPage(p.id) && !isLegacyPage(p.id))
  const noSidecar = authored.filter(
    (p) => !noFile.includes(p) && !existsSync(join(docsDir, ".sources", `${p.id}.txt`)),
  )
  for (const p of noSidecar)
    problems.push(`page without its sources sidecar: docs/.sources/${p.id}.txt`)

  let buildProblems = 0
  const out = mkdtempSync(join(tmpdir(), "check-docs-build-"))
  try {
    await buildDocs({ docsDir, out, nav })
  } catch (err) {
    const lines =
      err instanceof DocsBuildError
        ? [...err.invalid, ...err.broken.map((b) => `broken link in docs/${b.file}: ${b.link}`)]
        : [err instanceof Error ? err.message : String(err)]
    buildProblems = lines.length
    // Missing page files are already listed above.
    for (const l of lines) problems.push(`docs build: ${l}`)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }

  return {
    rule: "nav",
    ok: problems.length === 0,
    summary: `${pages.length} nav pages, ${files.length} docs files: ${noFile.length} without a file, ${notInNav.length} not in nav, ${badMapIds.length} unknown docs-map ids, ${noSidecar.length} without a sidecar, ${buildProblems} build errors`,
    problems,
    notes: [],
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Coverage
// ──────────────────────────────────────────────────────────────────────────

export interface CoverageInputs {
  /** Each shipped app and the page that documents it (the first page of its docs-map entry). */
  apps: { dir: string; page: string | undefined }[]
  cliCommands: string[]
  envVars: string[]
  settingsKeys: string[]
  scopes: string[]
}

/** Every nav page's text, by id (pages without a file are left out). */
export function loadPageTexts(docsDir: string, nav: Nav): Map<string, string> {
  const texts = new Map<string, string>()
  for (const p of navPages(nav)) {
    const path = join(docsDir, `${p.id}.md`)
    if (existsSync(path)) texts.set(p.id, readFileSync(path, "utf8"))
  }
  return texts
}

/** Shipped apps (`apps/api/src/apps/*` and `bundled-apps/*`) mapped to their page. */
export function shippedApps(root: string, cfg: DocsMapConfig): CoverageInputs["apps"] {
  const out: CoverageInputs["apps"] = []
  for (const base of ["apps/api/src/apps", "bundled-apps"]) {
    const dir = join(root, base)
    if (!existsSync(dir)) continue
    for (const app of readdirSync(dir).sort()) {
      if (app.startsWith(".")) continue
      if (!statSync(join(dir, app)).isDirectory()) continue
      const rel = `${base}/${app}`
      const entry = cfg.map.find((e) => globMatch(e.glob, `${rel}/index.ts`))
      out.push({ dir: rel, page: entry?.pages[0] })
    }
  }
  return out
}

export function collectCoverageInputs(
  root: string = ROOT,
  cfg: DocsMapConfig = REAL_CONFIG,
): CoverageInputs {
  const env = collectEnvVars(root)
  const settingsKeys = new Set<string>()
  for (const app of collectManifestSettings(root)) {
    for (const s of app.sections) for (const f of s.fields) if (f.key) settingsKeys.add(f.key)
  }
  const scopes = new Set<string>()
  for (const m of loadManifests(root)) for (const s of collectAppScopes(m)) scopes.add(s.scope)
  return {
    apps: shippedApps(root, cfg),
    cliCommands: COMMANDS.map((c) => c.name),
    envVars: [
      ...new Set([...env.schema.map((e) => e.name), ...env.extra.map((e) => e.name)]),
    ].sort(),
    settingsKeys: [...settingsKeys].sort(),
    scopes: [...scopes].sort(),
  }
}

/** The generated page that covers env vars. */
const ENV_REFERENCE = "reference/env"

export function checkCoverage(inputs: CoverageInputs, pages: Map<string, string>): RuleResult {
  const hand = [...pages].filter(([id]) => !isGeneratedPage(id)).map(([, t]) => t)
  const handText = hand.join("\n")
  const envText = [...hand, pages.get(ENV_REFERENCE) ?? ""].join("\n")
  const problems: string[] = []
  if (inputs.apps.length === 0) problems.push("collected 0 apps: the extractor is broken")
  const missingApps = inputs.apps.filter((a) => !a.page || !pages.has(a.page))
  if (missingApps.length > 0) {
    problems.push(`apps without their page (${missingApps.length}):`)
    for (const a of missingApps) {
      problems.push(
        a.page
          ? `  ${a.dir}: docs/${a.page}.md is missing`
          : `  ${a.dir}: no .claude/docs-map.ts entry names its page`,
      )
    }
  }
  const groups: { label: string; items: string[]; text: string; where: string }[] = [
    { label: "CLI commands", items: inputs.cliCommands, text: handText, where: "hand" },
    { label: "env vars", items: inputs.envVars, text: envText, where: "env" },
    { label: "manifest settings keys", items: inputs.settingsKeys, text: handText, where: "hand" },
    { label: "manifest scopes", items: inputs.scopes, text: handText, where: "hand" },
  ]
  const counts: string[] = [`${inputs.apps.length - missingApps.length}/${inputs.apps.length} apps`]
  for (const { label, items, text, where } of groups) {
    if (items.length === 0) {
      problems.push(`collected 0 ${label}: the extractor is broken`)
      counts.push(`0 ${label} collected`)
      continue
    }
    const missing = items.filter((i) => !text.includes(i))
    const n = `${items.length - missing.length}/${items.length}`
    counts.push(
      where === "env"
        ? `${label}: ${n} in the generated reference`
        : `${n} ${label} in hand-written pages`,
    )
    if (missing.length > 0) {
      problems.push(
        where === "env"
          ? `${label} not in docs/${ENV_REFERENCE}.md (${missing.length}):`
          : `${label} not mentioned in any hand-written page (${missing.length}):`,
      )
      for (const m of missing) problems.push(`  ${m}`)
    }
  }
  return {
    rule: "coverage",
    ok: problems.length === 0,
    summary: counts.join(", "),
    problems,
    notes: [],
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Diff rule
// ──────────────────────────────────────────────────────────────────────────

function gitOut(root: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`)
  return r.stdout
}

/**
 * Every path changed in `<base>...HEAD`; a rename or copy contributes both
 * sides. `-z` keeps paths unquoted: records are `status NUL path NUL`, or
 * `R<score> NUL old NUL new NUL` for a rename or copy.
 */
export function changedFiles(root: string, base: string): string[] {
  const out = gitOut(root, ["diff", "-z", "--name-status", "-M", `${base}...HEAD`])
  const tokens = out.split("\0")
  const files = new Set<string>()
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++] ?? ""
    if (!status) continue
    const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    for (let k = 0; k < paths; k++) {
      const path = tokens[i++]
      if (path) files.add(path)
    }
  }
  return [...files].sort()
}

export interface DocsSkip {
  /** Valid reasons (at least 10 characters). */
  reasons: string[]
  /** `Docs-skip:` lines whose reason is too short. */
  rejected: string[]
}

export function parseDocsSkip(texts: string[]): DocsSkip {
  const reasons: string[] = []
  const rejected: string[] = []
  for (const text of texts) {
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      const m = /^Docs-skip:(.*)$/.exec(line)
      if (!m) continue
      const reason = (m[1] ?? "").trim()
      if (/^Docs-skip:\s*(.{10,})$/.test(line) && reason.length >= 10) reasons.push(reason)
      else rejected.push(line.trim())
    }
  }
  return { reasons, rejected }
}

export type FileClass =
  | { kind: "exempt" }
  | { kind: "mapped"; pages: string[] }
  | { kind: "unmapped"; failsafe: boolean }

/** How the diff rule treats one changed path: exempt first, then the first matching map entry. */
export function classifyFile(file: string, cfg: DocsMapConfig): FileClass {
  if (cfg.exempt.some((e) => globMatch(e.glob, file))) return { kind: "exempt" }
  const entry = cfg.map.find((e) => globMatch(e.glob, file))
  if (entry) return { kind: "mapped", pages: entry.pages }
  return { kind: "unmapped", failsafe: cfg.failsafeRoots.some((r) => file.startsWith(r)) }
}

export function checkDiff(opts: {
  root?: string
  base: string | undefined
  prBody: string
  cfg?: DocsMapConfig
}): RuleResult {
  const root = opts.root ?? ROOT
  const cfg = opts.cfg ?? REAL_CONFIG
  if (!opts.base) {
    return {
      rule: "diff",
      ok: true,
      skipped: true,
      summary: "skipped (no base: pass --base <ref> or set GITHUB_BASE_REF)",
      problems: [],
      notes: [
        "diff rule skipped: no base ref (a push to main runs freshness, nav and coverage only)",
      ],
    }
  }
  const changed = changedFiles(root, opts.base)
  const changedSet = new Set(changed)
  const messages = gitOut(root, ["log", "--format=%B%x00", `${opts.base}..HEAD`]).split("\0")
  const skip = parseDocsSkip([opts.prBody, ...messages])

  const unsatisfied: { file: string; pages: string[] }[] = []
  const unmapped: string[] = []
  let exempt = 0
  let mapped = 0
  for (const file of changed) {
    const c = classifyFile(file, cfg)
    if (c.kind === "exempt") {
      exempt++
      continue
    }
    if (c.kind === "unmapped") {
      if (c.failsafe) unmapped.push(file)
      continue
    }
    mapped++
    // A generated page counts like any other: only when its file is in the diff.
    if (!c.pages.some((id) => changedSet.has(`docs/${id}.md`))) {
      unsatisfied.push({ file, pages: c.pages })
    }
  }

  const problems: string[] = []
  const notes: string[] = []
  for (const r of skip.rejected) {
    problems.push(`Docs-skip rejected, the reason must be at least 10 characters: "${r}"`)
  }
  const skipped = skip.reasons.length > 0
  if (skipped) {
    for (const r of skip.reasons) notes.push(`Docs-skip: ${r}`)
  } else {
    for (const u of unsatisfied) {
      problems.push(
        `${u.file} changed; update one of: ${u.pages.map((p) => `docs/${p}.md`).join(", ")}`,
      )
    }
    if (unsatisfied.length > 0) problems.push(ESCAPE_HATCH)
  }
  for (const f of unmapped) {
    problems.push(
      `${f} is under a docs fail-safe root but matches no docs map entry: add it to .claude/docs-map.ts (DOCS_MAP, or DOCS_EXEMPT with a reason)`,
    )
  }
  return {
    rule: "diff",
    ok: problems.length === 0,
    summary: `${changed.length} changed files vs ${opts.base}: ${exempt} exempt, ${mapped} mapped, ${unsatisfied.length} without a page change${skipped ? " (Docs-skip)" : ""}, ${unmapped.length} unmapped`,
    problems,
    notes,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

export function resolveBase(
  argv: string[],
  env: Record<string, string | undefined>,
): string | undefined {
  const at = argv.indexOf("--base")
  if (at !== -1 && argv[at + 1]) return argv[at + 1]
  return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const results: RuleResult[] = []
  results.push(checkFreshness())
  results.push(await checkNav({}))
  results.push(
    checkCoverage(
      collectCoverageInputs(),
      loadPageTexts(join(ROOT, "docs"), { landing: LANDING, sections: NAV }),
    ),
  )
  results.push(checkDiff({ base: resolveBase(argv, env), prBody: env.PR_BODY ?? "" }))

  for (const r of results) {
    if (r.problems.length > 0) {
      console.log(`\n[${r.rule}] FAIL`)
      for (const p of r.problems) console.log(`  ${p}`)
    }
    for (const n of r.notes) console.log(`[${r.rule}] ${n}`)
  }
  console.log("")
  for (const r of results) {
    console.log(`check:docs ${r.rule}: ${r.skipped ? "SKIP" : r.ok ? "ok" : "FAIL"} (${r.summary})`)
  }
  return results.every((r) => r.ok) ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
