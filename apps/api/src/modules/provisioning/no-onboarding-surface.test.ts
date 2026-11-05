// SPDX-License-Identifier: FSL-1.1-ALv2
// Deployments are configured through MCP and the provisioning CLI. The
// in-product onboarding system (org first-run setup, the per-user welcome tour,
// the web setup store) is gone; this guard keeps it from creeping back: no
// source file imports a setup or onboarding module (api or web), and no route
// under /api/setup (nor the tour's "mark onboarded" endpoint) is mounted.
//
// The agent-led first run (provisioning/setup-state.ts, setup-kickoff.ts) is
// built from rows, a tool and a conversation, so it adds none of these either:
// no module directory named setup* or onboarding*, no /api/setup* or
// /api/onboarding* route, no onboarded flag in code, settings or a migration.
// Each of those checks is shown to catch a planted offender, so a green run
// means "none found", not "could not see".
import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { orgKernelSettingsSchema } from "@liaison/shared"
import { app } from "~/app"

const API_SRC = path.resolve(import.meta.dir, "../..")
const WEB_SRC = path.resolve(API_SRC, "../../web/src")
const SELF = path.resolve(import.meta.path)

const RETIRED = ["setup", "onboarding"].map((name) => `modules/${name}`)

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g

function importsRetiredModule(file: string, srcRoot: string): string[] {
  const hits: string[] = []
  const text = readFileSync(file, "utf8")
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1]!
    let resolved: string
    if (spec.startsWith("~/")) resolved = path.join(srcRoot, spec.slice(2))
    else if (spec.startsWith(".")) resolved = path.resolve(path.dirname(file), spec)
    else continue
    const rel = path.relative(srcRoot, resolved).split(path.sep).join("/")
    if (RETIRED.some((r) => rel === r || rel.startsWith(`${r}/`))) hits.push(spec)
  }
  return hits
}

describe("onboarding surface stays removed", () => {
  for (const [label, root] of [
    ["api", API_SRC],
    ["web", WEB_SRC],
  ] as const) {
    test(`no ${label} source file imports modules/setup or modules/onboarding`, () => {
      expect(existsSync(root)).toBe(true)
      const offenders: string[] = []
      for (const file of sourceFiles(root)) {
        if (file === SELF) continue
        for (const spec of importsRetiredModule(file, root)) {
          offenders.push(`${path.relative(root, file)} -> ${spec}`)
        }
      }
      expect(offenders).toEqual([])
      for (const r of RETIRED) expect(existsSync(path.join(root, r))).toBe(false)
    })
  }

  test("no route under /api/setup and no mark-onboarded route is mounted", () => {
    const paths = app.routes.map((r) => r.path)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter((p) => p === "/api/setup" || p.startsWith("/api/setup/"))).toEqual([])
    expect(paths.filter((p) => p.endsWith("/me/onboarded"))).toEqual([])
  })
})

/** Module directories (api `modules/`, web `modules/`) named like an onboarding surface. */
function onboardingModuleDirs(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return []
  return readdirSync(modulesDir).filter(
    (name) =>
      /^(setup|onboarding)/i.test(name) && statSync(path.join(modulesDir, name)).isDirectory(),
  )
}

/** Mounted paths under /api/setup* or /api/onboarding*, or ending /onboarded. */
function onboardingRoutes(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      p.startsWith("/api/setup") || p.startsWith("/api/onboarding") || p.endsWith("/onboarded"),
  )
}

/** Code with its comments removed: a flag named in a comment is not a flag. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

const FLAG_IDENTIFIER = /\b(onboarded|onboardedAt|setupComplete[A-Za-z]*)\b/
const SETTINGS_FLAG_WRITE = /["'`]setupState["'`]|\bsetupState\s*:/

/** Files whose code names an onboarded flag or writes a setupState settings key. */
function flagSites(files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"))
    if (FLAG_IDENTIFIER.test(code) || SETTINGS_FLAG_WRITE.test(code)) hits.push(file)
  }
  return hits
}

