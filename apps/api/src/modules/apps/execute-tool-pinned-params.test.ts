// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A gated tool's preflight may PIN params (the server's values the approval
// card shows and the execution checks). A caller's own value for a declared
// pinned param is never trusted: it is dropped before the preflight runs. And a
// call carrying an `@ref:` token to an earlier step, which skips the preflight,
// is refused at stage time instead of being staged with the caller's values.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { buildRefToken } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalEditableFieldsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { registerApiConnectorApp } from "~/modules/apps/connections/api/app.test-helpers"
import { createHandlerApprovalRequest, executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { pinnedOverlap } from "~/modules/apps/pinned-params"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

let orgId: string
let admin: UserContext
let threadId: string

beforeAll(async () => {
  await acquireTestLock()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  admin = a.actor
  threadId = await minimal.thread(orgId, a.userId)
  await ensureAppsForOrg(orgId)
  await registerApiConnectorApp(orgId)
  const register = (name: string, pin: boolean) => {
    toolRegistry.set([orgId, "kernel", name], {
      appName: "kernel",
      name,
      description: "Probe tool for pinned params.",
      requiredScopes: ["kernel:threads:read"],
      gated: true,
      approvalImpact: "internal",
      pinnedParams: ["target"],
      params: z.object({ note: z.string(), target: z.string().optional() }),
      preflight: async () =>
        pin ? { ok: true, pinnedParams: { target: "server" } } : { ok: true },
      handler: async () => ({ done: true }),
    })
    registerApprovalSummarizer(orgId, "kernel", name, async () => ({
      kind: "probe",
      title: "Probe",
      lines: ["probe"],
    }))
  }
  register("pin_probe", true)
  register("pin_probe_silent", false)
  // Editable fields registered before their tool (so the registration guard,
  // which reads the tool's pins, cannot see them): the payload edit path must
  // still refuse an edit that reaches a pinned key.
  approvalEditableFieldsRegistry.set(
    [orgId, "kernel", "pin_probe_edit"],
    [
      { field: "note", label: "Note", widget: "text" },
      { field: "target", label: "Target", widget: "text" },
      { field: "target.host", label: "Host", widget: "text" },
    ],
  )
  register("pin_probe_edit", true)
  for (const name of ["seq_head", "seq_preflighted"]) {
    toolRegistry.set([orgId, "kernel", name], {
      appName: "kernel",
      name,
      description: "Sequencing probe.",
      requiredScopes: ["kernel:threads:read"],
      gated: true,
      approvalImpact: "internal",
      referenceableOutputs: ["value"],
      params: z.object({ note: z.string() }),
      // Would refuse the literal token, so it must not run for a token-bearing call.
      preflight: async (p: unknown) =>
        typeof p === "object" && p !== null && String(Reflect.get(p, "note")).startsWith("@ref:")
          ? { error: "preflight ran on a reference" }
          : { ok: true },
      handler: async () => ({ value: "v" }),
    })
    registerApprovalSummarizer(orgId, "kernel", name, async () => ({
      kind: "probe",
      title: "Probe",
      lines: ["probe"],
    }))
  }
})
afterAll(async () => {
  broadcastSpy.mockRestore()
  await releaseTestLock()
})

const call = (toolName: string, params: Record<string, unknown>) =>
  executeTool({
    toolName: `kernel:${toolName}`,
    orgId,
    actor: admin,
    params,
    threadId,
    origin: "in-app-agent",
    stepBundleId: null,
  })

async function stagedParams(approvalId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<Array<{ tool_params: Record<string, unknown> }>>`
    SELECT tool_params FROM kernel.approval_requests WHERE id = ${approvalId}`
  return row?.tool_params ?? {}
}

describe("declared pinned params", () => {
  it("the staged call carries the preflight's value, not the caller's", async () => {
    const res = await call("pin_probe", { note: "a", target: "spoofed" })
    const id = res.blocked?.approvalRequestId as string
    expect(id).toBeDefined()
    expect((await stagedParams(id)).target).toBe("server")
  })

  it("a caller's value is dropped even when the preflight pins nothing", async () => {
    const res = await call("pin_probe_silent", { note: "b", target: "spoofed" })
    const id = res.blocked?.approvalRequestId as string
    expect(id).toBeDefined()
    expect((await stagedParams(id)).target).toBeUndefined()
  })

  it("an @ref to an earlier step is refused at stage time, nothing is staged", async () => {
    const [{ n: before }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await expect(
      call("pin_probe", {
        note: buildRefToken(crypto.randomUUID(), "draft_id"),
        target: "spoofed",
      }),
    ).rejects.toThrow(/can't take an @ref reference to an earlier step: its approval binds/)
    const [{ n: after }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    expect(after).toBe(before)
  })

  it("connector_write declares its pinned target and approval", () => {
    const def = toolRegistry.get([orgId, "api-connector", "connector_write"])
    expect(def?.pinnedParams).toEqual(["target", "approval"])
  })
})

describe("pins hold on handler-parked approvals and payload edits", () => {
  it("a handler cannot park an approval for a tool that declares pinned params", async () => {
    const [{ n: before }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await expect(
      createHandlerApprovalRequest({
        orgId,
        requestedBy: admin.actorType === "user" ? admin.userId : "",
        actorScopes: admin.scopes,
        defaultAppName: "kernel",
        threadId,
        origin: "in-app-agent",
        input: {
          tool_name: "kernel:pin_probe",
          summary: "parked by a handler",
          current_payload: { note: "x", target: "spoofed" },
        },
      }),
    ).rejects.toThrow(/declares pinned params/)
    const [{ n: after }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    expect(after).toBe(before)
  })

  it("a payload edit of a pinned key, or of a field under it, is refused", async () => {
    const res = await call("pin_probe_edit", { note: "a" })
    const id = res.blocked?.approvalRequestId as string
    expect(id).toBeDefined()
    for (const field of ["target", "target.host"]) {
      await expect(
        updatePayload({
          orgId,
          requestId: id,
          actor: admin,
          fields: { [field]: "elsewhere" },
          actingAgentId: null,
        }),
      ).rejects.toThrow(/set by the server/)
    }
    expect((await stagedParams(id)).target).toBe("server")
  })

  it("registration refuses an editable field that is a pinned key, its parent or its child", () => {
    for (const field of ["target", "target.host"]) {
      expect(() =>
        approvalEditableFieldsRegistry.set(
          [orgId, "kernel", "pin_probe"],
          [{ field, label: "Target", widget: "text" }],
        ),
      ).toThrow(/pinned/)
    }
    expect(pinnedOverlap(["target"], "targets")).toBeNull()
    expect(pinnedOverlap(["a"], "a.b")).toBe("a")
  })

  it("a NON-pinned gated tool with a preflight and an @ref still becomes a deferred sequenced step", async () => {
    const head = await call("seq_head", { note: "first" })
    const headId = head.blocked?.approvalRequestId as string
    expect(headId).toBeDefined()
    const step = await call("seq_preflighted", { note: buildRefToken(headId, "value") })
    const stepId = step.blocked?.approvalRequestId as string
    const [row] = await sql<Array<{ status: string; depends_on_id: string | null }>>`
      SELECT status, depends_on_id FROM kernel.approval_requests WHERE id = ${stepId}`
    expect(row).toEqual({ status: "deferred", depends_on_id: headId })
  })
})
