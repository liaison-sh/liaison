// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED CALL MUST NOT BE STAGED WHEN THE DATA IT NEEDS IS MISSING.
//
// knowledge:create parks a human approval for an ORG-scoped document, and the
// placement + access guard (collection filed, explicit sensitivity, role shares
// for confidential/restricted) used to run only in the bridge — i.e. AFTER the
// human approved. The approver was handed a card, clicked approve, and got
// "Organization Knowledge documents must be explicitly access-classified" for
// data only the agent could supply. These tests pin the guard running at
// STAGING: an incomplete create is refused in the agent's loop and NO approval
// is parked.
import { describe, expect, it } from "bun:test"

// handlers.ts is script-mode by design (see its header) — transpile + eval to
// reach `create`, the same way ci-webhook.test.ts reaches the projects handlers.
const handlersSource = await Bun.file(new URL("./handlers.ts", import.meta.url)).text()
const transpiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  handlersSource,
)
const { create, update } = new Function(`${transpiled}\nreturn { create, update };`)() as {
  create: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>
  update: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>
}

function makeCtx(validation: unknown) {
  const calls: { validate: string[]; park: unknown[]; create: string[] } = {
    validate: [],
    park: [],
    create: [],
  }
  const ctx = {
    knowledge_create_validate: async (json: string) => {
      calls.validate.push(json)
      return JSON.stringify(validation)
    },
    knowledge_create: async (json: string) => {
      calls.create.push(json)
      return JSON.stringify({ id: "doc-1" })
    },
    requestApproval: async (json: string) => {
      calls.park.push(JSON.parse(json))
      return JSON.stringify({ status: "pending_approval", approval_id: "ap-1" })
    },
  }
  return { ctx, calls }
}

describe("knowledge:create stage-time gate", () => {
  it("refuses an org create the guard rejects, and parks NO approval", async () => {
    const { ctx, calls } = makeCtx({
      error: {
        code: "sensitivity_required",
        message: "Organization Knowledge documents must be explicitly access-classified",
      },
    })
    const out = (await create(
      { documentScope: "organization", title: "2026 Margin Analysis", collectionId: "c1" },
      ctx,
    )) as { error?: { code?: string } }
    expect(out.error?.code).toBe("sensitivity_required")
    // The whole point: nothing was queued for a human to approve and then fail on.
    expect(calls.park).toHaveLength(0)
    expect(calls.create).toHaveLength(0)
  })

  it("parks the approval when the guard accepts the params", async () => {
    const { ctx, calls } = makeCtx({})
    const out = (await create(
      {
        documentScope: "organization",
        title: "Support SLAs",
        body: "8h first response",
        collectionId: "c1",
        sensitivity: "internal",
      },
      ctx,
    )) as { status?: string }
    expect(out.status).toBe("pending_approval")
    expect(calls.validate).toHaveLength(1)
    expect(calls.park).toHaveLength(1)
    expect(calls.create).toHaveLength(0)
  })

  it("does not validate or gate a PERSONAL note (ungated path is untouched)", async () => {
    const { ctx, calls } = makeCtx({ error: { code: "sensitivity_required", message: "x" } })
    await create({ documentScope: "personal", title: "scratch", collectionId: "c1" }, ctx)
    expect(calls.validate).toHaveLength(0)
    expect(calls.park).toHaveLength(0)
    expect(calls.create).toHaveLength(1)
  })
})

describe("knowledge:update stage-time gate", () => {
  function makeUpdateCtx(validation: unknown, scope: string) {
    const calls: { validate: string[]; park: unknown[]; update: string[] } = {
      validate: [],
      park: [],
      update: [],
    }
    const ctx = {
      knowledge_get: async () => JSON.stringify({ document: { document_scope: scope } }),
      knowledge_update_validate: async (json: string) => {
        calls.validate.push(json)
        return JSON.stringify(validation)
      },
      knowledge_update: async (json: string) => {
        calls.update.push(json)
        return JSON.stringify({ id: "doc-1" })
      },
      requestApproval: async (json: string) => {
        calls.park.push(JSON.parse(json))
        return JSON.stringify({ status: "pending_approval", approval_id: "ap-1" })
      },
    }
    return { ctx, calls }
  }

  it("refuses an org update the guard rejects, and parks NO approval", async () => {
    const { ctx, calls } = makeUpdateCtx(
      { error: { code: "synced_read_only", message: "read-only" } },
      "organization",
    )
    const out = (await update({ id: "d1", body: "x" }, ctx)) as { error?: { code?: string } }
    expect(out.error?.code).toBe("synced_read_only")
    expect(calls.park).toHaveLength(0)
    expect(calls.update).toHaveLength(0)
  })

  it("parks the approval when the guard accepts", async () => {
    const { ctx, calls } = makeUpdateCtx({}, "organization")
    const out = (await update({ id: "d1", revision: 3, body: "x" }, ctx)) as { status?: string }
    expect(out.status).toBe("pending_approval")
    expect(calls.park).toHaveLength(1)
    expect(calls.update).toHaveLength(0)
  })

  it("does not validate or gate a PERSONAL document update", async () => {
    const { ctx, calls } = makeUpdateCtx(
      { error: { code: "synced_read_only", message: "x" } },
      "personal",
    )
    await update({ id: "d1", body: "x" }, ctx)
    expect(calls.validate).toHaveLength(0)
    expect(calls.park).toHaveLength(0)
    expect(calls.update).toHaveLength(1)
  })
})

describe("a person's own call granted inline (approvals are for agents)", () => {
  // The kernel answers ctx.requestApproval with `auto_approved: true` and no
  // approval row when the call is a person's own and they hold the deciding
  // scope: the handler must write, never report a pending approval.
  it("an org create by a scoped person is written at once", async () => {
    const { ctx, calls } = makeCtx({})
    ctx.requestApproval = async (json: string) => {
      calls.park.push(JSON.parse(json))
      return JSON.stringify({ approval_id: null, auto_approved: true, approved_by: "requester" })
    }
    const out = await create(
      {
        documentScope: "organization",
        title: "Support SLAs",
        collectionId: "c1",
        sensitivity: "internal",
      },
      ctx,
    )
    expect(out).toEqual({ id: "doc-1" })
    expect(calls.park).toHaveLength(1)
    expect(calls.create).toHaveLength(1)
  })
})