/** Migrations after 0209 (the last before the first run) adding a flag-like column. */
function flagMigrations(dir: string): string[] {
  return readdirSync(dir).filter((name) => {
    const n = Number(name.slice(0, 4))
    if (!name.endsWith(".sql") || !Number.isFinite(n) || n <= 209) return false
    return /onboarded|setup_complete|setup_state|setupstate/i.test(
      readFileSync(path.join(dir, name), "utf8"),
    )
  })
}

describe("the agent-led first run adds no onboarding surface", () => {
  const PLANT = mkdtempSync(path.join(tmpdir(), "no-onboarding-"))

  test("no module directory named setup* or onboarding* (api or web)", () => {
    expect(onboardingModuleDirs(path.join(API_SRC, "modules"))).toEqual([])
    expect(onboardingModuleDirs(path.join(WEB_SRC, "modules"))).toEqual([])
    // A planted one is seen.
    mkdirSync(path.join(PLANT, "modules", "setup-wizard"), { recursive: true })
    mkdirSync(path.join(PLANT, "modules", "Onboarding"), { recursive: true })
    expect(onboardingModuleDirs(path.join(PLANT, "modules")).sort()).toEqual([
      "Onboarding",
      "setup-wizard",
    ])
  })

  test("no route under /api/setup*, /api/onboarding* or ending /onboarded is mounted", () => {
    expect(onboardingRoutes(app.routes.map((r) => r.path))).toEqual([])
    expect(
      onboardingRoutes([
        "/api/settings/ai",
        "/api/setupState",
        "/api/onboarding/next",
        "/api/users/onboarded",
      ]),
    ).toEqual(["/api/setupState", "/api/onboarding/next", "/api/users/onboarded"])
  })

  test("no onboarded flag in code, and no setupState key written into org settings", () => {
    const files = [...sourceFiles(API_SRC), ...sourceFiles(WEB_SRC)].filter((f) => f !== SELF)
    expect(flagSites(files).map((f) => path.relative(API_SRC, f))).toEqual([])
    // Planted offenders are seen; a mention in a comment is not one.
    const planted = (name: string, text: string) => {
      const file = path.join(PLANT, name)
      writeFileSync(file, text)
      return file
    }
    const offenders = [
      planted("a.ts", "export const onboardedAt = new Date()\n"),
      planted("b.ts", "const s = { setupComplete: true }\n"),
      planted("c.ts", "await jsonbSet(settings, '{setupState}', 'setupState')\n"),
      planted("d.ts", "settings = { ...settings, setupState: { done: 1 } }\n"),
    ]
    const innocent = planted(
      "e.ts",
      "// There is no onboarded flag.\nconst x = computeSetupState\n",
    )
    expect(flagSites([...offenders, innocent]).sort()).toEqual(offenders.sort())
  })

  // `chosenFeatures` is allowed: it is the person's answer to "which features do
  // you want", never a done flag or a step status (what is done is still read
  // from rows, setup-state.ts).
  test("the org settings schema has no setup or onboarded key", () => {
    const keys = Object.keys(orgKernelSettingsSchema.shape)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => /onboard|setup/i.test(k))).toEqual([])
  })

  test("no migration after 0209 adds a flag-like column", () => {
    expect(flagMigrations(path.join(API_SRC, "db/migrations"))).toEqual([])
    const dir = path.join(PLANT, "migrations")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "0150_old.sql"), "ALTER TABLE x ADD COLUMN onboarded boolean;")
    writeFileSync(
      path.join(dir, "0300_flag.sql"),
      "ALTER TABLE x ADD COLUMN setup_completed_at timestamptz;",
    )
    writeFileSync(path.join(dir, "0301_ok.sql"), "ALTER TABLE x ADD COLUMN note text;")
    expect(flagMigrations(dir)).toEqual(["0300_flag.sql"])
  })

  afterAll(() => rmSync(PLANT, { recursive: true, force: true }))
})
