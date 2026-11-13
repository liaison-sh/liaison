// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { createRlsSession } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { listApprovals } from "~/modules/approvals/list"
import {
  appCrossAppCallsRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeTool, executeToolCore, parseOriginRun } from "~/modules/apps/execute-tool"
import { runApprovedToolHandler } from "~/modules/apps/run-approved-handler"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const TEST_ORG = "00000000-0000-0000-0000-000000130001"
const TEST_USER = "00000000-0000-0000-0000-000000130002"

describe("executeTool — sandbox path", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Sandbox ET Org', 'sandbox-et')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'sandbox-et@test.com', 'hash', 'Test', 'active')
      ON CONFLICT (id) DO NOTHING`
    await initSandboxPool()
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("routes manifest-format tool through sandbox execution", async () => {
    // Register a tool with a manifest-format handler
    const bundleSource = `function echo(params, ctx) { return { echoed: params.msg }; }`
    const bundlePath = "/tmp/test-sandbox-echo.js"
    await Bun.write(bundlePath, bundleSource)

    toolRegistry.set([TEST_ORG, "sandbox-test", "echo"], {
      appName: "sandbox-test",
      name: "echo",
      description: "Echo params",
      requiredScopes: ["sandbox-test:items:read"],
      handler: { bundlePath, exportName: "echo", core: true },
      _manifest: { name: "sandbox-test", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    const result = await executeTool({
      toolName: "sandbox-test:echo",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["sandbox-test:items:read"],
        dimensionGrants: {},
      },
      params: { msg: "hello" },
    })

    expect(result.data).toEqual({ echoed: "hello" })
  })

  it("legacy function handlers still execute in-process", async () => {
    toolRegistry.set([TEST_ORG, "legacy-test", "greet"], {
      appName: "legacy-test",
      name: "greet",
      description: "Greet",
      requiredScopes: ["legacy-test:items:read"],
      handler: async (params: any) => ({ greeting: `Hi ${params.name}` }),
    } as any)

    const result = await executeTool({
      toolName: "legacy-test:greet",
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["legacy-test:items:read"],
        dimensionGrants: {},
      },
      params: { name: "World" },
    })

    expect(result.data).toEqual({ greeting: "Hi World" })
  })

  it("untrusted-prod: a handler-thrown ToolError surfaces its REAL message + code (not redacted)", async () => {
    // A sandboxed handler that throws an app-sdk ToolError. The bundle cannot
    // import @liaison/app-sdk, but a real bundle build inlines the class; here
    // we reproduce the SAME thrown shape (name/safe/code/retryable) the built
    // ToolError produces, which is exactly what crosses the QuickJS boundary.
    const bundleSource = `
      class ToolError extends Error {
        constructor(message, opts) {
          super(message)
          this.name = "ToolError"
          this.safe = true
          this.code = opts.code
          this.retryable = opts.retryable === true
        }
      }
      function throwsSafe(params, ctx) {
        throw new ToolError(
          "No invoicing document found for order 1846: create a proforma and open the draft from it.",
          { code: "no_anchor_document", retryable: false },
        )
      }
    `
    const bundlePath = "/tmp/test-sandbox-throws-safe.js"
    await Bun.write(bundlePath, bundleSource)

    // trusted:false + no CHAOS_DEBUG => isUntrustedProd is true (the redaction mode).
    expect(process.env.CHAOS_DEBUG).toBeFalsy()
    toolRegistry.set([TEST_ORG, "safe-throw", "throwsSafe"], {
      appName: "safe-throw",
      name: "throwsSafe",
      description: "Throws a safe ToolError",
      requiredScopes: ["safe-throw:items:read"],
      handler: { bundlePath, exportName: "throwsSafe", core: false },
      _manifest: { name: "safe-throw", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    // The public executeTool wrapper throws on an error envelope, carrying
    // .code/.message/.details.retryable — assert the safe fields survive on it.
    let thrown: any
    try {
      await executeTool({
        toolName: "safe-throw:throwsSafe",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["safe-throw:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false) // should not reach — a rejected call throws
    } catch (err: any) {
      thrown = err
    }

    // The REAL safe message + code survive; NOT the opaque redaction.
    expect(thrown).toBeDefined()
    expect(thrown.message).not.toBe("Tool execution failed")
    expect(thrown.message).toContain("proforma")
    expect(thrown.code).toBe("no_anchor_document")
    expect(thrown.details?.retryable).toBe(false)
  })

  it("untrusted-prod control: a bare throw from the SAME sandboxed app STILL redacts to Tool execution failed", async () => {
    const bundleSource = `
      function throwsRaw(params, ctx) {
        throw new Error("secret internals: DB DSN postgres://user:pw@host/db")
      }
    `
    const bundlePath = "/tmp/test-sandbox-throws-raw.js"
    await Bun.write(bundlePath, bundleSource)

    expect(process.env.CHAOS_DEBUG).toBeFalsy()
    toolRegistry.set([TEST_ORG, "raw-throw", "throwsRaw"], {
      appName: "raw-throw",
      name: "throwsRaw",
      description: "Throws a bare Error",
      requiredScopes: ["raw-throw:items:read"],
      handler: { bundlePath, exportName: "throwsRaw", core: false },
      _manifest: { name: "raw-throw", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    let thrown: any
    try {
      await executeTool({
        toolName: "raw-throw:throwsRaw",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["raw-throw:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false) // should not reach — a rejected call throws
    } catch (err: any) {
      thrown = err
    }

    // The no-leak default holds: a bare throw is redacted, secrets never surface.
    expect(thrown).toBeDefined()
    expect(thrown.message).toBe("Tool execution failed")
    expect(thrown.message).not.toContain("secret internals")
    expect(thrown.code).toBe("tool_error")
  })

  it("untrusted-prod: an upstream 4xx a sandboxed handler throws keeps its status across the worker, still redacted", async () => {
    // A connector client throws its upstream's HTTP class on the error (Boxtal's
    // BoxtalApiError carries `status`). The worker marshalled only the message,
    // so the host saw a status-less throw: the agent got a 500 for a 422 it could
    // correct, and the kernel logged it at error level, paging the watchdog for
    // an upstream rejection.
    const bundleSource = `
      function throwsUpstream4xx(params, ctx) {
        const e = new Error("Boxtal v3 GET /shipping/v3.1/shipping-order/x failed (422)")
        e.status = 422
        throw e
      }
    `
    const bundlePath = "/tmp/test-sandbox-throws-upstream-4xx.js"
    await Bun.write(bundlePath, bundleSource)

    expect(process.env.CHAOS_DEBUG).toBeFalsy()
    toolRegistry.set([TEST_ORG, "upstream-throw", "throwsUpstream4xx"], {
      appName: "upstream-throw",
      name: "throwsUpstream4xx",
      description: "Throws an upstream 422",
      requiredScopes: ["upstream-throw:items:read"],
      handler: { bundlePath, exportName: "throwsUpstream4xx", core: false },
      _manifest: { name: "upstream-throw", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    let thrown: any
    try {
      await executeTool({
        toolName: "upstream-throw:throwsUpstream4xx",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["upstream-throw:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false)
    } catch (err: any) {
      thrown = err
    }
    expect(thrown.status).toBe(422)
    // The class crosses; the handler's text still does not.
    expect(thrown.message).toBe("Tool execution failed")
  })

  describe("untrusted-prod: a failure after an upstream error answer", () => {
    const ADS_HOST = "googleads.googleapis.com"
    const ADS_MESSAGE =
      "Google Ads API refused the request (HTTP 403 PERMISSION_DENIED, authorizationError.CUSTOMER_NOT_ENABLED): The customer account can't be accessed because it is not yet enabled or has been deactivated. To fix: the ad account in customerId is not enabled"

    afterEach(() => {
      SandboxBridgeTestAccess.setFetch(null)
      SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    })

    async function runAfterUpstream(app: string, exportName: string, bundleSource: string) {
      SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === ADS_HOST)
      SandboxBridgeTestAccess.setFetch(
        (async () =>
          new Response("<html>Forbidden</html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch,
      )
      const bundlePath = `/tmp/test-sandbox-${app}.js`
      await Bun.write(bundlePath, bundleSource)
      expect(process.env.CHAOS_DEBUG).toBeFalsy()
      toolRegistry.set([TEST_ORG, app, exportName], {
        appName: app,
        name: exportName,
        description: "Calls an upstream that refuses",
        requiredScopes: [`${app}:items:read`],
        handler: { bundlePath, exportName, core: false },
        _manifest: {
          name: app,
          schema: {},
          events: {},
          connections: {},
          network: { allowedDomains: [ADS_HOST] },
        },
      } as any)
      try {
        await executeTool({
          toolName: `${app}:${exportName}`,
          orgId: TEST_ORG,
          actor: {
            actorType: "user",
            userId: TEST_USER,
            orgId: TEST_ORG,
            scopes: [`${app}:items:read`],
            dimensionGrants: {},
          },
          params: {},
        })
      } catch (err) {
        return err as { message: string; status?: number }
      } finally {
        await Bun.file(bundlePath).delete()
      }
      throw new Error("the tool call should have failed")
    }

    it("the app's own error reaches the agent (sanitized), not the bridge's generic HTTP sentence", async () => {
      const thrown = await runAfterUpstream(
        "ads-refused",
        "listCampaigns",
        `
        class GoogleAdsApiError extends Error {
          constructor(message, status) { super(message); this.name = "GoogleAdsApiError"; this.status = status }
        }
        async function listCampaigns(params, ctx) {
          const r = await ctx.fetch("https://${ADS_HOST}/v21/customers/1234567890/googleAds:searchStream", { method: "POST" })
          throw new GoogleAdsApiError(${JSON.stringify(ADS_MESSAGE)} + " (see https://${ADS_HOST}/v21/x?access_token=ya29.SECRETSECRET, Bearer ya29.SECRETSECRET)", r.status)
        }
        `,
      )
      expect(thrown.message).toContain(ADS_MESSAGE)
      expect(thrown.message).not.toContain("which answered HTTP")
      expect(thrown.message).not.toContain("SECRETSECRET")
      expect(thrown.message).not.toContain("access_token=ya29")
      expect(thrown.status).toBe(403)
    })

    it("a runtime crash on the error body keeps the bridge's sentence naming the host", async () => {
      const thrown = await runAfterUpstream(
        "ads-crash",
        "listCampaigns",
        `
        async function listCampaigns(params, ctx) {
          const r = await ctx.fetch("https://${ADS_HOST}/v21/customers/1/googleAds:searchStream", { method: "POST" })
          return JSON.parse(r.body)
        }
        `,
      )
      expect(thrown.message).toContain(`called ${ADS_HOST}, which answered HTTP 403`)
      expect(thrown.message).not.toContain("JSON")
    })

    it("a long app message is bounded", async () => {
      const thrown = await runAfterUpstream(
        "ads-long",
        "listCampaigns",
        `
        async function listCampaigns(params, ctx) {
          await ctx.fetch("https://${ADS_HOST}/v21/customers/1/googleAds:searchStream", { method: "POST" })
          throw new Error("HTTP 403: " + "x".repeat(5000))
        }
        `,
      )
      expect(thrown.message.startsWith("HTTP 403: xxx")).toBe(true)
      expect(thrown.message.length).toBeLessThanOrEqual(800)
    })
  })

  it("untrusted-prod: a sandbox TIMEOUT surfaces as a typed 'timeout' error, not the generic redaction", async () => {
    // A handler that never resolves: the worker-pool budget fires
    // "App execution timed out". That is operational state (the boxtal
    // print_pack 8s-default class), not handler internals — the caller must
    // see "timed out", never an opaque "Tool execution failed" that gives the
    // human clicking the button zero signal.
    const bundleSource = `
      function hangs(params, ctx) {
        return new Promise(() => {})
      }
    `
    const bundlePath = "/tmp/test-sandbox-hangs.js"
    await Bun.write(bundlePath, bundleSource)

    expect(process.env.CHAOS_DEBUG).toBeFalsy()
    toolRegistry.set([TEST_ORG, "hang-app", "hangs"], {
      appName: "hang-app",
      name: "hangs",
      description: "Never resolves",
      requiredScopes: ["hang-app:items:read"],
      handler: { bundlePath, exportName: "hangs", core: false },
      timeoutMs: 500, // tiny budget so the test completes fast
      _manifest: { name: "hang-app", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    // resolveToolTimeoutMs FLOORS the declared budget at the sandbox default
    // (60s outside production), which would swallow the 500ms above. It reads
    // process.env at call time, so lower the floor for this call only.
    const prevDefault = process.env.LIAISON_SANDBOX_TIMEOUT_MS
    process.env.LIAISON_SANDBOX_TIMEOUT_MS = "500"
    let thrown: any
    try {
      await executeTool({
        toolName: "hang-app:hangs",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["hang-app:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false) // should not reach — a timeout throws
    } catch (err: any) {
      thrown = err
    } finally {
      if (prevDefault === undefined) delete process.env.LIAISON_SANDBOX_TIMEOUT_MS
      else process.env.LIAISON_SANDBOX_TIMEOUT_MS = prevDefault
    }

    expect(thrown).toBeDefined()
    expect(thrown.code).toBe("timeout")
    expect(thrown.status).toBe(504)
    expect(thrown.message).toContain("timed out")
    expect(thrown.message).not.toBe("Tool execution failed")
    expect(thrown.details?.retryable).toBe(true)
  }, 30_000)

  it("untrusted-prod: an upstream request past its deadline surfaces as a typed, retryable 'upstream_timeout'", async () => {
    // The egress bridge's own words when an app's fetch runs past its timeoutMs (a slow upstream:
    // a carrier quote that took 5 s once and 0.9 s on the retry). Not handler internals.
    const bundlePath = "/tmp/test-sandbox-fetch-timeout.js"
    await Bun.write(
      bundlePath,
      `function slow(params, ctx) { throw new Error("Fetch timed out after 5000ms") }`,
    )
    expect(process.env.CHAOS_DEBUG).toBeFalsy()
    toolRegistry.set([TEST_ORG, "slow-app", "slow"], {
      appName: "slow-app",
      name: "slow",
      description: "Upstream too slow",
      requiredScopes: ["slow-app:items:read"],
      handler: { bundlePath, exportName: "slow", core: false },
      _manifest: { name: "slow-app", schema: {}, events: {}, connections: {}, network: {} },
    } as any)
    let thrown: any
    try {
      await executeTool({
        toolName: "slow-app:slow",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["slow-app:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false)
    } catch (err: any) {
      thrown = err
    }
    expect(thrown.code).toBe("upstream_timeout")
    expect(thrown.status).toBe(504)
    expect(thrown.message).toContain("timed out after 5000 ms")
    expect(thrown.message).not.toBe("Tool execution failed")
    expect(thrown.details?.retryable).toBe(true)
  }, 30_000)

  it("step 7 validates params via Ajv for manifest-format tools", async () => {
    const bundleSource = `function strict(params, ctx) { return params; }`
    const bundlePath = "/tmp/test-sandbox-strict.js"
    await Bun.write(bundlePath, bundleSource)

    toolRegistry.set([TEST_ORG, "ajv-test", "strict"], {
      appName: "ajv-test",
      name: "strict",
      description: "Strict params",
      requiredScopes: ["ajv-test:items:read"],
      handler: { bundlePath, exportName: "strict", core: true },
      params: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      _manifest: { name: "ajv-test", schema: {}, events: {}, connections: {}, network: {} },
    } as any)

    // Missing required param → 400
    try {
      await executeTool({
        toolName: "ajv-test:strict",
        orgId: TEST_ORG,
        actor: {
          actorType: "user",
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes: ["ajv-test:items:read"],
          dimensionGrants: {},
        },
        params: {},
      })
      expect(true).toBe(false) // should not reach
    } catch (err: any) {
      expect(err.status ?? err.getResponse?.()?.status).toBe(400)
    }
  })

  // Regression: a cross-app ctx.executeTool call re-enters the kernel through the
  // sandbox rpc-bridge's `executeTool` method. That bridge method must forward the
  // originating dispatch's `origin`, or the re-entry looks like a direct human UI
  // click (origin undefined + actorType "user") and silently skips the approval
  // gate on a GATED target tool, running it with no approval ever created.
  describe("cross app origin forwarding: gate must not be skipped", () => {
    const BRIDGE_THREAD = "00000000-0000-0000-0000-000000130010"
    let gatedSendCalls = 0

    const bridgeActor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["bridge-caller:items:write", "bridge-target:items:write", "bridge-target:approve"],
      dimensionGrants: { "*": ["*"] },
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${BRIDGE_THREAD}, ${TEST_ORG}, 'bridge-origin-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE id = ${BRIDGE_THREAD}`
    })

    beforeEach(async () => {
      gatedSendCalls = 0
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`

      const callerBundleSource = `
        async function callGated(params, ctx) {
          var env = JSON.parse(await ctx.executeTool("bridge-target:gatedSend", JSON.stringify({})))
          if (env.error) return { error: env.error }
          if (env.blocked) return { blocked: env.blocked }
          return { data: env.data }
        }
      `
      const callerBundlePath = "/tmp/test-bridge-origin-caller.js"
      await Bun.write(callerBundlePath, callerBundleSource)

      toolRegistry.set([TEST_ORG, "bridge-caller", "call"], {
        appName: "bridge-caller",
        name: "call",
        description: "Calls bridge-target:gatedSend cross-app",
        requiredScopes: ["bridge-caller:items:write"],
        gated: false,
        handler: { bundlePath: callerBundlePath, exportName: "callGated", core: true },
        _manifest: { name: "bridge-caller", schema: {}, events: {}, connections: {}, network: {} },
      } as any)

      toolRegistry.set([TEST_ORG, "bridge-target", "gatedSend"], {
        appName: "bridge-target",
        name: "gatedSend",
        description: "Gated target tool (simulates an outbound send)",
        requiredScopes: ["bridge-target:items:write"],
        gated: true,
        handler: async () => {
          gatedSendCalls += 1
          return { sent: true }
        },
      } as any)
    })

    it("in-app-agent cross-app call: target handler does not run, a pending approval is created and visible to the requester", async () => {
      const result = await executeTool({
        toolName: "bridge-caller:call",
        orgId: TEST_ORG,
        actor: bridgeActor,
        threadId: BRIDGE_THREAD,
        params: {},
        origin: "in-app-agent",
      })

      // (a) the gated target's handler must NOT have run — no outbound send occurred.
      expect(gatedSendCalls).toBe(0)

      // (b) a pending approval row exists, requested by the invoking user.
      const rows = await sql`
        SELECT status, requested_by, tool_name FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'bridge-target:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
      expect(rows[0].requested_by).toBe(TEST_USER)

      // (c) the approval is visible to the requester through the real list path,
      // not just via a privileged connection.
      const session = createRlsSession(bridgeActor)
      const approvals = await session.run((tx) =>
        listApprovals(tx, { orgId: TEST_ORG, userId: TEST_USER, scopes: bridgeActor.scopes }),
      )
      expect(approvals.some((a) => a.toolName === "bridge-target:gatedSend")).toBe(true)

      expect((result.data as any)?.blocked?.reason).toBe("gated")
    })

    it("direct call that omits origin is gated, never treated as a human UI click", async () => {
      // Regression test for the discriminator bug: absence of origin must never
      // be read as proof of a human clicked the approve button. executeTool()
      // defaults an omitted origin to "in-app-agent" (fail-closed), so this
      // must gate exactly like the explicit in-app-agent call above, not
      // auto-execute.
      const result = await executeTool({
        toolName: "bridge-target:gatedSend",
        orgId: TEST_ORG,
        actor: bridgeActor,
        threadId: BRIDGE_THREAD,
        params: {},
        // origin intentionally omitted
      })

      expect(gatedSendCalls).toBe(0)
      expect(result.blocked?.reason).toBe("gated")

      const rows = await sql`
        SELECT id, status FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'bridge-target:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
    })

    it("human-ui direct call auto executes past the gate (the human click IS the approval)", async () => {
      // The genuine bypass case still works: a real origin:"human-ui" call on
      // the gated tool directly (not through a cross-app hop) auto-executes
      // when the actor holds the approve scope.
      const result = await executeTool({
        toolName: "bridge-target:gatedSend",
        orgId: TEST_ORG,
        actor: bridgeActor,
        threadId: BRIDGE_THREAD,
        params: {},
        origin: "human-ui",
      })

      expect(gatedSendCalls).toBe(1)
      expect(result.blocked).toBeUndefined()

      const rows = await sql`
        SELECT id FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'bridge-target:gatedSend'
      `
      expect(rows.length).toBe(0)
    })

    it("human-ui OUTER call: a cross-app hop to a gated tool in a DIFFERENT app still gates, never inherits the human click", async () => {
      // The exact shape of the original incident: a human clicks an UNGATED
      // tool in app A (bridge-caller:call, origin "human-ui"); its handler
      // cross-calls a GATED tool in app B (bridge-target:gatedSend) via
      // ctx.executeTool. The actor holds bridge-target:approve, which would
      // auto-execute a GENUINE origin:"human-ui" call on gatedSend directly
      // (see the test above) -- but the human only clicked A, never approved
      // B, so the cross-app hop must downgrade "human-ui" and gate B instead
      // of silently sending.
      const result = await executeTool({
        toolName: "bridge-caller:call",
        orgId: TEST_ORG,
        actor: bridgeActor,
        threadId: BRIDGE_THREAD,
        params: {},
        origin: "human-ui",
      })

      expect(gatedSendCalls).toBe(0)

      const rows = await sql`
        SELECT status, requested_by, tool_name FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'bridge-target:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
      expect(rows[0].requested_by).toBe(TEST_USER)

      expect((result.data as any)?.blocked?.reason).toBe("gated")
    })

    describe('machine-authorized cross-app call: origin "system" + declared cross_app_calls executes deterministically', () => {
      const MACHINE_CALLER = "bridge-machine-caller"
      const systemActor = {
        actorType: "system" as const,
        orgId: TEST_ORG,
        purpose: "job" as const,
        scopes: [] as string[],
      }

      it("reproduces the reported webhook shape (system actor, NO thread, gated cross-app target) and now EXECUTES instead of throwing 'threadId required'", async () => {
        appCrossAppCallsRegistry.set([TEST_ORG, MACHINE_CALLER], {
          targets: ["bridge-target:gatedSend"],
        })

        const result = await executeToolCore({
          toolName: "bridge-target:gatedSend",
          orgId: TEST_ORG,
          actor: systemActor,
          // No threadId -- this is the webhook shape: boxtal's tracking-number
          // handler has no thread to attach an approval request to.
          params: {},
          origin: "system",
          internalCall: { callerApp: MACHINE_CALLER },
        })

        expect("error" in result ? result.error.message : "").not.toContain("threadId required")
        expect("error" in result).toBe(false)
        expect("blocked" in result).toBe(false)
        expect(gatedSendCalls).toBe(1)
      })

      it("the SAME call with origin in-app-agent still returns a pending approval (machine-authorization never applies to a UI-attributed hop)", async () => {
        appCrossAppCallsRegistry.set([TEST_ORG, MACHINE_CALLER], {
          targets: ["bridge-target:gatedSend"],
        })

        // Real user actor here (not systemActor): approval-request creation
        // requires a real requestedBy user row, orthogonal to this arm -- the
        // point under test is purely that origin !== "system" never skips,
        // regardless of the declared cross_app_calls capability.
        const result = await executeToolCore({
          toolName: "bridge-target:gatedSend",
          orgId: TEST_ORG,
          actor: bridgeActor,
          threadId: BRIDGE_THREAD,
          params: {},
          origin: "in-app-agent",
          internalCall: { callerApp: MACHINE_CALLER },
        })

        expect(gatedSendCalls).toBe(0)
        expect("blocked" in result ? result.blocked.reason : undefined).toBe("gated")
      })

      it('the SAME call with origin mcp also still gates (machine-authorization is origin "system" only)', async () => {
        appCrossAppCallsRegistry.set([TEST_ORG, MACHINE_CALLER], {
          targets: ["bridge-target:gatedSend"],
        })

        const result = await executeToolCore({
          toolName: "bridge-target:gatedSend",
          orgId: TEST_ORG,
          actor: bridgeActor,
          threadId: BRIDGE_THREAD,
          params: {},
          origin: "mcp",
          internalCall: { callerApp: MACHINE_CALLER },
        })

        expect(gatedSendCalls).toBe(0)
        expect("blocked" in result ? result.blocked.reason : undefined).toBe("gated")
      })
    })
  })

  describe("replayed approval: a nested cross-app call still gates, even for a recorded human-ui origin", () => {
    const REPLAY_THREAD = "00000000-0000-0000-0000-000000130020"
    let replayGatedSendCalls = 0

    // A person's own call no longer parks an approval, so the OUTER approval is
    // staged as an agent call (an agent call on a gated tool always parks) and
    // then stamped with the legacy "human-ui" origin. No N-eyes policy: one
    // would be refused at stage time (approvers_unavailable), since nobody in
    // this org holds bridge-caller-r:approve.
    const replayActor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: [
        "bridge-caller-r:items:write",
        "bridge-target-r:items:write",
        "bridge-target-r:approve",
      ],
      dimensionGrants: { "*": ["*"] },
    }
    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${REPLAY_THREAD}, ${TEST_ORG}, 'bridge-replay-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
      // cascade.ts's executeApprovedStep reloads the REQUESTER's scopes fresh
      // from the DB (loadRequesterContext), not from replayActor's in-memory
      // literal, so the replay-through-cascade test needs real grants.
      for (const scope of ["bridge-caller-r:items:write", "bridge-target-r:items:write"]) {
        await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
          VALUES (${TEST_USER}, ${TEST_ORG}, ${scope})
          ON CONFLICT (user_id, org_id, scope) DO NOTHING`
      }
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${TEST_USER} AND org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE id = ${REPLAY_THREAD}`
    })

    beforeEach(async () => {
      replayGatedSendCalls = 0
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`

      const callerBundleSource = `
        async function callGated(params, ctx) {
          var env = JSON.parse(await ctx.executeTool("bridge-target-r:gatedSend", JSON.stringify({})))
          if (env.error) return { error: env.error }
          if (env.blocked) return { blocked: env.blocked }
          return { data: env.data }
        }
      `
      const callerBundlePath = "/tmp/test-bridge-replay-caller.js"
      await Bun.write(callerBundlePath, callerBundleSource)

      toolRegistry.set([TEST_ORG, "bridge-caller-r", "call"], {
        appName: "bridge-caller-r",
        name: "call",
        description: "Gated caller: cross-calls bridge-target-r:gatedSend",
        requiredScopes: ["bridge-caller-r:items:write"],
        // Gated with no approve scope granted above, so a direct human-ui call
        // on THIS tool still parks for approval instead of bypassing.
        gated: true,
        handler: { bundlePath: callerBundlePath, exportName: "callGated", core: true },
        _manifest: {
          name: "bridge-caller-r",
          schema: {},
          events: {},
          connections: {},
          network: {},
        },
      } as any)

      toolRegistry.set([TEST_ORG, "bridge-target-r", "gatedSend"], {
        appName: "bridge-target-r",
        name: "gatedSend",
        description: "Gated target tool (simulates an outbound send)",
        requiredScopes: ["bridge-target-r:items:write"],
        gated: true,
        handler: async () => {
          replayGatedSendCalls += 1
          return { sent: true }
        },
      } as any)
    })

    it("a recorded human-ui approval, once approved and replayed, still gates its own nested cross-app call", async () => {
      // 1) An approval whose recorded origin is "human-ui". A person's own call
      // no longer parks an approval (it runs on their scope or is refused), but
      // rows staged before that rule still carry the origin, so the replay
      // path must keep handling it. Staged as an agent call, then stamped with
      // the legacy origin.
      const staged = await executeTool({
        toolName: "bridge-caller-r:call",
        orgId: TEST_ORG,
        actor: replayActor,
        threadId: REPLAY_THREAD,
        params: {},
        origin: "in-app-agent",
      })
      const outerApprovalId = staged.blocked?.approvalRequestId
      expect(typeof outerApprovalId).toBe("string")
      expect(replayGatedSendCalls).toBe(0)
      await sql`
        UPDATE kernel.approval_requests
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{origin}', '"human-ui"'::jsonb)
        WHERE id = ${outerApprovalId as string}`

      // 2) Replay it through the REAL production entrypoint, cascade.ts's
      // executeApprovedStep (what decide.ts's approve flow actually calls: it
      // claims pending -> approving, runs run-approved-handler.ts's
      // runApprovedToolHandler, then terminalizes). This exercises the widened
      // RunApprovedToolHandlerArgs.origin type with a real "human-ui" value at
      // runtime, the same as the persisted metadata this row actually carries.
      const { executeApprovedStep } = await import("~/modules/approvals/cascade")
      const outcome = await executeApprovedStep({
        orgId: TEST_ORG,
        approvalId: outerApprovalId as string,
        sourceStatus: "pending",
        decider: replayActor,
        deciderId: TEST_USER,
      })

      // The critical, security-relevant assertion: the NESTED cross-app call to
      // bridge-target-r:gatedSend must NEVER auto-execute here, no matter how
      // it is handled, even though replayActor holds bridge-target-r:approve and
      // the replayed origin is "human-ui". "bridge-target-r:gatedSend" is an
      // UNDECLARED cross-app target (bridge-caller-r's manifest declares no
      // cross_app_calls, and no appCrossAppCallsRegistry entry exists for it in
      // this describe block), so it must stay gated no matter how the OUTER
      // call was authorized.
      expect(replayGatedSendCalls).toBe(0)
      // run-approved-handler.ts now forwards the originating threadId into the
      // nested handler bridge (execute-tool.ts's executeApprovedToolHandlerInternal
      // threadId param), so the nested gated call can park a clean pending
      // approval instead of failing closed on "threadId required to create an
      // approval request" and wedging the OUTER approval back to pending. The
      // outer handler's own bundle treats a `{ blocked }` envelope as a normal
      // return value (not a thrown error), so the step succeeds.
      expect(outcome.kind).toBe("succeeded")

      const rows = await sql`
        SELECT status, tool_name FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'bridge-target-r:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")

      // The OUTER approval terminalizes as approved -- it did its job (staging
      // the nested action for its own, separate human review), it is not left
      // wedged in "approving".
      const [outerRow] =
        await sql`SELECT status FROM kernel.approval_requests WHERE id = ${outerApprovalId as string}`
      expect(outerRow.status).toBe("approved")
    })
  })

  // A human clicking a button in an app UI must NEVER create an approval feed
  // item -- the approval gate exists to stop AGENTS, not the human who is, in
  // this call, the reviewer by construction. That extends one hop deep into a
  // DECLARED cross_app_calls target: the human already reviewed the outer
  // action, so a deterministic consequence of it must not park its own,
  // separate approval the human never sees.
  describe("human-authorized cross-app dispatch: a DECLARED target skips the gate", () => {
    const HA_THREAD = "00000000-0000-0000-0000-000000130030"
    let haGatedSendCalls = 0

    // Holds the OUTER app's approve scope (`ha-caller:approve`) but NOT the
    // target's (`ha-target:approve`): the human-UI click only counts as an
    // authorization when the clicking user could have approved that outer
    // action themselves. Without the approve scope the click carries no gate
    // skip at all -- see the negative test below.
    const haActor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["ha-caller:items:write", "ha-caller:approve", "ha-target:items:write"],
      dimensionGrants: { "*": ["*"] },
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${HA_THREAD}, ${TEST_ORG}, 'human-auth-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
      // cascade.ts's executeApprovedStep reloads the REQUESTER's scopes fresh
      // from the DB (loadRequesterContext), not from haActor's in-memory
      // literal, so the approve-through-cascade test needs real grants.
      for (const scope of ["ha-caller:items:write", "ha-target:items:write"]) {
        await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
          VALUES (${TEST_USER}, ${TEST_ORG}, ${scope})
          ON CONFLICT (user_id, org_id, scope) DO NOTHING`
      }
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${TEST_USER} AND org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE id = ${HA_THREAD}`
    })

    beforeEach(async () => {
      haGatedSendCalls = 0
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`

      const callerBundleSource = `
        async function callGated(params, ctx) {
          var env = JSON.parse(await ctx.executeTool("ha-target:gatedSend", JSON.stringify({})))
          if (env.error) return { error: env.error }
          if (env.blocked) return { blocked: env.blocked }
          return { data: env.data }
        }
      `
      const callerBundlePath = "/tmp/test-human-authorized-caller.js"
      await Bun.write(callerBundlePath, callerBundleSource)

      toolRegistry.set([TEST_ORG, "ha-caller", "call"], {
        appName: "ha-caller",
        name: "call",
        description: "Cross-calls ha-target:gatedSend, a DECLARED cross_app_calls target",
        requiredScopes: ["ha-caller:items:write"],
        gated: false,
        handler: { bundlePath: callerBundlePath, exportName: "callGated", core: true },
        _manifest: { name: "ha-caller", schema: {}, events: {}, connections: {}, network: {} },
      } as any)

      toolRegistry.set([TEST_ORG, "ha-caller-gated", "call"], {
        appName: "ha-caller-gated",
        name: "call",
        description: "GATED outer tool; approved execution cross-calls ha-target:gatedSend",
        requiredScopes: ["ha-caller:items:write"],
        gated: true,
        handler: { bundlePath: callerBundlePath, exportName: "callGated", core: true },
        _manifest: {
          name: "ha-caller-gated",
          schema: {},
          events: {},
          connections: {},
          network: {},
        },
      } as any)

      toolRegistry.set([TEST_ORG, "ha-target", "gatedSend"], {
        appName: "ha-target",
        name: "gatedSend",
        description: "Gated target tool (simulates an outbound send)",
        requiredScopes: ["ha-target:items:write"],
        gated: true,
        handler: async () => {
          haGatedSendCalls += 1
          return { sent: true }
        },
      } as any)
    })

    it("direct human-UI outer call: nested call to a DECLARED target executes, no PENDING approval for it", async () => {
      appCrossAppCallsRegistry.set([TEST_ORG, "ha-caller"], { targets: ["ha-target:gatedSend"] })

      const result = await executeTool({
        toolName: "ha-caller:call",
        orgId: TEST_ORG,
        actor: haActor,
        threadId: HA_THREAD,
        params: {},
        origin: "human-ui",
      })

      expect(haGatedSendCalls).toBe(1)
      // The nested call executed -- no human ever sees a pending item for it.
      // A synthetic, pre-decided "approved" audit row IS still written (mirrors
      // the machine-authorized cross-app arm), so the dispatch stays auditable;
      // it is never a PENDING approval-feed item.
      const rows = await sql`
        SELECT status, reason, metadata FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'ha-target:gatedSend'
      `
      expect(rows.every((r) => (r as { status: string }).status !== "pending")).toBe(true)
      expect((result.data as any)?.data?.sent).toBe(true)
      // The audit row must be distinguishable from the MACHINE-authorized arm:
      // both share reason "auto_approved_by_capability", so the human marker is
      // the only thing that says a person's click stood behind this hop.
      const [auditRow] = rows as unknown as {
        reason: string
        metadata: Record<string, unknown>
      }[]
      expect(auditRow.reason).toBe("auto_approved_by_capability")
      expect(auditRow.metadata.autoApprovedByCapability).toBe("ha-caller")
      expect(auditRow.metadata.humanAuthorized).toBe(true)
      expect(auditRow.metadata.authorizedVia).toBe("human-ui")
      expect(auditRow.metadata.outerActorId).toBe(TEST_USER)
    })

    it("direct human-UI outer call by a user WITHOUT the outer tool's approve scope: the nested DECLARED target PARKS an approval, never executes", async () => {
      // The hole the human-authorized arm opened if it read provenance off
      // `origin` alone: ha-caller:call is UNGATED, so a user holding only
      // `ha-caller:items:write` can call it freely. If that click alone marked
      // the handler "human-authorized", their nested hop into the GATED
      // ha-target:gatedSend would execute -- a write-scope user performing a
      // gated action nobody approved. Authorization requires the approve scope.
      appCrossAppCallsRegistry.set([TEST_ORG, "ha-caller"], { targets: ["ha-target:gatedSend"] })

      const noApproveActor = {
        ...haActor,
        scopes: ["ha-caller:items:write", "ha-target:items:write"],
      }
      await executeTool({
        toolName: "ha-caller:call",
        orgId: TEST_ORG,
        actor: noApproveActor,
        threadId: HA_THREAD,
        params: {},
        origin: "human-ui",
      })

      expect(haGatedSendCalls).toBe(0)
      const rows = await sql`
        SELECT status FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'ha-target:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
    })

    it("direct human-UI outer call: nested call to an UNDECLARED target still gates", async () => {
      // No appCrossAppCallsRegistry entry for "ha-caller" in this test -- the
      // target is not declared, so it must stay gated no matter how the outer
      // call was authorized.
      const result = await executeTool({
        toolName: "ha-caller:call",
        orgId: TEST_ORG,
        actor: haActor,
        threadId: HA_THREAD,
        params: {},
        origin: "human-ui",
      })

      expect(haGatedSendCalls).toBe(0)
      const rows = await sql`
        SELECT status FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'ha-target:gatedSend'
      `
      expect(rows.length).toBe(1)
      expect(rows[0].status).toBe("pending")
    })

    it("approved execution of a GATED outer tool: nested call to a DECLARED target executes, outer approval terminalises approved, no last_failure", async () => {
      appCrossAppCallsRegistry.set([TEST_ORG, "ha-caller-gated"], {
        targets: ["ha-target:gatedSend"],
      })

      // 1) Stage the outer gated tool via a non-human origin -- the point under
      // test is that the human-authorization signal comes from the approval
      // itself (approvalContext at re-entry), not from a forwarded "human-ui"
      // origin.
      const staged = await executeTool({
        toolName: "ha-caller-gated:call",
        orgId: TEST_ORG,
        actor: haActor,
        threadId: HA_THREAD,
        params: {},
        origin: "in-app-agent",
      })
      const outerApprovalId = staged.blocked?.approvalRequestId
      expect(typeof outerApprovalId).toBe("string")
      expect(haGatedSendCalls).toBe(0)

      // 2) A human approves it -- cascade.ts's executeApprovedStep is the real
      // production entrypoint decide.ts's approve flow calls (claim
      // pending -> approving, run the handler, terminalize).
      const { executeApprovedStep } = await import("~/modules/approvals/cascade")
      const outcome = await executeApprovedStep({
        orgId: TEST_ORG,
        approvalId: outerApprovalId as string,
        sourceStatus: "pending",
        decider: haActor,
        deciderId: TEST_USER,
      })
      expect(outcome.kind).toBe("succeeded")

      // The nested DECLARED-target call executed for real -- the human already
      // reviewed the outer action.
      expect(haGatedSendCalls).toBe(1)
      const { readDecidedResult } = await import("~/modules/approvals/read-decided-result")
      const decidedResult = await readDecidedResult(TEST_ORG, outerApprovalId as string)
      expect((decidedResult as any)?.data?.sent).toBe(true)
      // No PENDING approval for the nested call -- only the synthetic,
      // pre-decided audit row (same as the direct human-UI case above).
      const nestedRows = await sql`
        SELECT status, metadata FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name = 'ha-target:gatedSend'
      `
      expect(nestedRows.every((r) => (r as { status: string }).status !== "pending")).toBe(true)
      // Audit marker: authorized by the OUTER APPROVAL, and it names which one.
      const nestedMeta = (nestedRows[0] as unknown as { metadata: Record<string, unknown> })
        .metadata
      expect(nestedMeta.humanAuthorized).toBe(true)
      expect(nestedMeta.authorizedVia).toBe("approval")
      expect(nestedMeta.approvalRequestId).toBe(outerApprovalId as string)

      // The outer approval terminalises approved, not wedged back to pending
      // with a last_failure.
      const [outerRow] =
        await sql`SELECT status FROM kernel.approval_requests WHERE id = ${outerApprovalId as string}`
      expect(outerRow.status).toBe("approved")
      const { readApprovalLastFailure } = await import("~/modules/approvals/last-failure")
      const { withPrivilegedDb } = await import("~/db/privileged")
      const lastFailure = await withPrivilegedDb(TEST_ORG, "t", (tx) =>
        readApprovalLastFailure(tx, TEST_ORG, outerApprovalId as string),
      )
      expect(lastFailure).toBeNull()
    })
  })

  // Regression (security review of the rulings follow-up): every cross-app hop
  // runs its handler under an RLS actor that unions the TARGET app's `*` into
  // the person's scopes. A nested call two hops down a person's click
  // (person -> A:x -> B:y -> B:gated) must therefore never be judged as the
  // person's own call: that actor "holds" B:approve the person never had. The
  // hop is relabelled in-app-agent and gated like any agent call.
  describe("two hops below a person's click: the target's gate is never skipped", () => {
    const HOP_THREAD = "00000000-0000-0000-0000-000000130030"
    let hopGatedCalls = 0
    const person = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      // Holds A's write AND approve scopes (the strongest outer click), nothing of B.
      scopes: ["hop-a:items:write", "hop-a:approve"],
      dimensionGrants: { "*": ["*"] },
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${HOP_THREAD}, ${TEST_ORG}, 'hop-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG} AND (id = ${HOP_THREAD} OR created_from->>'entityType' = 'approval_request')`
    })

    async function register(bBody: string) {
      hopGatedCalls = 0
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      const aPath = "/tmp/test-hop-a.js"
      await Bun.write(
        aPath,
        `async function x(params, ctx) {
          var env = JSON.parse(await ctx.executeTool("hop-b:y", JSON.stringify({})))
          return env
        }`,
      )
      const bPath = "/tmp/test-hop-b.js"
      await Bun.write(bPath, `async function y(params, ctx) { ${bBody} }`)
      appCrossAppCallsRegistry.set([TEST_ORG, "hop-a"], { targets: ["hop-b:y"] })
      toolRegistry.set([TEST_ORG, "hop-a", "x"], {
        appName: "hop-a",
        name: "x",
        description: "A: cross-calls B:y",
        requiredScopes: ["hop-a:items:write"],
        gated: false,
        handler: { bundlePath: aPath, exportName: "x", core: true },
        _manifest: { name: "hop-a", schema: {}, events: {}, connections: {}, network: {} },
      } as any)
      toolRegistry.set([TEST_ORG, "hop-b", "y"], {
        appName: "hop-b",
        name: "y",
        description: "B: calls its own gated tool",
        requiredScopes: ["hop-b:items:write"],
        gated: false,
        handler: { bundlePath: bPath, exportName: "y", core: true },
        _manifest: { name: "hop-b", schema: {}, events: {}, connections: {}, network: {} },
      } as any)
      toolRegistry.set([TEST_ORG, "hop-b", "gated"], {
        appName: "hop-b",
        name: "gated",
        description: "B: gated outbound action",
        requiredScopes: ["hop-b:items:write"],
        gated: true,
        handler: async () => {
          hopGatedCalls += 1
          return { sent: true }
        },
      } as any)
    }

    async function hopRows() {
      return sql`SELECT status FROM kernel.approval_requests
        WHERE org_id = ${TEST_ORG} AND tool_name LIKE 'hop-b:%'`
    }

    it("person (no B:approve) -> A:x -> B:y -> B:gated: never executes, parks for an approver", async () => {
      await register(`return JSON.parse(await ctx.executeTool("hop-b:gated", JSON.stringify({})))`)
      let out: any = null
      try {
        out = await executeTool({
          toolName: "hop-a:x",
          orgId: TEST_ORG,
          actor: person,
          threadId: HOP_THREAD,
          params: {},
          origin: "human-ui",
        })
      } catch (err) {
        out = { thrown: err }
      }
      expect(hopGatedCalls).toBe(0)
      const rows = await hopRows()
      // Parked (or refused): never run on the unioned B:* the hop's actor carries.
      expect(rows.every((r) => (r as { status: string }).status === "pending")).toBe(true)
      expect(out).not.toBeNull()
    })

    it("person -> A:x -> B:y whose handler calls ctx.requestApproval: never granted inline", async () => {
      await register(
        `return JSON.parse(await ctx.requestApproval(JSON.stringify({ tool_name: "hop-b:gated", summary: "s", current_payload: {} })))`,
      )
      let out: any = null
      try {
        out = await executeTool({
          toolName: "hop-a:x",
          orgId: TEST_ORG,
          actor: person,
          threadId: HOP_THREAD,
          params: {},
          origin: "human-ui",
        })
      } catch (err) {
        out = { thrown: err }
      }
      expect(hopGatedCalls).toBe(0)
      expect(JSON.stringify(out)).not.toContain('"auto_approved":true')
      const rows = await hopRows()
      expect(rows.length).toBe(1)
      expect((rows[0] as { status: string }).status).toBe("pending")
    })
  })

  // A person's own direct call whose handler asks ctx.requestApproval: decided
  // on the PERSON'S own scopes (never a widened RLS actor). Without the
  // deciding scope it is refused 403; with it, granted inline; never parked.
  describe("a direct person call whose handler requests approval", () => {
    const RQ_THREAD = "00000000-0000-0000-0000-000000130040"
    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${RQ_THREAD}, ${TEST_ORG}, 'rq-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
    })
    beforeEach(async () => {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      const path = "/tmp/test-rq-a.js"
      await Bun.write(
        path,
        `async function x(params, ctx) {
          var r = JSON.parse(await ctx.requestApproval(JSON.stringify({ tool_name: "rq-a:x", summary: "s", current_payload: {} })))
          return { granted: r.auto_approved === true, approval_id: r.approval_id }
        }`,
      )
      toolRegistry.set([TEST_ORG, "rq-a", "x"], {
        appName: "rq-a",
        name: "x",
        description: "asks approval for itself mid-run",
        requiredScopes: ["rq-a:items:write"],
        gated: false,
        handler: { bundlePath: path, exportName: "x", core: true },
        _manifest: { name: "rq-a", schema: {}, events: {}, connections: {}, network: {} },
      } as any)
    })
    afterAll(async () => {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE id = ${RQ_THREAD}`
    })
    const call = (scopes: string[]) =>
      executeTool({
        toolName: "rq-a:x",
        orgId: TEST_ORG,
        actor: {
          actorType: "user" as const,
          userId: TEST_USER,
          orgId: TEST_ORG,
          scopes,
          dimensionGrants: {},
        },
        threadId: RQ_THREAD,
        params: {},
        origin: "human-ui",
      })
    const rows = () =>
      sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${TEST_ORG} AND tool_name = 'rq-a:x'`

    // The tool's own scope decides a person's request, never the approve scope.
    it("holding the tool's scope but not rq-a:approve: granted inline, nothing parks", async () => {
      const r = await call(["rq-a:items:write"])
      expect((r.data as any)?.granted).toBe(true)
      expect((r.data as any)?.approval_id).toBeNull()
      expect((await rows()).length).toBe(0)
    })

    it("holding rq-a:approve: granted inline, nothing parks", async () => {
      const r = await call(["rq-a:items:write", "rq-a:approve"])
      expect((r.data as any)?.granted).toBe(true)
      expect((r.data as any)?.approval_id).toBeNull()
      expect((await rows()).length).toBe(0)
    })
  })

  // Owner ruling: sub-agents nest at most two levels. A depth-2 run calls an
  // UNTRUSTED app tool (worker pool: its bridge callbacks lose the ALS frame),
  // whose handler cross-calls a TRUSTED app tool that spawns. The nested hop
  // must carry the calling run's spawn frame, so the spawn is refused rather
  // than starting a fresh chain at depth 0.
  describe("depth across a nested cross-app hop", () => {
    const DP_THREAD = "00000000-0000-0000-0000-000000130050"
    beforeAll(async () => {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${DP_THREAD}, ${TEST_ORG}, 'dp-thread', 'thread', ${TEST_USER})
        ON CONFLICT (id) DO NOTHING`
    })
    afterAll(async () => {
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
      await sql`DELETE FROM kernel.threads WHERE id = ${DP_THREAD}`
    })
    beforeEach(async () => {
      const aPath = "/tmp/test-dp-a.js"
      await Bun.write(
        aPath,
        `async function x(params, ctx) {
          return JSON.parse(await ctx.executeTool("dp-b:y", JSON.stringify({})))
        }`,
      )
      const bPath = "/tmp/test-dp-b.js"
      await Bun.write(
        bPath,
        `async function y(params, ctx) {
          return JSON.parse(await ctx.agent_spawn(JSON.stringify({ subagentType: "dp-investigator", description: "d", prompt: "go" })))
        }`,
      )
      appCrossAppCallsRegistry.set([TEST_ORG, "dp-a"], { targets: ["dp-b:y"] })
      toolRegistry.set([TEST_ORG, "dp-a", "x"], {
        appName: "dp-a",
        name: "x",
        description: "untrusted: cross-calls dp-b:y",
        requiredScopes: ["dp-a:items:read"],
        gated: false,
        handler: { bundlePath: aPath, exportName: "x", core: false },
        _manifest: { name: "dp-a", schema: {}, events: {}, connections: {}, network: {} },
      } as any)
      toolRegistry.set([TEST_ORG, "dp-b", "y"], {
        appName: "dp-b",
        name: "y",
        description: "trusted: spawns a sub-agent",
        requiredScopes: ["dp-b:items:read"],
        gated: false,
        handler: { bundlePath: bPath, exportName: "y", core: true },
        _manifest: {
          name: "dp-b",
          trusted: true,
          capabilities: ["agent.spawn"],
          schema: {},
          events: {},
          connections: {},
          network: {},
        },
      } as any)
    })

    it("a gated app tool a depth-2 sub-run proposed: the approval records the run, and its approved replay still refuses agent.spawn", async () => {
      const zPath = "/tmp/test-dp-z.js"
      await Bun.write(
        zPath,
        `async function z(params, ctx) {
          return JSON.parse(await ctx.agent_spawn(JSON.stringify({ subagentType: "dp-investigator", description: "d", prompt: "go" })))
        }`,
      )
      toolRegistry.set([TEST_ORG, "dp-g", "z"], {
        appName: "dp-g",
        name: "z",
        description: "gated, trusted: spawns a sub-agent once approved",
        requiredScopes: ["dp-g:items:read"],
        gated: true,
        handler: { bundlePath: zPath, exportName: "z", core: true },
        _manifest: {
          name: "dp-g",
          trusted: true,
          capabilities: ["agent.spawn"],
          schema: {},
          events: {},
          connections: {},
          network: {},
        },
      } as any)
      const runId = crypto.randomUUID()
      const rootRunId = crypto.randomUUID()
      const actor = {
        actorType: "user" as const,
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["dp-g:items:read"],
        dimensionGrants: {},
      }
      const parked = await runContextStore.run(
        {
          runId,
          parentRunId: null,
          rootRunId,
          nestingDepth: 2,
          background: true,
          turnScopeAccumulator: createTurnScopeAccumulator({ orgId: TEST_ORG }),
        },
        () =>
          executeToolCore({
            toolName: "dp-g:z",
            orgId: TEST_ORG,
            actor,
            threadId: DP_THREAD,
            params: {},
            origin: "in-app-agent",
          }),
      )
      const approvalId = "blocked" in parked ? parked.blocked.approvalRequestId : undefined
      expect(approvalId).toBeTruthy()
      const [row] =
        await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${approvalId as string}`
      const originRun = parseOriginRun(
        (row as { metadata: Record<string, unknown> }).metadata.originRun,
      )
      expect(originRun).toEqual({ runId, rootRunId, nestingDepth: 2 })

      // The approved replay, as cascade.ts runs it: outside every frame, with
      // the persisted run restored. The spawn must still be refused.
      let replay: unknown
      try {
        replay = await runApprovedToolHandler({
          orgId: TEST_ORG,
          requesterContext: { ...actor, scopes: ["dp-g:items:read", "dp-g:approve"] },
          deciderId: TEST_USER,
          toolName: "dp-g:z",
          payload: {},
          approvalRequestId: approvalId as string,
          threadId: DP_THREAD,
          origin: "in-app-agent",
          ...(originRun ? { originRun } : {}),
        })
      } catch (err) {
        // The handler's error envelope is reported as a no-effect failure
        // (nothing was spawned); its code travels in `details`.
        replay = { thrown: (err as { details?: unknown }).details }
      }
      expect(JSON.stringify(replay)).toContain("E_DEPTH_EXCEEDED")
    })

    it("a depth-2 run -> untrusted A -> trusted B -> agent.spawn is refused E_DEPTH_EXCEEDED", async () => {
      const rootRunId = crypto.randomUUID()
      const out = await runContextStore.run(
        {
          runId: crypto.randomUUID(),
          parentRunId: null,
          rootRunId,
          nestingDepth: 2,
          background: true,
          turnScopeAccumulator: createTurnScopeAccumulator({ orgId: TEST_ORG }),
        },
        () =>
          executeToolCore({
            toolName: "dp-a:x",
            orgId: TEST_ORG,
            actor: {
              actorType: "user",
              userId: TEST_USER,
              orgId: TEST_ORG,
              scopes: ["dp-a:items:read", "dp-b:items:read"],
              dimensionGrants: {},
            },
            threadId: DP_THREAD,
            params: {},
            origin: "in-app-agent",
          }),
      )
      expect(JSON.stringify(out)).toContain("E_DEPTH_EXCEEDED")
    })
  })
})
