// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A47b. A manifest tool's declared parameter defaults reach the handler, the approval policy
// and the approval card, in that one order: filled on a clone as soon as the arguments validate,
// before anything judges or shows the call.
//
// A47 filled them for the handler alone, which left the policy judging arguments the handler
// would not run on (a default the policy refuses when the agent types it passed when the schema
// supplied it) and the reviewer reading a card that described a different call than the one
// about to happen. So the card shows the FILLED arguments and marks which paths the schema
// supplied; the agent's own arguments are the payload minus those paths, which is how the row
// keeps them without a second copy of a payload that may be sealed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import {
  defaultedParamPaths,
  executeTool,
  executeToolCore,
  validateParamsForTool,
  withManifestDefaults,
} from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const TEST_ORG = "00000000-0000-0000-0000-0000000a4700"
const TEST_USER = "00000000-0000-0000-0000-0000000a4701"
const BUNDLE_PATH = "/tmp/test-manifest-defaults-echo.js"

const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: "number" },
    mode: { type: "string", default: "balanced" },
    notify: { type: "boolean", default: true },
  },
  required: ["amount"],
} as const

const actor = {
  actorType: "user" as const,
  userId: TEST_USER,
  orgId: TEST_ORG,
  scopes: ["defaults-test:items:write"],
  dimensionGrants: {},
}

function registerEchoTool(opts: { gated?: boolean } = {}) {
  toolRegistry.set([TEST_ORG, "defaults-test", "echo"], {
    appName: "defaults-test",
    name: "echo",
    description: "Echo the arguments the handler was given",
    requiredScopes: ["defaults-test:items:write"],
    writesToTable: "app_defaults_test.items",
    ...(opts.gated ? { gated: true } : {}),
    params: PARAMS_SCHEMA,
    handler: { bundlePath: BUNDLE_PATH, exportName: "echo", core: true },
    _manifest: { name: "defaults-test", schema: {}, events: {}, connections: {}, network: {} },
  } as never)
  return toolRegistry.get([TEST_ORG, "defaults-test", "echo"])!
}

