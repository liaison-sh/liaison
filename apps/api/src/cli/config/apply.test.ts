// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { CANONICAL_ORDER, type ProvisionerRegistry, runConfigApply } from "~/cli/config/apply"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  buildProvisionContext,
  type PendingItem,
  type ProvisionContext,
  type ProvisionDbSeams,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
} from "~/cli/provisioners/types"
import type { PrivilegedDb, RlsClient } from "~/db"

const baseConfig: ProvisioningConfig = { org: { slug: "fabrikam", name: "Fabrikam" } }

/** A spy provisioner that records when its plan/apply run, in a shared log. */
function spyProvisioner(
  key: string,
  callLog: string[],
  hooks?: {
    onApply?: (ctx: ProvisionContext) => void
    planThrows?: ConfigError
    result?: ProvisionResult
  },
): Provisioner<ProvisioningConfig> {
  return {
    key,
    async plan(): Promise<ProvisionPlan> {
      callLog.push(`${key}.plan`)
      if (hooks?.planThrows) throw hooks.planThrows
      return { actions: [`${key} planned`] }
    },
    async apply(ctx): Promise<ProvisionResult> {
      callLog.push(`${key}.apply`)
      hooks?.onApply?.(ctx)
      return hooks?.result ?? {}
    },
  }
}

/**
 * Test-double transaction handles. The stub provisioners + seam callbacks in
 * this driver-level suite never DEREFERENCE the handle (they assert ordering /
 * ctx wiring, not DB behavior). `RlsClient`/`PrivilegedDb` are brand-only types
 * with no value-level constructor off the real DB path, so a test fixture
 * fabricates them via the repo's standard test-double idiom
 * (`db as unknown as RlsClient`, used across the apps/api test suite) — this is
 * a mock handle, not a production-signature dodge.
 */
const fakeRls = {} as unknown as RlsClient
const fakePriv = {} as unknown as PrivilegedDb

/** DB seams that never touch a DB — they just run the callback with a sentinel. */
function fakeSeams(captured?: { orgId?: string }): ProvisionDbSeams {
  return {
    async withRlsContext(actorCtx, fn) {
      if (captured) captured.orgId = actorCtx.orgId
      return fn(fakeRls)
    },
    async withPrivilegedDb(_orgId, _reason, fn) {
      return fn(fakePriv)
    },
    async withSystemDb(_reason, fn) {
      return fn(fakePriv)
    },
  }
}

