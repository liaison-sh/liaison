// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { approvalEditableFieldsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// A failure cascade reaches failBundle → enqueueAppJob("kernel","agent-reinvoke"),
// which throws "No handler registered" in bun:test (kernel job workers only
// register in index.ts). Stub it with a restored spy so the failure-path test
// is self-contained — never silently dependent on another file's leaked mock.
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const ORG = "00000000-0000-4000-8000-0000000a5001"
const USER = "00000000-0000-4000-8000-0000000a5002"
const THREAD = "00000000-0000-4000-8000-0000000a5003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

// A test-tool handler resolves ITS OWN approval row by tool_name + status='approving'.
async function recordSelf(toolName: string, result: Record<string, unknown>) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = {
    orgId: ORG,
    approvalRequestId: row.id,
    approvalDeciderId: row.decided_by,
    toolName,
  }
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordSucceeded(tx, ctx, toolName, result))
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Cascade Org', 'cascade-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'cascade@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'cascade-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["seq_test:write", "seq_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }

  toolRegistry.set([ORG, "seq_test", "step1"], {
    appName: "seq_test",
    name: "step1",
    description: "s1",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      const r = { value: "label-123" }
      await recordSelf("seq_test:step1", r)
      return r
    },
  } as any)
  toolRegistry.set([ORG, "seq_test", "step2"], {
    appName: "seq_test",
    name: "step2",
    description: "s2",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["sent"],
    handler: async (p: any) => {
      const r = { sent: p.note }
      await recordSelf("seq_test:step2", r)
      return r
    },
  } as any)
  toolRegistry.set([ORG, "seq_test", "step3"], {
    appName: "seq_test",
    name: "step3",
    description: "s3",
    requiredScopes: ["seq_test:write"],
    gated: true,
    handler: async (p: any) => {
      const r = { sent: p.note }
      await recordSelf("seq_test:step3", r)
      return r
    },
  } as any)
  // Handler rewrites the still-deferred `seq_test:step2` sibling after the approval bound it.
  toolRegistry.set([ORG, "seq_test", "editnext"], {
    appName: "seq_test",
    name: "editnext",
    description: "edits the next deferred step",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      await sql`UPDATE kernel.approval_requests
        SET current_payload = jsonb_set(current_payload, '{note}', '"rewritten"'::jsonb)
        WHERE org_id = ${ORG} AND tool_name = 'seq_test:step2' AND status = 'deferred'`
      const r = { value: "v" }
      await recordSelf("seq_test:editnext", r)
      return r
    },
  } as any)
  // Handler cancels the still-deferred `seq_test:step2` sibling, simulating a
  // step that leaves the deferred state mid-cascade (I3).
  toolRegistry.set([ORG, "seq_test", "cancelnext"], {
    appName: "seq_test",
    name: "cancelnext",
    description: "cancels the next deferred step",
    requiredScopes: ["seq_test:write"],
    gated: true,
    handler: async (p: any) => {
      await sql`UPDATE kernel.approval_requests SET status = 'cancelled'
        WHERE org_id = ${ORG} AND tool_name = 'seq_test:step2' AND status = 'deferred'`
      const r = { sent: p.note }
      await recordSelf("seq_test:cancelnext", r)
      return r
    },
  } as any)
})
afterEach(async () => {
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function gated(tool: string, params: Record<string, unknown>) {
  const r = await executeTool({
    toolName: `seq_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    origin: "in-app-agent",
    threadId: THREAD,
  })
  return r.blocked!.approvalRequestId!
}
async function statusOf(id: string) {
  const [r] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return r.status as string
}

describe("bundle cascade — deterministic path", () => {
  it("approving the head executes step 1 then step 2 with the resolved output", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    expect(await statusOf(a2)).toBe("deferred")

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("approved")
    expect(await readDecidedResult(ORG, a2)).toEqual({ sent: "label-123" })
  })

  it("once step 1 ran, step 2's card reads the value it returned, not that it comes later", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    const summaryOf = async (id: string) => {
      const [r] = await sql<{ summary: { lines: string[] } }[]>`
        SELECT summary FROM kernel.approval_requests WHERE id = ${id}`
      return (r?.summary.lines ?? []).join("\n")
    }
    // Before: step 1 has not run, so the value is announced, never shown as a bracketed stand-in.
    expect(await summaryOf(a2)).toContain("filled in when that step runs")
    expect(await summaryOf(a2)).not.toContain("[")
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    expect(await statusOf(a2)).toBe("approved")
    const after = await summaryOf(a2)
    expect(after).toContain("label-123")
    expect(after).not.toContain("filled in when that step runs")
  })

  it("a deferred step cannot be approved directly", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await expect(
      decideApproval({ orgId: ORG, requestId: a2, actor, decision: "approve" }),
    ).rejects.toThrow(/sequence/i)
  })

  it("a deferred step cannot be denied directly", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await expect(
      decideApproval({ orgId: ORG, requestId: a2, actor, decision: "deny", reason: "no" }),
    ).rejects.toThrow(/sequence/i)
    expect(await statusOf(a2)).toBe("deferred")
  })

  it("denying the head cancels the deferred remainder", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "deny", reason: "no" })
    expect(await statusOf(a1)).toBe("denied")
    expect(await statusOf(a2)).toBe("cancelled")
  })

  // The warranty-return shape (proforma → return label → customer reply): three DIFFERENT
  // apps chained under one decision, with a strict stage-time preflight on the middle tool.
  // Two properties pinned here, both required for the real invoicing→boxtal→tickets flow:
  //  (1) a preflight that validates CONCRETE params must be SKIPPED when the staged params
  //      carry @ref placeholders (it would reject the token, not anything real) — the chain
  //      still validates at execution, post-resolution;
  //  (2) the deferred step's stored summary must be display-humanized (no raw @ref tokens
  //      on the card the human reads before approving the whole sequence).
  it("chains three DIFFERENT apps under one approval; a param-validating preflight is skipped for token-bearing staging; summaries humanize tokens", async () => {
    const CHAIN_SCOPES = ["chain_a:write", "chain_a:approve", "chain_b:write", "chain_c:write"]
    for (const scope of CHAIN_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    const chainActor = { ...actor, scopes: [...actor.scopes, ...CHAIN_SCOPES] }
    let preflightRan = 0
    toolRegistry.set([ORG, "chain_a", "issue_doc"], {
      appName: "chain_a",
      name: "issue_doc",
      description: "issue a document",
      requiredScopes: ["chain_a:write"],
      gated: true,
      referenceableOutputs: ["document_id"],
      handler: async () => {
        const r = { document_id: "doc-77" }
        await recordSelf("chain_a:issue_doc", r)
        return r
      },
    } as any)
    toolRegistry.set([ORG, "chain_b", "ship"], {
      appName: "chain_b",
      name: "ship",
      description: "create a shipment from a document",
      requiredScopes: ["chain_b:write"],
      gated: true,
      referenceableOutputs: ["label_file_id"],
      // A boxtal-style preflight: rejects any draft_id that is not a REAL
      // resolvable document. Against the literal token it would always fail —
      // the exact class the @ref skip exists for.
      preflight: async (p: any) => {
        preflightRan += 1
        if (p.draft_id !== "doc-77") {
          return {
            error: { code: "draft_unresolved", message: `found no invoice for ${p.draft_id}` },
          }
        }
        return { ok: true }
      },
      handler: async (p: any) => {
        if (p.draft_id !== "doc-77")
          throw new Error(`unresolved draft_id reached execution: ${p.draft_id}`)
        const r = { label_file_id: "file-99" }
        await recordSelf("chain_b:ship", r)
        return r
      },
    } as any)
    toolRegistry.set([ORG, "chain_c", "reply"], {
      appName: "chain_c",
      name: "reply",
      description: "reply with attachments",
      requiredScopes: ["chain_c:write"],
      gated: true,
      handler: async (p: any) => {
        const r = { attached: p.attachments }
        await recordSelf("chain_c:reply", r)
        return r
      },
    } as any)
    try {
      const call = async (tool: string, params: Record<string, unknown>) => {
        const r = await executeTool({
          toolName: tool,
          orgId: ORG,
          actor: chainActor,
          params,
          origin: "in-app-agent",
          threadId: THREAD,
        })
        if (!r.blocked) throw new Error(`expected gated block, got ${JSON.stringify(r)}`)
        return r.blocked
      }
      const head = await call("chain_a:issue_doc", {})
      const shipToken = `@ref:${head.approvalRequestId}:document_id`
      const ship = await call("chain_b:ship", { draft_id: shipToken, note: `for ${shipToken}` })
      // The strict preflight did NOT run against the literal token (it would have
      // rejected the staging); staging proceeded to a deferred step.
      expect(preflightRan).toBe(0)
      const reply = await call("chain_c:reply", {
        attachments: [`@ref:${ship.approvalRequestId}:label_file_id`],
      })
      // The stored deferred summaries carry NO raw @ref tokens (display-humanized).
      const rows =
        await sql`SELECT tool_name, summary, current_payload FROM kernel.approval_requests
        WHERE org_id = ${ORG} AND tool_name LIKE 'chain_%' ORDER BY bundle_position`
      for (const row of rows) {
        expect(JSON.stringify(row.summary)).not.toContain("@ref:")
      }
      // …while the stored payloads DO keep the real tokens for cascade-time resolution.
      const shipRow = rows.find((r: any) => r.tool_name === "chain_b:ship") as any
      expect(JSON.stringify(shipRow.current_payload)).toContain(shipToken)

      // ONE human decision on the head runs the whole chain with resolved values.
      await decideApproval({
        orgId: ORG,
        requestId: head.approvalRequestId!,
        actor: chainActor,
        decision: "approve",
      })
      expect(await statusOf(head.approvalRequestId!)).toBe("approved")
      expect(await statusOf(ship.approvalRequestId!)).toBe("approved")
      expect(await statusOf(reply.approvalRequestId!)).toBe("approved")
      // The reply executed with the SHIP step's real output, two hops down the chain.
      const replyResult = (await readDecidedResult(ORG, reply.approvalRequestId!)) as {
        attached: string[]
      }
      expect(replyResult.attached).toEqual(["file-99"])
    } finally {
      toolRegistry.delete([ORG, "chain_a", "issue_doc"])
      toolRegistry.delete([ORG, "chain_b", "ship"])
      toolRegistry.delete([ORG, "chain_c", "reply"])
    }
  })

  it("cascades a 3-step linear chain, resolving each step's output into the next", async () => {
    const a1 = await gated("step1", { kind: "x" }) // -> { value: "label-123" }
    const a2 = await gated("step2", { note: `@ref:${a1}:value` }) // -> { sent: "label-123" }
    const a3 = await gated("step3", { note: `@ref:${a2}:sent` }) // -> { sent: "label-123" }

    const [s2] = await sql`SELECT depends_on_id, bundle_position
      FROM kernel.approval_requests WHERE id = ${a2}`
    const [s3] = await sql`SELECT depends_on_id, bundle_position
      FROM kernel.approval_requests WHERE id = ${a3}`
    expect(s2.depends_on_id).toBe(a1)
    expect(s2.bundle_position).toBe(1)
    expect(s3.depends_on_id).toBe(a2) // depends on the latest-positioned referenced step
    expect(s3.bundle_position).toBe(2)

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("approved")
    expect(await statusOf(a3)).toBe("approved")
    expect(await readDecidedResult(ORG, a3)).toEqual({ sent: "label-123" })
  })

  it("executes a deferred step with the payload as edited AFTER staging — the edit, not the staged draft, is what runs", async () => {
    // Compound case: agent stages a bundle, a human edits step 2 while it sits
    // deferred, another human approves the head. The cascade's resolve must
    // read the step's payload under the same row lock the edit path takes —
    // an unlocked read here once overwrote the edit with the resolved
    // pre-edit payload and executed the content the editor had replaced.
    approvalEditableFieldsRegistry.set(
      [ORG, "seq_test", "step2"],
      [{ field: "note", label: "Note", widget: "text" }],
    )
    try {
      const a1 = await gated("step1", { kind: "x" })
      const a2 = await gated("step2", { note: `@ref:${a1}:value` })
      expect(await statusOf(a2)).toBe("deferred")

      const edit = await updatePayload({
        orgId: ORG,
        requestId: a2,
        fields: { note: "edited while deferred" },
        actor,
      })
      expect(edit.currentPayload.note).toBe("edited while deferred")

      await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

      expect(await statusOf(a2)).toBe("approved")
      expect(await readDecidedResult(ORG, a2)).toEqual({ sent: "edited while deferred" })
    } finally {
      approvalEditableFieldsRegistry.delete([ORG, "seq_test", "step2"])
    }
  })

  it("an approve from a card binds every later step to the version the card showed", async () => {
    approvalEditableFieldsRegistry.set(
      [ORG, "seq_test", "step2"],
      [{ field: "note", label: "Note", widget: "text" }],
    )
    try {
      const a1 = await gated("step1", { kind: "x" })
      const a2 = await gated("step2", { note: `@ref:${a1}:value` })
      const shown = await sql<{ id: string; tool_name: string; current_payload: unknown }[]>`
        SELECT id, tool_name, current_payload FROM kernel.approval_requests
        WHERE id IN (${a1}, ${a2})`
      const hashOf = (id: string) => {
        const r = shown.find((x) => x.id === id)
        if (!r) throw new Error(`approval ${id} not found`)
        return approvalPayloadHash(r.tool_name, r.current_payload)
      }
      const headHash = hashOf(a1)
      const stepHash = hashOf(a2)

      // The card never listed the step: refused, nothing runs.
      await expect(
        decideApproval({
          orgId: ORG,
          requestId: a1,
          actor,
          decision: "approve",
          payloadHash: headHash,
        }),
      ).rejects.toMatchObject({ code: "payload_changed" })
      expect(await statusOf(a1)).toBe("pending")

      // The requester edits the step after the card loaded: refused, nothing runs.
      await updatePayload({ orgId: ORG, requestId: a2, fields: { note: "to someone else" }, actor })
      await expect(
        decideApproval({
          orgId: ORG,
          requestId: a1,
          actor,
          decision: "approve",
          payloadHash: headHash,
          stepPayloadHashes: { [a2]: stepHash },
        }),
      ).rejects.toMatchObject({ code: "payload_changed" })
      expect(await statusOf(a1)).toBe("pending")
      expect(await statusOf(a2)).toBe("deferred")

      // Reviewed again: the current version runs.
      const [now] =
        await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${a2}`
      await decideApproval({
        orgId: ORG,
        requestId: a1,
        actor,
        decision: "approve",
        payloadHash: headHash,
        stepPayloadHashes: { [a2]: approvalPayloadHash(now.tool_name, now.current_payload) },
      })
      expect(await statusOf(a2)).toBe("approved")
      expect(await readDecidedResult(ORG, a2)).toEqual({ sent: "to someone else" })
    } finally {
      approvalEditableFieldsRegistry.delete([ORG, "seq_test", "step2"])
    }
  })

  it("a step changed after the approval was given does not run", async () => {
    const a1 = await gated("editnext", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    expect(await statusOf(a1)).toBe("approved")
    // editnext's handler rewrote the step after the approval bound it.
    expect(await statusOf(a2)).toBe("cancelled")
    expect(await readDecidedResult(ORG, a2)).toBeFalsy()
  })

  it("fails the bundle instead of silently abandoning it when a step leaves the deferred state", async () => {
    const a1 = await gated("step1", { kind: "x" })
    // cancelnext (pos 1) and step2 (pos 2) both depend on the head a1.
    const a2 = await gated("cancelnext", { note: `@ref:${a1}:value` })
    const a3 = await gated("step2", { note: `@ref:${a1}:value` })
    expect(await statusOf(a2)).toBe("deferred")
    expect(await statusOf(a3)).toBe("deferred")

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    // a2's handler cancels a3; the cascade then meets a3 no longer deferred and
    // must NOT silently stop — it fails the bundle and posts a system message.
    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("approved")
    expect(await statusOf(a3)).toBe("cancelled")
    const msgs = await sql`SELECT content FROM kernel.messages
      WHERE org_id = ${ORG} AND content ILIKE '%could not complete%'`
    expect(msgs.length).toBeGreaterThan(0)
  })
})