describe("A47 manifest parameter defaults", () => {
  beforeAll(async () => {
    await Bun.write(BUNDLE_PATH, `function echo(params) { return { received: params }; }`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Manifest Defaults Org', 'manifest-defaults-a47')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'manifest-defaults-a47@test.com', 'hash', 'Test', 'active')
      ON CONFLICT (id) DO NOTHING`
    await initSandboxPool()
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${TEST_ORG}`
    // The gated call provisions an approval thread, whose participant rows
    // reference the user: they go first or the user delete trips their FK.
    await sql`DELETE FROM kernel.messages WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE user_id = ${TEST_USER}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("the handler receives a default the caller omitted", async () => {
    registerEchoTool()
    const result = await executeTool<{ received: Record<string, unknown> }>({
      toolName: "defaults-test:echo",
      orgId: TEST_ORG,
      actor,
      params: { amount: 5 },
    })
    expect(result.data.received).toEqual({ amount: 5, mode: "balanced", notify: true })
  })

  it("a value the caller did send is never replaced by the default", async () => {
    registerEchoTool()
    const result = await executeTool<{ received: Record<string, unknown> }>({
      toolName: "defaults-test:echo",
      orgId: TEST_ORG,
      actor,
      params: { amount: 5, mode: "fast", notify: false },
    })
    expect(result.data.received).toEqual({ amount: 5, mode: "fast", notify: false })
  })

  it("validation still returns the raw arguments, so the policy judges what the agent sent", () => {
    const tool = registerEchoTool()
    const validated = validateParamsForTool(tool, TEST_ORG, "defaults-test", "echo", { amount: 5 })
    expect(validated).toEqual({ amount: 5 })
  })

  it("the approval payload carries the filled arguments and marks each defaulted key", async () => {
    registerEchoTool({ gated: true })
    const envelope = await executeToolCore({
      toolName: "defaults-test:echo",
      orgId: TEST_ORG,
      actor,
      params: { amount: 5 },
      origin: "in-app-agent",
    })
    expect("blocked" in envelope).toBe(true)
    const approvalId = (envelope as { blocked: { approvalRequestId?: string } }).blocked
      .approvalRequestId
    expect(approvalId).toBeTruthy()
    const [row] = await sql`
      SELECT tool_params, current_payload, metadata
      FROM kernel.approval_requests WHERE id = ${approvalId ?? ""}`
    // What the handler will run on, which is what the reviewer has to judge.
    expect(row!.tool_params).toEqual({ amount: 5, mode: "balanced", notify: true })
    expect(row!.current_payload).toEqual({ amount: 5, mode: "balanced", notify: true })
    // And which of those the reviewer was never asked for.
    expect((row!.metadata as { defaultedParams?: string[] }).defaultedParams?.sort()).toEqual([
      "mode",
      "notify",
    ])
  })

  it("the row still says exactly what the agent sent: the payload minus the defaulted paths", async () => {
    registerEchoTool({ gated: true })
    const envelope = await executeToolCore({
      toolName: "defaults-test:echo",
      orgId: TEST_ORG,
      actor,
      params: { amount: 7, mode: "fast" },
      origin: "in-app-agent",
    })
    const approvalId = (envelope as { blocked: { approvalRequestId?: string } }).blocked
      .approvalRequestId
    const [row] = await sql`
      SELECT tool_params, metadata FROM kernel.approval_requests WHERE id = ${approvalId ?? ""}`
    const marked = (row!.metadata as { defaultedParams?: string[] }).defaultedParams ?? []
    expect(marked).toEqual(["notify"])
    const raw = { ...(row!.tool_params as Record<string, unknown>) }
    for (const key of marked) delete raw[key]
    expect(raw).toEqual({ amount: 7, mode: "fast" })
  })

  it("a default the policy would refuse if the agent typed it is refused when the schema supplies it", async () => {
    // The org tightens every echo call whose mode is "balanced". The agent sends no mode at
    // all, so only the FILLED arguments carry one: the policy must see them, or a manifest
    // default silently walks past the org's own rule.
    registerEchoTool()
    await sql`
      INSERT INTO kernel.approval_policies (org_id, tool_name, enabled, conditions, require_approval)
      VALUES (${TEST_ORG}, 'defaults-test:echo', true,
              ${JSON.stringify([{ path: "mode", op: "eq", value: "balanced" }])}::jsonb, true)
      ON CONFLICT (org_id, tool_name) DO UPDATE SET enabled = true`
    try {
      const envelope = await executeToolCore({
        toolName: "defaults-test:echo",
        orgId: TEST_ORG,
        actor,
        params: { amount: 5 },
        origin: "in-app-agent",
      })
      expect("blocked" in envelope).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.approval_policies WHERE org_id = ${TEST_ORG}`
    }
  })

  it("names which paths the schema supplied, nested ones included", () => {
    expect(defaultedParamPaths({ amount: 5 }, { amount: 5, mode: "balanced" })).toEqual(["mode"])
    expect(defaultedParamPaths({ amount: 5, mode: "fast" }, { amount: 5, mode: "fast" })).toEqual(
      [],
    )
    expect(
      defaultedParamPaths({ outer: {} }, { outer: { inner: "d" } }).concat(
        defaultedParamPaths({ items: [{}] }, { items: [{ mode: "x" }] }),
      ),
    ).toEqual(["outer.inner", "items[0].mode"])
  })

  it("a default inside a oneOf branch is refused at registration, not at the first dispatch", () => {
    // Ajv strict mode throws when it compiles such a schema with useDefaults, and the filler
    // compiles lazily on the first call: that throw would land after the policy and after the
    // card. The manifest is refused instead, naming the tool.
    const result = validateAppManifest({
      name: "branchy",
      version: "1.0.0",
      description: "branch-scoped default",
      tools: {
        pick: {
          description: "pick",
          requiredScopes: ["branchy:items:write"],
          handler: "pick",
          params: {
            type: "object",
            properties: { a: { type: "string" } },
            oneOf: [
              { properties: { b: { type: "string", default: "x" } } },
              { properties: { c: { type: "number" } } },
            ],
          },
        },
      },
    })
    expect(result.success).toBe(false)
    expect(String((result as { error?: string }).error)).toContain("tools.pick.params")
    expect(String((result as { error?: string }).error)).toContain("oneOf")
  })

  it("leaves a Zod-typed kernel tool alone, so its dispatch is not an ajv compile", async () => {
    // A Zod schema carries a `type` of its own, and ajv refuses to compile one ("unknown
    // keyword: toJSONSchema"). Filling at dispatch without this check answered every kernel
    // tool call with invalid_params.
    const { z } = await import("zod")
    const zodTool = { params: z.object({ amount: z.number() }).passthrough() }
    expect(withManifestDefaults(zodTool, { amount: 5 })).toEqual({ amount: 5 })

    toolRegistry.set([TEST_ORG, "defaults-test", "zod_echo"], {
      appName: "defaults-test",
      name: "zod_echo",
      description: "zod echo",
      requiredScopes: ["defaults-test:items:write"],
      writesToTable: "app_defaults_test.items",
      params: z.object({ amount: z.number() }).passthrough(),
      handler: async (params: unknown) => ({ received: params }),
    } as never)
    const result = await executeTool<{ received: Record<string, unknown> }>({
      toolName: "defaults-test:zod_echo",
      orgId: TEST_ORG,
      actor,
      params: { amount: 5 },
    })
    expect(result.data.received).toEqual({ amount: 5 })
  })

  it("a nested default fills only when its parent object is present, which is ajv's rule", () => {
    // Documented, not wished for: `useDefaults` walks into an object it has, and never
    // invents the parent. A manifest that wants the whole object defaulted declares the
    // default on the PARENT property.
    const tool = {
      params: {
        type: "object",
        properties: {
          outer: { type: "object", properties: { inner: { type: "string", default: "d" } } },
        },
      },
    }
    expect(withManifestDefaults(tool, {})).toEqual({})
    expect(withManifestDefaults(tool, { outer: {} })).toEqual({ outer: { inner: "d" } })
  })

  it("the fill adds, it never rewrites, and it never touches the caller's own object", () => {
    const tool = registerEchoTool()
    // The caller's object is left exactly as it was: the fill works on a clone,
    // which is what lets the policy and the approval card keep reading the raw
    // arguments after it has run.
    const sent: Record<string, unknown> = { amount: 5 }
    const filled = withManifestDefaults(tool, sent) as Record<string, unknown>
    expect(filled).toEqual({ amount: 5, mode: "balanced", notify: true })
    expect(sent).toEqual({ amount: 5 })

    // coerceTypes stays off, so nothing the caller sent is rewritten on the way
    // to the handler. A string where the schema wants a number is not turned
    // into one, and the arguments come back exactly as they arrived (in
    // production coerceJsonStringParams has already run, ahead of validation,
    // and the fill is never the thing that changes a type).
    const stringy: Record<string, unknown> = { amount: "5" }
    expect(withManifestDefaults(tool, stringy)).toEqual({ amount: "5" })
  })
})
