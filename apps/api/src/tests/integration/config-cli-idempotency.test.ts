// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration test — `config apply` double-run idempotency (spec §8.4).
 *
 * Runs `runConfigApply` TWICE on a FRESH test org with a config that exercises
 * the deploy-critical sections (org + admin + byok + apiKeys with a SUPPLIED
 * key). The proof:
 *
 *  - run 2 reports every touched section as `unchanged` (nothing in `changed`);
 *  - run 2 creates ZERO new rows — org / users / api_keys / connected_accounts
 *    counts are byte-for-byte identical before vs after run 2;
 *  - `env.LIAISON_ORG_ID` is IDENTICAL across the two runs (the slug resolves to
 *    the same org, never a second one);
 *  - `env.LIAISON_API_KEY` (the supplied key, echoed with `echoSupplied`) is
 *    IDENTICAL across runs (the supplied-key upsert is hash-keyed, so a re-run
 *    neither rotates nor drops it).
 *
 * BYOK validation is disabled (`validateByok: false`) to keep the run hermetic
 * — the masked-hint idempotency compare is exercised regardless (no network).
 *
 * Handle discipline: assertions read counts via `withSystemDb`/`withPrivilegedDb`
 * directly (no casts). The CLI uses `ensureOrg` (slug-keyed), NOT
 * `bootstrapRegister`, so multiple orgs coexist — a unique slug per test keeps
 * runs independent without truncating the loop's other fixtures.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import { buildReport, type ReportApiKeyInput, type ReportInput } from "~/cli/config/report"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { acquireTestLock, releaseTestLockKeepRows } from "~/tests/route-test-setup"

// Keep the loop's other fixtures intact: acquire the lock for isolation but do
// NOT truncate on release (this file only adds slug-unique orgs of its own).
beforeAll(acquireTestLock)
afterAll(releaseTestLockKeepRows)

/** Narrow `unknown` → `string` by asserting, never casting (no `as`). */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected string, got ${typeof value}`)
  return value
}

interface Counts {
  orgs: number
  users: number
  apiKeys: number
  connectedAccounts: number
}

/** Count the rows the provisioner could create, scoped to one org. */
async function countRows(orgId: string): Promise<Counts> {
  return withPrivilegedDb(orgId, "idem-count", async (tx) => {
    const one = async (q: ReturnType<typeof drizzleSql>): Promise<number> =>
      Number(extractRows<{ n: number }>(await tx.execute(q))[0]?.n ?? 0)
    return {
      orgs: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.organizations WHERE id = ${orgId}::uuid`,
      ),
      users: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.users WHERE org_id = ${orgId}::uuid`,
      ),
      apiKeys: await one(
        drizzleSql`SELECT count(*)::int AS n FROM app_tickets.api_keys WHERE org_id = ${orgId}::uuid`,
      ),
      connectedAccounts: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`,
      ),
    }
  })
}

/**
 * Build the report's env map the same way the CLI dispatch does: project the
 * driver's aggregated sections, thread the supplied plaintext per label, then
 * `buildReport`. Mirrors `apps/api/src/cli/main.ts` projectReportInput for the
 * org + apiKeys slices (the only slices this test asserts on).
 */
function envFrom(
  report: Awaited<ReturnType<typeof runConfigApply>>["report"],
  suppliedKeyByLabel: Map<string, string>,
  echoSupplied: boolean,
): Record<string, string> {
  const input: ReportInput = {
    pending: report.pending,
    changed: report.changed,
    unchanged: report.unchanged,
  }
  const org = report.sections.org
  if (org && typeof org === "object" && "id" in org && "slug" in org) {
    const id = Reflect.get(org, "id")
    const slug = Reflect.get(org, "slug")
    if (typeof id === "string" && typeof slug === "string") {
      input.org = { id, slug, created: Reflect.get(org, "created") === true }
    }
  }
  const apiKeysSection = report.sections.apiKeys
  const keys =
    apiKeysSection && typeof apiKeysSection === "object" && "keys" in apiKeysSection
      ? Reflect.get(apiKeysSection, "keys")
      : undefined
  if (Array.isArray(keys)) {
    const apiKeys: ReportApiKeyInput[] = []
    for (const k of keys) {
      if (typeof k !== "object" || k === null) continue
      const label = Reflect.get(k, "label")
      const keyPrefix = Reflect.get(k, "keyPrefix")
      if (typeof label !== "string" || typeof keyPrefix !== "string") continue
      const generated = Reflect.get(k, "key")
      const supplied = suppliedKeyByLabel.get(label)
      apiKeys.push({
        label,
        created: Reflect.get(k, "created") === true,
        keyPrefix,
        ...(typeof generated === "string" ? { key: generated } : {}),
        ...(supplied !== undefined ? { suppliedKey: supplied } : {}),
      })
    }
    input.apiKeys = apiKeys
  }
  return buildReport(input, { echoSupplied }).env
}

