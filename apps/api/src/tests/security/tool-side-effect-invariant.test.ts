// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tool side effects are enforced by the host, enumerated at runtime.
//
// 1. A read-only run: every method of the sandbox host bridge is refused,
//    guards itself, or is a reviewed read (bridge-read-only-run.test.ts, pure);
//    here, resolveContact on a read-only run only looks up (1b).
// 2. A tool that declares itself readOnly cannot write: the write is refused at
//    the boundary whatever run it is in, because the marker is a claim the tool
//    makes about itself.
// 3. Tools projected from a remote MCP server are gated by default, whatever
//    the server's own annotations say.
// 4. Every ungated tool with an outward channel (externalEffect, code on the
//    person's computer, or a name that says it sends, posts, submits, uploads,
//    pays...) is in one reviewed list with the control that holds it instead.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { type RlsClient, sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { contacts, threads } from "~/db/schema/kernel"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { resolveContact as resolveContactService } from "~/modules/contacts/service"
import { ToolProjector } from "~/modules/mcp-client/projector"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { readManifests } from "../../../test-support/security/enumerate"

// ─── 1b. read-only run: resolveContact only looks up ───────────────────────

describe("S3f-1b: resolveContact on a read-only run is a lookup", () => {
  const as = <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> =>
    withRlsContext(
      {
        actorType: "user",
        userId: owner.userId,
        orgId: owner.orgId,
        scopes: ["kernel:contacts:read", "kernel:contacts:write"],
        dimensionGrants: { "*": ["*"] },
      },
      fn,
    )
  /** A bridge of an app that may add contacts to the organisation, on a real transaction. */
  const bridgeOn = (tx: unknown, readOnlyRun: boolean) =>
    createRpcBridge(
      "inv_app",
      owner.userId,
      owner.orgId,
      tx as any,
      {
        name: "inv_app",
        schema: {},
        events: { emits: [] },
        capabilities: ["contacts.addToOrganisation"],
      },
      ["inv_app:read", "kernel:contacts:read", "kernel:contacts:write"],
      "user",
      undefined,
      { readOnlyRunOverride: readOnlyRun, callChain: [] } as any,
    )
  const email = `ro-${crypto.randomUUID().slice(0, 8)}@example.com`

  it("returns an org contact unchanged, creates nothing on a miss, and refuses clear", async () => {
    const seeded = await as(async (tx) => {
      return (
        await resolveContactService(
          tx,
          owner.orgId,
          owner.userId,
          { email },
          {
            audience: "org",
          },
        )
      ).contact!
    })
    const read = (where: ReturnType<typeof eq>) =>
      as((tx) =>
        tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.orgId, owner.orgId), where)),
      )

    const found = await as(async (tx) =>
      JSON.parse(
        await bridgeOn(tx, true).resolveContact(
          JSON.stringify({
            email,
            name: "Leaked",
            company: "Leaked Co",
            externalId: "secret-text",
          }),
        ),
      ),
    )
    expect((await read(eq(contacts.id, seeded.id))).length).toBe(1)
    expect(found?.id).toBe(seeded.id)
    const [after] = await read(eq(contacts.id, seeded.id))
    expect(after!.name).toBeNull()
    expect(after!.company).toBeNull()
    expect(after!.externalIds).toEqual({})

    // A miss: the same shape as a link-only app's miss (null), and no row.
    const missEmail = `miss-${email}`
    const miss = await as(async (tx) =>
      JSON.parse(await bridgeOn(tx, true).resolveContact(JSON.stringify({ email: missEmail }))),
    )
    expect(miss).toBeNull()
    expect(await read(eq(contacts.email, missEmail))).toEqual([])

    let msg = ""
    try {
      await as((tx) =>
        bridgeOn(tx, true).resolveContact(JSON.stringify({ clear: true, externalId: "x" })),
      )
    } catch (err) {
      msg = String((err as Error).message)
    }
    expect(msg.toLowerCase()).toContain("read_only_run")

    // An ordinary run of the same app still links and enriches.
    await as(async (tx) => {
      return bridgeOn(tx, false).resolveContact(JSON.stringify({ email, name: "Linked" }))
    })
    const [linked] = await read(eq(contacts.id, seeded.id))
    expect(linked!.name).toBe("Linked")
  })
})