describe("runConfigApply driver", () => {
  test("runs provisioners in the fixed canonical order, org first", async () => {
    const callLog: string[] = []
    // Register out of canonical order to prove the driver imposes the order.
    const registry: ProvisionerRegistry = {
      admin: spyProvisioner("admin", callLog, {
        onApply: (ctx) => {
          // org.apply must have already set ctx.orgId before admin runs.
          expect(ctx.orgId).toBe("org-123")
        },
      }),
      org: spyProvisioner("org", callLog, {
        onApply: (ctx) => {
          ctx.orgId = "org-123"
        },
      }),
    }

    const res = await runConfigApply({
      config: baseConfig,
      format: "json",
      dryRun: false,
      validateByok: true,
      echoSupplied: false,
      registry,
      seams: fakeSeams(),
      log: () => {},
    })

    expect(res.exitCode).toBe(0)
    // Plans run first (both), then applies, each in canonical order.
    expect(callLog).toEqual(["org.plan", "admin.plan", "org.apply", "admin.apply"])
    // Sanity: canonical order really does put org before admin.
    expect(CANONICAL_ORDER.indexOf("org")).toBeLessThan(CANONICAL_ORDER.indexOf("admin"))
  })

  test("--dry-run runs plan only, never apply, and still emits a report", async () => {
    const callLog: string[] = []
    const registry: ProvisionerRegistry = {
      org: spyProvisioner("org", callLog),
      admin: spyProvisioner("admin", callLog),
    }

    const res = await runConfigApply({
      config: baseConfig,
      format: "json",
      dryRun: true,
      validateByok: true,
      echoSupplied: false,
      registry,
      seams: fakeSeams(),
      log: () => {},
    })

    expect(res.exitCode).toBe(0)
    expect(callLog).toEqual(["org.plan", "admin.plan"])
    expect(callLog).not.toContain("org.apply")
    expect(callLog).not.toContain("admin.apply")
    expect(res.report).toBeDefined()
    expect(res.report.ok).toBe(true)
  })

  test("a plan throwing ConfigError(exit 2) aborts before ANY apply and returns exit 2", async () => {
    const callLog: string[] = []
    const registry: ProvisionerRegistry = {
      org: spyProvisioner("org", callLog),
      // users plan throws (canonical: users runs after admin in plan order too)
      users: spyProvisioner("users", callLog, {
        planThrows: new ConfigError("unknown role 'wizard'"),
      }),
      admin: spyProvisioner("admin", callLog),
    }

    const res = await runConfigApply({
      config: baseConfig,
      format: "json",
      dryRun: false,
      validateByok: true,
      echoSupplied: false,
      registry,
      seams: fakeSeams(),
      log: () => {},
    })

    expect(res.exitCode).toBe(2)
    expect(res.report.ok).toBe(false)
    // No apply ran at all — the plan phase aborted.
    expect(callLog.some((c) => c.endsWith(".apply"))).toBe(false)
  })

  test("aggregates changed/unchanged/pending across provisioners", async () => {
    const callLog: string[] = []
    const pending: PendingItem = {
      kind: "oauth",
      app: "social",
      connection: "meta",
      action: "liaison connect social/meta",
    }
    const registry: ProvisionerRegistry = {
      org: spyProvisioner("org", callLog, {
        result: { section: { id: "org-1" }, changed: ["org.created"] },
      }),
      admin: spyProvisioner("admin", callLog, {
        result: { section: { id: "admin-1" }, unchanged: ["admin"] },
      }),
      apps: spyProvisioner("apps", callLog, {
        result: { changed: ["apps.social.enabled"], pending: [pending] },
      }),
    }

    const res = await runConfigApply({
      config: baseConfig,
      format: "json",
      dryRun: false,
      validateByok: true,
      echoSupplied: false,
      registry,
      seams: fakeSeams(),
      log: () => {},
    })

    expect(res.exitCode).toBe(0)
    expect(res.report.changed).toEqual(["org.created", "apps.social.enabled"])
    expect(res.report.unchanged).toEqual(["admin"])
    expect(res.report.pending).toEqual([pending])
    expect(res.report.sections.org).toEqual({ id: "org-1" })
    expect(res.report.sections.admin).toEqual({ id: "admin-1" })
  })
})

describe("buildProvisionContext (correction #5 — lazy orgId)", () => {
  test("ctx.rls() reads the org-provisioner-set orgId, not the initial empty string", async () => {
    const captured: { orgId?: string } = {}
    const ctx = buildProvisionContext({
      log: () => {},
      validateByok: true,
      seams: fakeSeams(captured),
    })

    // At construction the orgId is empty.
    expect(ctx.orgId).toBe("")

    // The org provisioner sets it AFTER construction.
    ctx.orgId = "org-late-bound"

    // rls must read ctx.orgId lazily at call time → the late-bound value.
    await ctx.rls(async () => {})
    expect(captured.orgId).toBe("org-late-bound")
    expect(captured.orgId).not.toBe("")
  })

  test("ctx.priv() and ctx.sys() run their callbacks via the injected seams", async () => {
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false, seams: fakeSeams() })
    ctx.orgId = "org-x"
    let privRan = false
    let sysRan = false
    await ctx.priv("reason", async () => {
      privRan = true
    })
    await ctx.sys("reason", async () => {
      sysRan = true
    })
    expect(privRan).toBe(true)
    expect(sysRan).toBe(true)
  })
})
