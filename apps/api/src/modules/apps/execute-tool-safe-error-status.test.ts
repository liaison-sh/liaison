// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed handler's safe ToolError that names a 4xx HTTP class (an
// upstream throttle, a missing upstream permission) keeps that class through
// the sandbox and executeTool. Without it the envelope falls to the code map's
// default 500: the web client reads a server fault, and the agent tool bridge
// logs the call at error level, which pages the watchdog for an expected
// upstream answer.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const TEST_ORG = "00000000-0000-0000-0000-000000130011"
const TEST_USER = "00000000-0000-0000-0000-000000130012"

const BUNDLE = `
  class ToolError extends Error {
    constructor(message, opts) {
      super(message)
      this.name = "ToolError"
      this.safe = true
      this.code = opts.code
      this.retryable = opts.retryable === true
    }
  }
  function throttled(params, ctx) {
    const e = new ToolError("Meta is limiting requests right now. Try again in a few minutes.", {
      code: "meta_rate_limited",
      retryable: true,
    })
    e.status = 429
    throw e
  }
  // What @liaison/app-sdk refuseTool() returns: a guard that declined on purpose.
  function refused(params, ctx) {
    return {
      status: "error",
      error: {
        code: "buyer_detail_required",
        message: "This buyer looks like a business but has no VAT number. Nothing was created. Next step: find it.",
        retryable: false,
        refusal: true,
      },
    }
  }
  function refusedConflict(params, ctx) {
    return { status: "error", error: { code: "conflict", message: "Already taken.", retryable: false, refusal: true } }
  }
  function refusedClaiming500(params, ctx) {
    return { status: "error", error: { code: "x_refused", message: "No.", retryable: false, refusal: true, status: 500 } }
  }
  function unclassified(params, ctx) {
    return { status: "error", error: { code: "something_broke", message: "It broke.", retryable: false } }
  }
  function plainSafe(params, ctx) {
    throw new ToolError("No anchor document.", { code: "no_anchor_document" })
  }
`

async function call(exportName: string) {
  try {
    await executeTool({
      toolName: `safe-status:${exportName}`,
      orgId: TEST_ORG,
      actor: {
        actorType: "user",
        userId: TEST_USER,
        orgId: TEST_ORG,
        scopes: ["safe-status:items:read"],
        dimensionGrants: {},
      },
      params: {},
    })
  } catch (err) {
    return err as {
      status?: number
      code?: string
      message: string
      details?: { retryable?: boolean }
    }
  }
  throw new Error("expected the call to reject")
}

describe("executeTool: a safe ToolError keeps its 4xx HTTP class", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Safe Status Org', 'safe-status')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'safe-status@test.com', 'hash', 'Test', 'active')
      ON CONFLICT (id) DO NOTHING`
    await initSandboxPool()
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  function register(name: string, bundlePath: string) {
    toolRegistry.set([TEST_ORG, "safe-status", name], {
      appName: "safe-status",
      name,
      description: name,
      requiredScopes: ["safe-status:items:read"],
      handler: { bundlePath, exportName: name, trusted: false },
      _manifest: { name: "safe-status", schema: {}, events: {}, connections: {}, network: {} },
    } as any)
  }

  it("an untrusted sandboxed ToolError with status 429 reaches the caller as 429, code and message intact", async () => {
    const bundlePath = "/tmp/test-sandbox-safe-status.js"
    await Bun.write(bundlePath, BUNDLE)
    register("throttled", bundlePath)
    const err = await call("throttled")
    expect(err.status).toBe(429)
    expect(err.code).toBe("meta_rate_limited")
    expect(err.details?.retryable).toBe(true)
    expect(err.message).toBe("Meta is limiting requests right now. Try again in a few minutes.")
  })

  it("a safe ToolError without a status keeps the code map default", async () => {
    const bundlePath = "/tmp/test-sandbox-safe-status.js"
    await Bun.write(bundlePath, BUNDLE)
    register("plainSafe", bundlePath)
    const err = await call("plainSafe")
    expect(err.code).toBe("no_anchor_document")
    expect(err.status).not.toBe(429)
  })

  async function callWith(name: string) {
    const bundlePath = "/tmp/test-sandbox-safe-status.js"
    await Bun.write(bundlePath, BUNDLE)
    register(name, bundlePath)
    return call(name)
  }

  it("a returned refusal (refuseTool) is a 422 with its code and message intact", async () => {
    const err = await callWith("refused")
    expect(err.status).toBe(422)
    expect(err.code).toBe("buyer_detail_required")
    expect(err.message).toBe(
      "This buyer looks like a business but has no VAT number. Nothing was created. Next step: find it.",
    )
    expect(err.details?.retryable).toBe(false)
  })

  it("a refusal whose code the host maps to a 4xx keeps that 4xx", async () => {
    expect((await callWith("refusedConflict")).status).toBe(409)
  })

  it("a refusal can never claim a 5xx", async () => {
    expect((await callWith("refusedClaiming500")).status).toBe(422)
  })

  it("an unclassified returned error without the refusal mark stays a 500", async () => {
    const err = await callWith("unclassified")
    expect(err.status).toBe(500)
    expect(err.code).toBe("something_broke")
  })
})
