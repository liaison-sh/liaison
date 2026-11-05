// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration test: `config apply` drift safety and `config pull`, on a real
 * database, through the same parse → interpolate → validate → runConfigApply
 * path the CLI takes.
 *
 *  - the first apply records every tracked path (hash, when, who);
 *  - a change made in the product (written straight to the tables, as the UI
 *    would) then an apply of the older file → conflict, exit 3, not written,
 *    while the rest of the file still applies;
 *  - `--prefer file` overwrites; `--prefer server` keeps and re-records;
 *  - `--only` writes and checks just the named paths;
 *  - a dry run plans the conflict and writes nothing;
 *  - `config pull` brings the server values into the file (comments and env
 *    references kept), and applying the pulled file is all unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { CONFLICT_EXIT_CODE, runConfigApply } from "~/cli/config/apply"
import type { PreferSpec } from "~/cli/config/drift"
import { interpolateEnv, parseConfigFile } from "~/cli/config/parse"
import { runConfigPull } from "~/cli/config/pull"
import { validateConfig } from "~/cli/config/schema"
import { withSystemDb } from "~/db/privileged"
import { agents, configAppliedFields, organizations } from "~/db/schema/kernel"
import { acquireTestLock, releaseTestLockKeepRows } from "~/tests/route-test-setup"

let dir: string
beforeAll(async () => {
  await acquireTestLock()
  dir = mkdtempSync(join(tmpdir(), "config-drift-"))
})
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await releaseTestLockKeepRows()
})

function yamlFor(slug: string, suffix: string, over: { timezone?: string; from?: string } = {}) {
  return `# Fabrikam provisioning (kept by config pull)
org:
  slug: ${slug}
  name: Drift Org
  timezone: ${over.timezone ?? "Europe/Paris"} # the office
admin:
  email: admin-${suffix}@fabrikam.example
  name: Owner
email:
  from: "${over.from ?? "Support <support@fabrikam.example>"}"
roles:
  - name: drift-support
    scopes: [kernel:threads:read]
agents:
  - handle: helper
    displayName: Helper
    purpose: Answers questions
`
}

function writeConfig(name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

async function apply(
  path: string,
  opts: { dryRun?: boolean; only?: string[]; prefer?: PreferSpec } = {},
) {
  const parsed = parseConfigFile(path)
  if (!parsed.ok) throw new Error(parsed.message)
  const validated = validateConfig(interpolateEnv(parsed.raw))
  if (!validated.ok) throw new Error(validated.message)
  return runConfigApply({
    config: validated.config,
    format: "json",
    dryRun: opts.dryRun ?? false,
    validateByok: false,
    echoSupplied: false,
    configDir: dirname(path),
    log: () => {},
    connectionProbes: {},
    appliedBy: "cli:test@ci",
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.prefer ? { prefer: opts.prefer } : {}),
  })
}

async function orgRow(slug: string) {
  const [row] = await withSystemDb("drift-test-org", (db) =>
    db
      .select({
        id: organizations.id,
        timezone: organizations.timezone,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.slug, slug)),
  )
  if (!row) throw new Error(`no org ${slug}`)
  return row
}

/** A change made in the product, as the settings page would make it. */
async function uiSetTimezone(orgId: string, tz: string) {
  await withSystemDb("drift-test-ui", (db) =>
    db.update(organizations).set({ timezone: tz }).where(eq(organizations.id, orgId)),
  )
}
async function uiSetEmailFrom(orgId: string, from: string) {
  await withSystemDb("drift-test-ui-email", (db) =>
    db
      .update(organizations)
      .set({
        settings: sql`jsonb_set(COALESCE(${organizations.settings}, '{}'::jsonb), '{email,from}', ${JSON.stringify(from)}::jsonb, true)`,
      })
      .where(eq(organizations.id, orgId)),
  )
}

async function records(orgId: string) {
  const rows = await withSystemDb("drift-test-records", (db) =>
    db.select().from(configAppliedFields).where(eq(configAppliedFields.orgId, orgId)),
  )
  return new Map(rows.map((r) => [r.path, r]))
}

function emailFrom(settings: unknown): unknown {
  if (typeof settings !== "object" || settings === null) return undefined
  const email = Reflect.get(settings, "email")
  return typeof email === "object" && email !== null ? Reflect.get(email, "from") : undefined
}

async function freshOrg() {
  const suffix = crypto.randomUUID().slice(0, 8)
  const slug = `drift-${suffix}`
  const path = writeConfig(`${slug}.yaml`, yamlFor(slug, suffix))
  const first = await apply(path)
  expect(first.exitCode).toBe(0)
  const { id } = await orgRow(slug)
  return { slug, suffix, path, orgId: id }
}

