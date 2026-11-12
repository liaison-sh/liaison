// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests for `runConfigVerify` (the `liaison config verify` driver).
 * DB and probe calls are injected (`resolveOrgId` / `getCredentials` /
 * `probes`) so this suite never touches a live database or the network —
 * mirroring `apply.test.ts`'s seam-injection idiom.
 */
import { describe, expect, test } from "bun:test"
import type { Operation, RoleName } from "@liaison/api-connector-core"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { runConfigVerify } from "~/cli/config/verify"
import type { VerifyProbe } from "~/cli/provisioners/verify-probes"
import { verifyProbeOperation } from "~/modules/apps/connections/api/bridge"

const SECRET_TOKEN = "glpat-super-secret-do-not-print-9f3a"

function configWith(apps: ProvisioningConfig["apps"]): ProvisioningConfig {
  return {
    org: { slug: "acme", name: "Acme" },
    admin: { email: "owner@acme.com", name: "Owner", password: "pw-1!" },
    apps,
  } as ProvisioningConfig
}

const gitlabApp: NonNullable<ProvisioningConfig["apps"]>[number] = {
  name: "gitlab",
  enable: true,
  connection: { name: "gitlab", credentials: { token: SECRET_TOKEN, group: "acme-eng" } },
}

describe("runConfigVerify", () => {
  test("PASS: probe succeeds → status PASS, identity reported, exit 0", async () => {
    const logs: string[] = []
    const probe: VerifyProbe = async (creds) => {
      expect(creds.token).toBe(SECRET_TOKEN) // probe DOES receive the real credential
      return { identity: "alice" }
    }
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: (m) => logs.push(m),
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({ token: SECRET_TOKEN, group: "acme-eng" }),
      probes: { gitlab: probe },
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.ok).toBe(true)
    expect(res.report.results).toEqual([
      { app: "gitlab", connection: "gitlab", status: "PASS", identity: "alice" },
    ])
  })

  test("FAIL: probe throws → status FAIL, non-zero exit, HTTP status surfaced", async () => {
    const logs: string[] = []
    class FakeHttpError extends Error {
      status = 401
    }
    const probe: VerifyProbe = async () => {
      throw new FakeHttpError("GitLab authentication failed (AUTH_REVOKED)")
    }
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: (m) => logs.push(m),
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({ token: SECRET_TOKEN, group: "acme-eng" }),
      probes: { gitlab: probe },
    })
    // This is the falsifiable assertion: without the fix, a driver that never
    // propagates a probe failure to a non-zero exit would report exitCode 0
    // here (a deploy gate that never gates).
    expect(res.exitCode).toBe(1)
    expect(res.report.ok).toBe(false)
    expect(res.report.results).toEqual([
      {
        app: "gitlab",
        connection: "gitlab",
        status: "FAIL",
        error: "GitLab authentication failed (AUTH_REVOKED)",
        httpStatus: 401,
      },
    ])
  })

  test("SKIPPED: no probe registered for the app → SKIPPED, run still exits 0", async () => {
    const res = await runConfigVerify({
      config: configWith([
        { name: "shopify", enable: true, connection: { name: "shop", credentials: {} } },
      ]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({}),
      probes: { gitlab: async () => ({ identity: "unused" }) }, // no 'shopify' entry
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.results).toEqual([
      {
        app: "shopify",
        connection: "shop",
        status: "SKIPPED",
        error: "no verify probe registered for this app",
      },
    ])
  })

  test("a FAIL among several apps still fails the whole run (deploy-gate semantics)", async () => {
    const gitlabOk: typeof gitlabApp = { ...gitlabApp, name: "gitlab-ok" }
    const gitlabBad: typeof gitlabApp = { ...gitlabApp, name: "gitlab-bad" }
    const res = await runConfigVerify({
      config: configWith([gitlabOk, gitlabBad]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({ token: SECRET_TOKEN, group: "acme-eng" }),
      probes: {
        "gitlab-ok": async () => ({ identity: "alice" }),
        "gitlab-bad": async () => {
          throw new Error("revoked")
        },
      },
    })
    expect(res.exitCode).toBe(1)
    const statuses = res.report.results.map((r) => r.status)
    expect(statuses).toEqual(["PASS", "FAIL"])
  })

  test("org not found → exit 1, no probe run", async () => {
    let probeCalled = false
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: () => {},
      resolveOrgId: async () => undefined,
      getCredentials: async () => ({ token: SECRET_TOKEN }),
      probes: {
        gitlab: async () => {
          probeCalled = true
          return { identity: "alice" }
        },
      },
    })
    expect(res.exitCode).toBe(1)
    expect(probeCalled).toBe(false)
  })

  test("--app filter with no matching connector app → exit 2 (usage-level error)", async () => {
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      appFilter: "shopify",
      log: () => {},
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({}),
    })
    expect(res.exitCode).toBe(2)
  })

  test("no connector apps in config → exit 0, empty results (not a failure)", async () => {
    const res = await runConfigVerify({
      config: configWith([]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      getCredentials: async () => ({}),
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.results).toEqual([])
  })

  describe("no secret ever reaches log lines or the report", () => {
    async function runAndCollect(probeThrows: boolean) {
      const logs: string[] = []
      const probe: VerifyProbe = async (creds) => {
        if (probeThrows) {
          // A buggy probe that carelessly interpolates the credential into its
          // own error message would leak it here — assert the DRIVER's own
          // surfaces (log lines + report) never carry it regardless.
          throw new Error(`upstream rejected token ${creds.token?.slice(0, 6)}...`)
        }
        return { identity: "alice" }
      }
      const res = await runConfigVerify({
        config: configWith([gitlabApp]),
        log: (m) => logs.push(m),
        resolveOrgId: async () => "org-1",
        getCredentials: async () => ({ token: SECRET_TOKEN, group: "acme-eng" }),
        probes: { gitlab: probe },
      })
      return { res, logs }
    }

    test("PASS path", async () => {
      const { res, logs } = await runAndCollect(false)
      expect(JSON.stringify(res.report)).not.toContain(SECRET_TOKEN)
      expect(logs.join("\n")).not.toContain(SECRET_TOKEN)
    })

    test("FAIL path", async () => {
      const { res, logs } = await runAndCollect(true)
      // The full secret must never appear, even truncated-echo probes only
      // leak a prefix — assert the FULL token string is absent everywhere.
      expect(JSON.stringify(res.report)).not.toContain(SECRET_TOKEN)
      expect(logs.join("\n")).not.toContain(SECRET_TOKEN)
    })
  })
})

