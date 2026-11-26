// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unit tests for `runConfigVerify` (the `liaison config verify` driver).
 * DB and probe calls are injected (`resolveOrgId` / `probe`) so this suite
 * never touches a live database or the network, mirroring `apply.test.ts`'s
 * seam-injection idiom. The production probe is the app's own
 * `provisioning.verify` handler (verify-probes.ts): the driver never reads a
 * credential.
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
  test("PASS: the app's check succeeds → status PASS, identity reported, exit 0", async () => {
    const seen: unknown[] = []
    const probe: VerifyProbe = async (input) => {
      seen.push(input)
      return { identity: "alice" }
    }
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe,
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.ok).toBe(true)
    expect(res.report.results).toEqual([
      { app: "gitlab", connection: "gitlab", status: "PASS", identity: "alice" },
    ])
    // The check is asked by app and org: it never receives the credential.
    expect(seen).toEqual([{ orgId: "org-1", appName: "gitlab" }])
  })

  test("the app's provision block reaches its check", async () => {
    const seen: unknown[] = []
    await runConfigVerify({
      config: configWith([{ ...gitlabApp, provision: { mode: "x" } }]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe: async (input) => {
        seen.push(input)
        return { identity: "alice" }
      },
      provisionCheck: async (_o, app) => ({ app, status: "PASS" }),
    })
    expect(seen).toEqual([{ orgId: "org-1", appName: "gitlab", provision: { mode: "x" } }])
  })

  test("FAIL: the check throws → status FAIL, non-zero exit, HTTP status surfaced", async () => {
    class FakeHttpError extends Error {
      status = 401
    }
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe: async () => {
        throw new FakeHttpError("AUTH_REVOKED: 401 Unauthorized")
      },
    })
    // The falsifiable assertion: a driver that never propagates a failed
    // check to a non-zero exit is a deploy gate that never gates.
    expect(res.exitCode).toBe(1)
    expect(res.report.ok).toBe(false)
    expect(res.report.results).toEqual([
      {
        app: "gitlab",
        connection: "gitlab",
        status: "FAIL",
        error: "AUTH_REVOKED: 401 Unauthorized",
        httpStatus: 401,
      },
    ])
  })

  test("SKIPPED: the app declares no check → SKIPPED, run still exits 0", async () => {
    const res = await runConfigVerify({
      config: configWith([
        { name: "shopify", enable: true, connection: { name: "shop", credentials: {} } },
      ]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe: async () => null,
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.results).toEqual([
      {
        app: "shopify",
        connection: "shop",
        status: "SKIPPED",
        error: "the app declares no verify check",
      },
    ])
  })

  test("a FAIL among several apps still fails the whole run (deploy-gate semantics)", async () => {
    const res = await runConfigVerify({
      config: configWith([
        { ...gitlabApp, name: "gitlab-ok" },
        { ...gitlabApp, name: "gitlab-bad" },
      ]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe: async ({ appName }) => {
        if (appName === "gitlab-bad") throw new Error("revoked")
        return { identity: "alice" }
      },
    })
    expect(res.exitCode).toBe(1)
    expect(res.report.results.map((r) => r.status)).toEqual(["PASS", "FAIL"])
  })

  test("org not found → exit 1, no check run", async () => {
    let probeCalled = false
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: () => {},
      resolveOrgId: async () => undefined,
      probe: async () => {
        probeCalled = true
        return { identity: "alice" }
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
    })
    expect(res.exitCode).toBe(2)
  })

  test("no connector apps in config → exit 0, empty results (not a failure)", async () => {
    const res = await runConfigVerify({
      config: configWith([]),
      log: () => {},
      resolveOrgId: async () => "org-1",
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.results).toEqual([])
  })

  test("the config file's secret never reaches log lines or the report", async () => {
    for (const fails of [false, true]) {
      const logs: string[] = []
      const res = await runConfigVerify({
        config: configWith([gitlabApp]),
        log: (m) => logs.push(m),
        resolveOrgId: async () => "org-1",
        probe: async () => {
          if (fails) throw new Error("upstream rejected the token")
          return { identity: "alice" }
        },
      })
      expect(JSON.stringify(res.report)).not.toContain(SECRET_TOKEN)
      expect(logs.join("\n")).not.toContain(SECRET_TOKEN)
    }
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

describe("runConfigVerify: app-held secrets", () => {
  const stripeApp: NonNullable<ProvisioningConfig["apps"]>[number] = {
    name: "stripe",
    enable: true,
    connection: { name: "stripe", credentials: { apiKey: SECRET_TOKEN } },
  }
  const webhooks = [
    { endpoint: "events", url: "https://liaison.example/webhooks/org-1/stripe/events" },
  ]

  test("a set secret: one line per secret and the webhook address, after the probe; exit 0", async () => {
    const logs: string[] = []
    const seen: unknown[] = []
    const res = await runConfigVerify({
      config: configWith([stripeApp]),
      appFilter: "stripe",
      log: (m) => logs.push(m),
      resolveOrgId: async () => "org-1",
      probe: async () => ({ identity: "acct_1" }),
      appSecretCheck: async (orgId, app, conn) => {
        seen.push([orgId, app, conn])
        return {
          connection: "stripe",
          secrets: [
            {
              key: "webhookSigningSecret",
              label: "Webhook signing secret",
              set: true,
              previousUntil: "2026-11-27T10:00:00.000Z",
            },
          ],
          webhooks,
        }
      },
    })
    expect(res.exitCode).toBe(0)
    expect(seen).toEqual([["org-1", "stripe", "stripe"]])
    expect(logs).toEqual([
      "app 'stripe': PASS (identity: acct_1)",
      "app 'stripe': secret 'webhookSigningSecret' set, previous still verifies until 2026-11-27T10:00:00.000Z",
      "app 'stripe': webhook 'events' address https://liaison.example/webhooks/org-1/stripe/events",
    ])
    expect(res.report.appSecrets).toEqual([
      {
        app: "stripe",
        connection: "stripe",
        key: "webhookSigningSecret",
        status: "SET",
        previousUntil: "2026-11-27T10:00:00.000Z",
      },
    ])
    expect(res.report.webhooks).toEqual([{ app: "stripe", ...webhooks[0] }])
  })

  test("a secret not set is a warning line, not a FAIL", async () => {
    const logs: string[] = []
    const res = await runConfigVerify({
      config: configWith([
        { name: "stripe", enable: true, appSecrets: { webhookSigningSecret: "" } },
      ]),
      log: (m) => logs.push(m),
      resolveOrgId: async () => "org-1",
      appSecretCheck: async () => ({
        connection: "stripe",
        secrets: [
          {
            key: "webhookSigningSecret",
            label: "Webhook signing secret",
            set: false,
            previousUntil: null,
          },
        ],
        webhooks,
      }),
    })
    expect(res.exitCode).toBe(0)
    expect(res.report.ok).toBe(true)
    expect(res.report.appSecrets?.[0]?.status).toBe("NOT_SET")
    expect(logs[0]).toStartWith("app 'stripe': secret 'webhookSigningSecret' not set (warning:")
    expect(logs[1]).toContain("address https://liaison.example/webhooks/org-1/stripe/events")
  })

  test("an app without settable secrets prints nothing more", async () => {
    const res = await runConfigVerify({
      config: configWith([gitlabApp]),
      log: () => {},
      resolveOrgId: async () => "org-1",
      probe: async () => ({ identity: "alice" }),
      appSecretCheck: async () => null,
    })
    expect(res.report.appSecrets).toBeUndefined()
    expect(res.report.webhooks).toBeUndefined()
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