// ─── 2/4. the tool registry ─────────────────────────────────────────────────

let owner: minimal.Session
let threadId: string

beforeAll(async () => {
  await acquireTestLock()
  owner = await minimal.adminSession((await createTestOrg()).id)
  threadId = await minimal.thread(owner.orgId, owner.userId)
  await ensureAppsForOrg(owner.orgId)
})

afterAll(async () => {
  await releaseTestLock()
})

// The enforceable boundary: `readOnly` is a self-declaration. It can shield a
// tool from running on a read-only run, but it does NOT let a tool that declares
// a write target skip the write boundaries — `isReadOnlyTool` is false the moment
// `writesToTable` is present (read-only-run.ts), so the scope-taint check and the
// read-only-run check both still apply. (A tool claiming readOnly with no declared
// target is honoured only for kernel/first-party/publisher-signed code; a
// third-party manifest's claim is dropped at registration, runtime.ts:2182.)
describe("S3f-2: a readOnly declaration does not shield a declared write", () => {
  async function runWritingTool(toolDef: Record<string, unknown>): Promise<{
    written: boolean
    ran: boolean
  }> {
    let ran = false
    toolRegistry.set([owner.orgId, "kernel", "t_marked_write"], {
      appName: "kernel",
      name: "t_marked_write",
      description: "writes a thread row (test stand-in)",
      requiredScopes: ["kernel:threads:read"],
      writesToTable: "kernel.threads",
      params: z.object({}),
      handler: async (_p: unknown, ctx: any) => {
        await ctx.db
          .update(threads)
          .set({ title: "written by t_marked_write" })
          .where(eq(threads.id, threadId))
        ran = true
        return { ok: true }
      },
      ...toolDef,
    } as never)
    const runId = crypto.randomUUID()
    const acc = createTurnScopeAccumulator()
    // The turn has read confidential data the conversation's readers may not hold.
    acc.recordInjected(["invoicing:documents:read"])
    const frame: RunContext = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      turnScopeAccumulator: acc,
    } as RunContext
    const actor = {
      actorType: "user" as const,
      userId: owner.userId,
      orgId: owner.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
    try {
      await runContextStore.run(frame, () =>
        executeTool({
          toolName: "kernel:t_marked_write",
          orgId: owner.orgId,
          actor,
          params: {},
          threadId,
          origin: "in-app-agent",
          stepBundleId: null,
        }),
      )
    } catch {
      /* refused */
    }
    const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${threadId}`
    await sql`UPDATE kernel.threads SET title = NULL WHERE id = ${threadId}`
    toolRegistry.delete([owner.orgId, "kernel", "t_marked_write"])
    return { written: row?.title === "written by t_marked_write", ran }
  }

  it("a declared write after outside text is scope-taint-held even when the tool claims readOnly", async () => {
    // readOnly + a declared write target: isReadOnlyTool is false, so the taint boundary stands.
    const claims = await runWritingTool({ readOnly: true })
    // The plain write (no readOnly claim) is held the same way: the claim bought nothing.
    const plain = await runWritingTool({})
    expect({ claims, plain }).toEqual({
      claims: { written: false, ran: false },
      plain: { written: false, ran: false },
    })
  })
})

describe("S3f-3: MCP-projected tools are gated by default unless the server marks them read-only", () => {
  it("the default connection runs only non-destructive read-only tools without approval", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const annotations = [
      { readOnlyHint: true, destructiveHint: false },
      { readOnlyHint: true },
      { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      {},
      { readOnlyHint: true, destructiveHint: true },
      { readOnlyHint: false },
    ]
    // Owner rule (2026-10-25): under gate_writes a readOnlyHint tool that is not destructive runs
    // without approval; everything else parks. A mislabelled write is the residual risk.
    const expectedGated = [false, false, true, true, true, true]
    await projector.registerTools({
      orgId: owner.orgId,
      connectionId: crypto.randomUUID(),
      slug: "inv-remote",
      tools: annotations.map((a, i) => ({
        name: `t${i}`,
        description: "remote",
        inputSchema: { type: "object" },
        annotations: a,
      })),
    })
    for (let i = 0; i < annotations.length; i++) {
      const entry = toolRegistry.get([owner.orgId, "mcp", `inv-remote:t${i}`])
      expect({ i, gated: entry?.gated, externalEffect: entry?.externalEffect }).toEqual({
        i,
        gated: expectedGated[i],
        externalEffect: true,
      })
    }
  })
})

/** Names that say the tool acts outside Liaison or on a person's machine. */
const OUTWARD_NAME =
  /(send|post|publish|upload|email|mail(?!box)|notify|submit|transmit|issue|refund|fulfil|ship|pay|purchase|invite|share|export|webhook|reply|forward|compose|deactivate|disconnect|run_on|computer_session|delete_event|create_event|update_event|book|advance)/i

/** Ungated outward tools, each with the control that holds it instead of a per-call approval. */
const REVIEWED_UNGATED_OUTWARD: Record<string, string> = {
  "kernel:client_action_revoke":
    "conditionalGate + externalEffect + requiresHumanTurn: a person's own clean turn withdraws a link at once; after outside text, or from a routine, MCP or sub-run, it parks for a person (modules/client-actions/tools.ts). It only stops a link working: nothing is sent or shown outside",
  "kernel:portal_remove_person":
    "conditionalGate + externalEffect + requiresHumanTurn, and gatedWhen erase: a person's own clean turn removes a client from the portal at once; after outside text, or from a routine, MCP or sub-run, it parks; erasing always parks with noAutoApprove (modules/portal/tools.ts). Removing only stops access: nothing is sent or shown outside",
  "boxtal:import_shipments":
    "local import of shipments already booked at the provider; no booking or purchase",
  "boxtal:prep_add_shipment": "local prep row; buying a label is the gated ship tools",
  "boxtal:shipment_draft_create": "local draft; buying a label is the gated ship tools",
  "boxtal:shipment_draft_set_customs": "local draft field",
  "boxtal:shipment_draft_set_package": "local draft field",
  "boxtal:webhooks_repair":
    "re-registers the org's own provider webhooks; admin config scope boxtal:catalog:write, no data out",
  "tickets:merge":
    "conditionalGate + externalEffect: it parks after outside text, and an agent's merge into a ticket a client's portal shows parks for a person (apps/tickets/handlers.ts); another company's or a more sensitive ticket is refused (apps/tickets/merge.ts). Nothing is sent",
  "calendar:create_event":
    "host gate: approval when inviting an address nobody in the org knows (owner verdict; scopes/host-approval-gates.ts), sendUpdates=none",
  "calendar:delete_event":
    "own calendar write, sendUpdates=none; no new recipient (owner verdict scope)",
  "calendar:update_event": "same host gate as create_event",
  "google-drive:upload":
    "externalEffect: parks after outside text (execute-tool.ts:4352-4470) unless Agent Safety off (owner verdict)",
  "invoicing:advance_draft_create":
    "an advance invoice draft: takes no number and sends nothing; its issue parks as invoicing:invoice_issue, never auto-approved",
  "invoicing:advance_refund_prepare":
    "conditionalGate: prepares the refund only; the credit note parks as invoicing:credit_note_create_and_issue before anything is issued or sent",
  "invoicing:billing_plan_set":
    "externalEffect: a project's billing plan rows in invoicing, parked after outside text; nothing is numbered and nothing leaves Liaison",
  "invoicing:contact_relationships_set": "local relationship row",
  "invoicing:credit_note_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:credit_note_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:drafts_create":
    "local draft row, or a row added to a month-end run: nothing is issued, numbered or sent; a draft with an outside-text taint parks after outside text (execute-tool.ts taint escalation); an agent's run-row add also lands on the run's gated card",
  "invoicing:drafts_discard":
    "externalEffect: parks after outside text (execute-tool.ts taint escalation); an agent's take-out or end-schedule of a month-end row parks for a person (conditionalGate, handler's ctx.requestApproval); a draft discard takes no number and sends nothing",
  "invoicing:drafts_update":
    "local draft row, or a month-end row change: nothing is issued or sent; externalEffect parks after outside text (execute-tool.ts taint escalation); an agent's run-row edit restages the run's gated card",
  "invoicing:einvoice_send_request":
    "stages the send approval (einvoicing/transmit.ts einvoiceSendRequest); the PA submit needs the approval's dispatch grant",
  "invoicing:po_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:issuer_emails_confirm":
    "an agent's call always parks via the handler's ctx.requestApproval (conditionalGate); only a person's own click records the statement, which sends nothing and changes no document",
  "invoicing:po_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:quote_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:recurring_run_unapprove":
    "externalEffect: parks after outside text (execute-tool.ts taint escalation); an undo returns the run to drafted, takes no number, sends nothing, and restages the run's gated card",
  "invoicing:recurring_schedule_pause":
    "externalEffect: parks after outside text (execute-tool.ts taint escalation); a pause only stops drafts, bills nothing and sends nothing",
  "kernel:approval_update_payload":
    "edits a pending approval; the decision is bound to the payload hash the person saw (decide.ts:262-275, cascade lock)",
  "kernel:bulkDeactivateUsers":
    "bulk wrapper: each account dispatches through kernel:deactivateUser, which is gated (kernel-bulk-untrusted.test.ts)",
  "kernel:computer_session_answer":
    "requiresHumanTurn + refuseBeforeGate (kernel-tools.ts); replayed outside text keeps the mark (untrusted-text-across-turns.test.ts)",
  "kernel:computer_session_send":
    "requiresHumanTurn + refuseBeforeGate (kernel-tools.ts); replayed outside text keeps the mark",
  "kernel:computer_session_settings":
    "autonomy change is requiresHumanTurn; level raises are confirmed on the node",
  "kernel:computer_session_stop": "stops the person's own session; no code runs",
  "kernel:files_upload_confirm": "internal",
  "kernel:files_upload_url": "internal upload slot for the person",
  "kernel:notify_user": "internal notification to an org member; scope-taint sinkReadersSelf",
  "kernel:run_on_my_computer":
    "requiresHumanTurn: parks unless a typed, unmarked turn (execute-tool.ts); replayed outside text keeps the mark (untrusted-text-across-turns.test.ts)",
  "kernel:set_away":
    "conditionalGate + requiresHumanTurn + noAutoApprove (kernel-tools.ts): runs at once only on the person's own untainted turn, or a holder of kernel:users:admin or projects:capacity:write for someone else; any other call parks to the requester alone (requesterAlways); it writes dates and person ids only (set-away.test.ts)",
  "kernel:threads_reply": "internal thread post; scope-taint judged on the room's readers",
  "kernel:web_fetch":
    "a read that never parks (outboundWebRead, scope-taint.ts rule 9): its URL is bounded inline by the web-read guardrails (length, query string, userinfo, opaque or personal data on a turn that read org data, per-turn and per-thread rate; web-read-guardrails.ts), plus the org allow/blocklist and the SSRF guard",
  "mail:disconnectAccount": "internal, the person's own account row",
  "mail:export_conversations": "file for the requester from rows they can read; nothing sent",
  "mail:suppression_add":
    "externalEffect: parks after outside text, so outside text cannot silence an address; it only stops commercial mail and sends nothing",
  "projects:time_plan_set":
    "a project's own plan row; externalEffect only so a tainted turn parks turning dated hours on, which shows the lead and finance dated entries from that day; nothing leaves Liaison",
  "shopify:webhooks_repair":
    "re-registers the org's own Shopify webhooks; admin identity-map scope",
  "stripe:customer_link":
    "links a mirrored customer to a company or contact the person can read, in Liaison only; nothing reaches the provider, and it parks after outside text",
  "tickets:convertToMail": "internal conversion; sending is the gated mail compose",
  "tickets:csat.request": "externalEffect: parks after outside text (owner verdict AGM-2)",
  "tickets:inboxes.disconnect": "admin-scoped, internal",
}

interface ToolFacts {
  gated: boolean
  conditionalGate: boolean
  externalEffect: boolean
  requiresHumanTurn: boolean
  agentVisible: boolean
  contractOnly: boolean
  readOnly: boolean
}

function collectTools(orgId: string): Map<string, ToolFacts> {
  const out = new Map<string, ToolFacts>()
  for (const [[o, app, name], def] of toolRegistry.entries()) {
    if (o !== orgId && o !== "*") continue
    if (app === "mcp") continue
    const d = def as Record<string, any>
    out.set(`${app}:${name}`, {
      gated: d.gated === true,
      conditionalGate: d.conditionalGate === true,
      externalEffect: d.externalEffect === true,
      requiresHumanTurn: d.requiresHumanTurn !== undefined && d.requiresHumanTurn !== false,
      agentVisible: d.agentVisible !== false,
      contractOnly: d.contractOnly === true,
      readOnly: d.readOnly === true,
    })
  }
  // Bundled apps are not installed in this org: their declarations, as shipped.
  for (const m of readManifests()) {
    const tools = m.manifest.tools ?? {}
    const entries = Array.isArray(tools)
      ? tools.map((t: any) => [t.name, t] as [string, any])
      : (Object.entries(tools) as Array<[string, any]>)
    for (const [name, d] of entries) {
      const id = `${m.manifest.name ?? m.app}:${name}`
      if (out.has(id)) continue
      out.set(id, {
        gated: d.gated === true,
        conditionalGate: d.conditionalGate === true,
        externalEffect: d.externalEffect === true,
        requiresHumanTurn: false,
        agentVisible: d.agentVisible !== false,
        contractOnly: d.contractOnly === true,
        readOnly: d.readOnly === true,
      })
    }
  }
  return out
}

describe("S3f-4: ungated tools with an outward channel are reviewed", () => {
  it("every one is in the reviewed list, and the list has no stale entry", () => {
    const all = collectTools(owner.orgId)
    expect(all.size).toBeGreaterThan(400)
    const unreviewed: string[] = []
    const ungatedOutward = new Set<string>()
    for (const [id, f] of [...all.entries()].sort()) {
      if (f.gated || !f.agentVisible || f.contractOnly) continue
      // A declared read with no outward channel (the marker is enforced by S3f-2).
      if (f.readOnly && !f.externalEffect && !f.requiresHumanTurn) continue
      const outward =
        f.externalEffect ||
        f.requiresHumanTurn ||
        OUTWARD_NAME.test(id.split(":").slice(1).join(":"))
      if (!outward) continue
      ungatedOutward.add(id)
      if (id in REVIEWED_UNGATED_OUTWARD) continue
      unreviewed.push(id)
    }
    expect(unreviewed).toEqual([])
    // Stale: the tool is gone, or it is gated (or hidden, or a read) now, so its reviewed
    // reason no longer describes it. Drop the entry; the gate has its own regression test.
    expect(Object.keys(REVIEWED_UNGATED_OUTWARD).filter((id) => !ungatedOutward.has(id))).toEqual(
      [],
    )
  })
})