describe("config apply — double-run idempotency (§8.4)", () => {
  test("a second apply changes nothing: every section unchanged, zero new rows, identical env", async () => {
    const suffix = crypto.randomUUID().slice(0, 12)
    const slug = `cli-idem-${suffix}`
    const suppliedKey = `sk-live-idem-${crypto.randomUUID().replace(/-/g, "")}`
    const apiKeyLabel = "hub-ingest"
    const suppliedKeyByLabel = new Map<string, string>([[apiKeyLabel, suppliedKey]])

    const config: ProvisioningConfig = {
      org: { slug, name: "Idempotency Org" },
      admin: {
        email: `admin-${suffix}@fabrikam.example`,
        name: "Idem Admin",
        password: "Idem-Admin-Pw-1!",
      },
      byok: {
        anthropic: { apiKey: `sk-ant-idem-${suffix}-LAST06`, validate: false },
      },
      apiKeys: [{ label: apiKeyLabel, key: suppliedKey, allowedOrigins: [] }],
    }

    const applyOpts = {
      config,
      format: "json" as const,
      dryRun: false,
      validateByok: false,
      echoSupplied: true,
    }

    // ── Run 1 — creates everything. ───────────────────────────────────────
    const run1 = await runConfigApply(applyOpts)
    expect(run1.exitCode).toBe(0)
    const orgSection = run1.report.sections.org
    const orgIdValue =
      orgSection && typeof orgSection === "object" && "id" in orgSection
        ? Reflect.get(orgSection, "id")
        : undefined
    const id = requireString(orgIdValue, "org.id")

    // Run 1 created the org / admin / byok / supplied api key. (The org + admin
    // provisioners report creation as `<key>.created`; byok/apiKeys as dotted
    // per-entity keys.)
    expect(run1.report.changed).toContain("org.created")
    expect(run1.report.changed).toContain("admin.created")
    expect(run1.report.changed).toContain("byok.anthropic")
    expect(run1.report.changed).toContain(`apiKeys.${apiKeyLabel}`)

    const env1 = envFrom(run1.report, suppliedKeyByLabel, true)
    expect(env1.LIAISON_ORG_ID).toBe(id)
    expect(env1.LIAISON_API_KEY).toBe(suppliedKey)

    const before = await countRows(id)
    // Sanity: run 1 actually produced the rows we will assert stay constant.
    expect(before.orgs).toBe(1)
    expect(before.users).toBeGreaterThanOrEqual(1)
    expect(before.apiKeys).toBe(1)

    // ── Run 2 — must be a pure no-op. ─────────────────────────────────────
    const run2 = await runConfigApply(applyOpts)
    expect(run2.exitCode).toBe(0)

    // Every touched section is reported unchanged; NOTHING is in `changed`.
    expect(run2.report.changed).toEqual([])
    expect(run2.report.unchanged).toContain("org")
    expect(run2.report.unchanged).toContain("admin")
    expect(run2.report.unchanged).toContain("byok.anthropic")
    expect(run2.report.unchanged).toContain(`apiKeys.${apiKeyLabel}`)

    // ZERO new rows across all provisioner-writable tables for this org.
    const after = await countRows(id)
    expect(after).toEqual(before)

    // Identical env: same org id, same supplied key.
    const env2 = envFrom(run2.report, suppliedKeyByLabel, true)
    expect(env2.LIAISON_ORG_ID).toBe(env1.LIAISON_ORG_ID)
    expect(env2.LIAISON_API_KEY).toBe(env1.LIAISON_API_KEY)

    // Belt-and-braces: exactly one org carries this slug (no second org minted).
    const orgsBySlug = await withSystemDb("idem-slug-count", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.organizations WHERE slug = ${slug}`,
        ),
      ),
    )
    expect(orgsBySlug[0]?.n).toBe(1)
  }, 120_000)
})

describe("config apply — pre-flight role validation (exit 2 before any write)", () => {
  test("an unknown users[].role aborts with exit 2 and ZERO rows written (no org/admin created)", async () => {
    const suffix = crypto.randomUUID().slice(0, 12)
    const slug = `cli-badrole-${suffix}`
    const adminEmail = `admin-${suffix}@fabrikam.example`

    // A config whose org does NOT exist yet → the pre-flight validates the role
    // against the DEFAULT seeded role names (admin/member/viewer). `wizard` is not
    // one, so the run must abort BEFORE the org provisioner writes anything.
    const config: ProvisioningConfig = {
      org: { slug, name: "Bad Role Org" },
      admin: { email: adminEmail, name: "Owner", password: "Bad-Role-Pw-1!" },
      users: [
        { email: `member-${suffix}@example.com`, name: "Member", role: "wizard", mode: "invite" },
      ],
    }

    const res = await runConfigApply({
      config,
      format: "json",
      dryRun: false,
      validateByok: false,
      echoSupplied: false,
    })

    // Aborted as a usage/validation error (exit 2), report not ok.
    expect(res.exitCode).toBe(2)
    expect(res.report.ok).toBe(false)

    // ZERO rows: the org was never created (so neither was the admin user). The
    // pre-flight ran before the org provisioner's apply.
    const orgRows = await withSystemDb("badrole-org-count", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.organizations WHERE slug = ${slug}`,
        ),
      ),
    )
    expect(orgRows[0]?.n).toBe(0)

    // And no admin user landed under this email (belt-and-braces — no org id to
    // scope by, so check globally by the unique email).
    const userRows = await withSystemDb("badrole-user-count", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.users WHERE email = ${adminEmail}`,
        ),
      ),
    )
    expect(userRows[0]?.n).toBe(0)
  }, 120_000)

  test("a valid default role (member) against a not-yet-created org passes pre-flight", async () => {
    const suffix = crypto.randomUUID().slice(0, 12)
    const slug = `cli-okrole-${suffix}`
    const config: ProvisioningConfig = {
      org: { slug, name: "OK Role Org" },
      admin: {
        email: `admin-${suffix}@fabrikam.example`,
        name: "Owner",
        password: "Ok-Role-Pw-1!",
      },
      users: [
        { email: `member-${suffix}@example.com`, name: "Member", role: "member", mode: "invite" },
      ],
    }

    const res = await runConfigApply({
      config,
      format: "json",
      dryRun: false,
      validateByok: false,
      echoSupplied: false,
    })
    // member is a default seeded role → pre-flight passes, the run applies.
    expect(res.exitCode, `stderr would carry: ${JSON.stringify(res.report)}`).toBe(0)
    expect(res.report.changed).toContain("org.created")
  }, 120_000)
})