describe("runConfigVerify: apps[].config drift", () => {
  const monitoringApp: NonNullable<ProvisioningConfig["apps"]>[number] = {
    name: "monitoring",
    enable: true,
    config: {
      monitoringUrl: "https://status.example/board",
      monitoringSources: [{ id: "uptime", label: "Uptime" }],
    },
  }

  test("stored values equal the config → PASS, exit 0 (key order does not matter)", async () => {
    const res = await runConfigVerify({
      config: configWith([monitoringApp]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      readAppConfig: async () => ({
        monitoringUrl: "https://status.example/board",
        monitoringSources: [{ label: "Uptime", id: "uptime" }],
        hookSecret: "cipher",
      }),
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.config).toEqual([
      { app: "monitoring", key: "monitoringUrl", status: "PASS" },
      { app: "monitoring", key: "monitoringSources", status: "PASS" },
    ])
  })

  test("a stored value that differs or is missing → DRIFT, exit 1, value never printed", async () => {
    const logs: string[] = []
    const res = await runConfigVerify({
      config: configWith([monitoringApp]),
      log: (m) => logs.push(m),
      resolveOrgId: async () => "org-1",
      readAppConfig: async () => ({ monitoringUrl: "https://elsewhere.example" }),
    })
    expect(res.exitCode).toBe(1)
    expect(res.report.ok).toBe(false)
    expect(res.report.config?.map((r) => r.status)).toEqual(["DRIFT", "DRIFT"])
    expect(logs.join("\n")).not.toContain("elsewhere.example")
  })
})

describe("the apiConnectors probe operation (P2-V8)", () => {
  const read = (name: string, role?: RoleName, required: string[] = []): Operation => ({
    name,
    description: name,
    kind: "read",
    method: "GET",
    path: `/${name}`,
    params: { type: "object", properties: {}, ...(required.length > 0 ? { required } : {}) },
    fields: ["id"],
    ...(role ? { role } : {}),
  })

  test("prefers a param-less read that is not the customer lookup (an unfiltered lookup may page through everything)", () => {
    const op = verifyProbeOperation([
      read("find_customers", "customer.lookup"),
      read("list_orders", "customer.orders", ["customerId"]),
      read("list_companies"),
    ])
    expect(op?.name).toBe("list_companies")
  })

  test("never the lookup, which the connector refuses without a filter param", () => {
    const op = verifyProbeOperation([
      read("find_customers", "customer.lookup"),
      read("list_orders", "customer.orders", ["customerId"]),
    ])
    expect(op).toBeUndefined()
  })

  test("none when every read needs a param", () => {
    expect(verifyProbeOperation([read("list_orders", "customer.orders", ["customerId"])])).toBe(
      undefined,
    )
  })
})