describe("config apply drift safety", () => {
  test("the first apply records every tracked path; a re-run is unchanged", async () => {
    const { path, orgId } = await freshOrg()
    const recs = await records(orgId)
    for (const p of [
      "org.name",
      "org.timezone",
      "email.from",
      "roles.drift-support",
      "agents.helper.purpose",
      "agents.helper.scopes",
    ]) {
      expect(recs.get(p)?.valueHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(recs.get(p)?.appliedBy).toBe("cli:test@ci")
    }
    const again = await apply(path)
    expect(again.exitCode).toBe(0)
    expect(again.drift.every((d) => d.action === "unchanged")).toBe(true)
  })

  test("a value changed in the product is a conflict: not written, exit 3, the rest applies", async () => {
    const { slug, suffix, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "America/New_York")
    // The file moves email.from (no drift there) and still says Europe/Paris.
    const path = writeConfig(
      `${slug}-2.yaml`,
      yamlFor(slug, suffix, { from: "Help <help@fabrikam.example>" }),
    )
    const before = (await records(orgId)).get("org.timezone")
    const res = await apply(path)
    expect(res.exitCode).toBe(CONFLICT_EXIT_CODE)
    const conflict = res.drift.find((d) => d.path === "org.timezone")
    expect(conflict).toMatchObject({
      action: "conflict",
      file: '"Europe/Paris"',
      server: '"America/New_York"',
      lastApplied: { by: "cli:test@ci", matchesServer: false },
    })
    expect(res.drift.find((d) => d.path === "email.from")?.action).toBe("update")
    const row = await orgRow(slug)
    expect(row.timezone).toBe("America/New_York")
    expect(emailFrom(row.settings)).toBe("Help <help@fabrikam.example>")
    // The conflicting path's record is left as it was.
    expect((await records(orgId)).get("org.timezone")?.valueHash).toBe(before?.valueHash ?? "")
  })

  test("a dry run plans the conflict and writes nothing", async () => {
    const { slug, path, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "Asia/Tokyo")
    const res = await apply(path, { dryRun: true })
    expect(res.exitCode).toBe(CONFLICT_EXIT_CODE)
    expect(res.drift.find((d) => d.path === "org.timezone")?.action).toBe("conflict")
    expect(res.drift.find((d) => d.path === "email.from")?.action).toBe("unchanged")
    expect((await orgRow(slug)).timezone).toBe("Asia/Tokyo")
  })

  test("--prefer file overwrites the server's value", async () => {
    const { slug, path, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "Asia/Tokyo")
    const res = await apply(path, { prefer: { scoped: [{ path: "org.timezone", side: "file" }] } })
    expect(res.exitCode).toBe(0)
    expect(res.drift.find((d) => d.path === "org.timezone")).toMatchObject({
      action: "update",
      resolution: "file",
    })
    expect((await orgRow(slug)).timezone).toBe("Europe/Paris")
  })

  test("--prefer server keeps it and records it as applied", async () => {
    const { slug, path, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "Asia/Tokyo")
    await withSystemDb("drift-test-ui-agent", (db) =>
      db
        .update(agents)
        .set({ purpose: "Edited in the UI" })
        .where(and(eq(agents.orgId, orgId), eq(agents.handle, "@helper"))),
    )
    const res = await apply(path, { prefer: { all: "server", scoped: [] } })
    expect(res.exitCode).toBe(0)
    expect(res.drift.find((d) => d.path === "org.timezone")?.action).toBe("keep")
    expect(res.drift.find((d) => d.path === "agents.helper.purpose")?.action).toBe("keep")
    expect((await orgRow(slug)).timezone).toBe("Asia/Tokyo")
    const [agent] = await withSystemDb("drift-test-agent", (db) =>
      db
        .select({ purpose: agents.purpose })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.handle, "@helper"))),
    )
    expect(agent?.purpose).toBe("Edited in the UI")
    // Re-recorded: the next plain apply sees an ordinary update, not a conflict.
    const next = await apply(path, { dryRun: true })
    expect(next.exitCode).toBe(0)
    expect(next.drift.find((d) => d.path === "org.timezone")?.action).toBe("update")
  })

  test("--only writes and checks just the named paths", async () => {
    const { slug, suffix, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "Asia/Tokyo")
    const path = writeConfig(
      `${slug}-only.yaml`,
      yamlFor(slug, suffix, { from: "Only <only@fabrikam.example>" }).replace(
        "Drift Org",
        "Renamed Org",
      ),
    )
    const res = await apply(path, { only: ["email.from"] })
    // The drifted timezone is out of scope: no conflict, not written.
    expect(res.exitCode).toBe(0)
    expect(res.drift.map((d) => d.path)).toEqual(["email.from"])
    const row = await orgRow(slug)
    expect(row.timezone).toBe("Asia/Tokyo")
    expect(emailFrom(row.settings)).toBe("Only <only@fabrikam.example>")
    const [org] = await withSystemDb("drift-test-name", (db) =>
      db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId)),
    )
    expect(org?.name).toBe("Drift Org")
  })
})

describe("config pull", () => {
  test("pulls server values into the file, keeps comments and env references; apply is then unchanged", async () => {
    const { slug, suffix, orgId } = await freshOrg()
    await uiSetTimezone(orgId, "Asia/Tokyo")
    await uiSetEmailFrom(orgId, "Desk <desk@fabrikam.example>")
    // An env reference stays as written, even where the server differs.
    const text = yamlFor(slug, suffix).replace(
      `from: "Support <support@fabrikam.example>"`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config ref, not a JS template.
      "from: ${DRIFT_TEST_FROM:-Support <support@fabrikam.example>}",
    )
    const path = writeConfig(`${slug}-pull.yaml`, text)
    const pulled = await runConfigPull({ configPath: path, log: () => {} })
    expect(pulled.exitCode).toBe(0)
    expect(pulled.updated).toEqual(["org.timezone"])
    const out = pulled.text ?? ""
    expect(out).toContain("timezone: Asia/Tokyo")
    expect(out).toContain("# Fabrikam provisioning (kept by config pull)")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config ref, not a JS template.
    expect(out).toContain("${DRIFT_TEST_FROM:-Support <support@fabrikam.example>}")

    // Round trip: put the env value in step, apply the pulled file → all unchanged.
    await uiSetEmailFrom(orgId, "Support <support@fabrikam.example>")
    const pulledPath = writeConfig(`${slug}-pulled.yaml`, out)
    const res = await apply(pulledPath)
    expect(res.exitCode).toBe(0)
    expect(res.drift.filter((d) => d.action !== "unchanged")).toEqual([])
  })
})
