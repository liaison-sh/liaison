// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE AUDIENCE RULE FOR EVERY WRITE ON A TAINTED TURN (scope-taint.ts, rules 5 to 7).
//
// Found on a long-lived coworker DM: after one abnormal turn stamped its reply with the
// requester's whole effective scope (write and action scopes included), a Boxtal draft write
// (an ungated app table declaring no readers) and a ticket reply draft (a gated shared surface)
// were refused on every later turn, though nobody who could read either lacked anything the
// turn had read. What the rule protects is unchanged: data read under S never reaches a person
// lacking S. These cases pin, through the real chat seam (buildToolSet's execute closure, then
// executeToolCore):
//
//   1. the history stamp is projected onto read scopes, and the bundled boxtal app's draft
//      table (no declared sinkReadScope) is judged by its real readers: the write runs when
//      every one of them holds every read scope, and parks for an approver holding them when
//      one does not (rule 8, refused only while nobody who may approve it holds them);
//   2. a ticket reply on a tainted turn parks as an approval when every reader of the ticket's
//      drafts holds the taint, and ALSO when one lacks a scope (rule 8, 2026-10-20): its card
//      says approving shares the data with readers of the ticket, it routes only to approvers
//      holding the taint, and a reader lacking it cannot read the pending draft; it is refused
//      only when nobody who may approve it holds the taint.
//   3. a call to an MCP server on a turn whose every taint came from that same server (rule 6g)
//      runs without approval: a fetch of a page its own search returned. Taint from anywhere
//      else (knowledge, a ticket, another server, the unknown sentinel) is judged as before.
//   4. the outside-content hold lets a READ on an MCP server through when every source of the
//      thread's outside text is that server (rule 6h). A write, outside text from anywhere else,
//      another server, or an unknown (legacy) source keeps the hold.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { approvalResultRequiredScopes } from "~/modules/approvals/result-notice"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"
import {
  REQUESTER_EFFECTIVE_SCOPE,
  REQUESTER_TAINT_PROJECTION,
} from "~/tests/helpers/requester-effective-scope"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000e7b01"
const REQUESTER = "00000000-0000-4000-8000-0000000e7b02"
const READER = "00000000-0000-4000-8000-0000000e7b03"
const LACKER = "00000000-0000-4000-8000-0000000e7b04"
const DM = "00000000-0000-4000-8000-0000000e7b05"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const BOXTAL_MANIFEST = JSON.parse(
  readFileSync(join(REPO, "bundled-apps", "boxtal", "app.manifest.json"), "utf8"),
) as {
  name: string
  version: string
  scopes: string[]
  schema: Record<string, unknown>
  tools: Record<string, Record<string, unknown>>
}
const DRAFT_TOOL = "shipment_draft_set_package"
const DRAFT_TABLE = "app_boxtal.app_config"
/** What the stub draft handler returns, so a run is told apart from a refusal. */
const DRAFT_RAN = "draftHandlerRan"

const actor: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: REQUESTER_EFFECTIVE_SCOPE,
  dimensionGrants: {},
}

const ran: string[] = []
let bundleDir = ""

/** A turn that read the DM's history: the earlier reply's stamp is injected, as context does. */
function turnFrame(historyStamp: string[]): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId: ORG })
  turnScopeAccumulator.recordInjected(historyStamp)
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, turnScopeAccumulator }
}

async function call(
  frame: RunContext,
  sdkName: string,
  args: Record<string, unknown> = {},
  as: UserContext = actor,
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, as, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

function refused(r: Record<string, unknown>): boolean {
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return true
  return typeof r.error === "string" && r.error.includes("E_SCOPE_TAINT_BLOCKED")
}

async function grant(userId: string, scopes: readonly string[]) {
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

async function revokeAll(userId: string) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${userId}`
}

describe("scope taint: one audience rule, judged by who can read what the write lands in", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Taint Audience Readers Org', 'taint-audience-readers-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [REQUESTER, "taint-audience-requester@test.com"],
      [READER, "taint-audience-reader@test.com"],
      [LACKER, "taint-audience-lacker@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    // The requester holds the 34 scopes; a colleague holds exactly the reads they imply.
    await grant(REQUESTER, REQUESTER_EFFECTIVE_SCOPE)
    await grant(READER, REQUESTER_TAINT_PROJECTION)
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'taint-audience-dm', 'agent_chat', ${REQUESTER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${REQUESTER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${REQUESTER}, ${DM}, ${ORG}) ON CONFLICT DO NOTHING`

    await ensureAppsForOrg(ORG)

    // The bundled boxtal app's draft table and draft tool exactly as its manifest declares
    // them, registered through the real app runtime; only the handler is a stub. Boxtal is a
    // catalog app: a sandboxed app's write-target readers are derived only when the platform
    // vouches for its declarations, which a catalog install does (`_firstParty`, init.ts).
    bundleDir = mkdtempSync(join(tmpdir(), "taint-audience-boxtal-"))
    const bundlePath = join(bundleDir, "handler-bundle.js")
    // A sandboxed bundle: the handler is a global function the runtime calls by name.
    writeFileSync(
      bundlePath,
      `async function ${String(BOXTAL_MANIFEST.tools[DRAFT_TOOL]?.handler)}() { return { ${DRAFT_RAN}: true } }\n`,
    )
    await registerApps(
      [
        {
          name: BOXTAL_MANIFEST.name,
          version: BOXTAL_MANIFEST.version,
          scopes: BOXTAL_MANIFEST.scopes,
          schema: BOXTAL_MANIFEST.schema,
          tools: { [DRAFT_TOOL]: BOXTAL_MANIFEST.tools[DRAFT_TOOL] },
          _firstParty: true,
          _format: "manifest",
          _bundlePath: bundlePath,
        } as never,
      ],
      ORG,
    )

    // The ticket reply's handler is a probe: a tainted reply must park, never run inline.
    const reply = toolRegistry.get([ORG, "tickets", "reply"])
    if (!reply) throw new Error("tickets:reply is not registered")
    toolRegistry.set([ORG, "tickets", "reply"], {
      ...reply,
      preflight: undefined,
      // The two fields a reply draft carries, so an edit of its textBody is a real parameter.
      params: z.object({ ticketId: z.string(), textBody: z.string() }).passthrough(),
      handler: async () => {
        ran.push("tickets:reply")
        return { ok: true }
      },
    } as never)
  }, 180_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    rmSync(bundleDir, { recursive: true, force: true })
    await releaseTestLock()
  })

  it("the history stamp carries write scopes; every draft-table reader holds every read scope: the draft write runs", async () => {
    ran.length = 0
    const frame = turnFrame(REQUESTER_EFFECTIVE_SCOPE)
    const r = await call(frame, `boxtal__${DRAFT_TOOL}`, {
      draft_id: "d1",
      override: { pack: "STUDIO-BOX" },
    })
    expect({ refused: refused(r), r }).toEqual({ refused: false, r })
    expect(JSON.stringify(r)).toContain(DRAFT_RAN)
  })

  it("one user who reads the draft table but lacks one tainted read scope: the ungated write PARKS as a disclosure decided by holders of the taint, not by boxtal:approve (rules 8b, 8h)", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    // Any boxtal grant reads the app's internal table (the app's own scope alias), so a
    // shipments reader is a reader of the drafts.
    await grant(
      LACKER,
      REQUESTER_TAINT_PROJECTION.filter((s) => s !== "tickets:tickets:read"),
    )
    const taint = [...REQUESTER_TAINT_PROJECTION].sort()
    try {
      // Nobody holds boxtal:approve, and nobody needs to: the call would have run inline on a
      // clean turn, so its approval is the disclosure alone, decided by whoever holds the taint.
      const parked = await call(turnFrame(REQUESTER_EFFECTIVE_SCOPE), `boxtal__${DRAFT_TOOL}`, {
        draft_id: "d1",
        override: { pack: "STUDIO-BOX" },
      })
      expect({ refused: refused(parked), parked }).toEqual({ refused: false, parked })
      expect(parked.blocked).toBe(true)
      expect(JSON.stringify(parked)).not.toContain(DRAFT_RAN)
      const [row] = (await sql`SELECT status, notify_user_ids, summary, approve_scope,
          dimension_constraint, metadata, proposing_turn_scopes
        FROM kernel.approval_requests WHERE id = ${parked.approvalRequestId as string}`) as Array<{
        status: string
        notify_user_ids: string[]
        summary: { lines: string[] }
        approve_scope: string | null
        dimension_constraint: unknown
        metadata: { taintAudienceMustHold?: string[] }
        proposing_turn_scopes: string[] | null
      }>
      expect(row?.status).toBe("pending")
      // Decided by the taint: the first taint scope on the column, all of them on the row.
      expect(row?.approve_scope).toBe(taint[0] ?? "")
      expect(row?.approve_scope).not.toBe("boxtal:approve")
      expect(row?.dimension_constraint).toBeNull()
      expect([...(row?.metadata.taintAudienceMustHold ?? [])].sort()).toEqual(taint)
      // Routed to everyone holding the whole taint (the requester and the reader), never the
      // reader lacking one scope.
      expect([...(row?.notify_user_ids ?? [])].sort()).toEqual([REQUESTER, READER].sort())
      const note = row?.summary.lines.at(-1) ?? ""
      expect(note).toContain(`some people who can read ${DRAFT_TABLE} cannot see`)
      expect(note).toContain("approving shares it with them")

      // The reader's feed folds it as peer noise: its requester can decide it herself.
      const readerFeed = await withRlsContext(
        {
          actorType: "user",
          userId: READER,
          orgId: ORG,
          scopes: REQUESTER_TAINT_PROJECTION,
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, READER),
      )
      const item = readerFeed.find((i) => i.entityId === parked.approvalRequestId)
      expect(item?.metadata?.peerSelfApprovable).toBe(true)

      // A decider holding the column's scope but not every taint scope cannot decide it, even
      // once notified (the decide re-check of taintAudienceMustHold).
      await sql`UPDATE kernel.approval_requests
        SET notify_user_ids = array_append(notify_user_ids, ${LACKER}::uuid)
        WHERE id = ${parked.approvalRequestId as string}`
      const lackerCtx: UserContext = {
        actorType: "user",
        userId: LACKER,
        orgId: ORG,
        scopes: REQUESTER_TAINT_PROJECTION.filter((s) => s !== "tickets:tickets:read"),
        dimensionGrants: {},
      }
      const lackerDeny = await decideApproval({
        orgId: ORG,
        requestId: parked.approvalRequestId as string,
        actor: lackerCtx,
        decision: "deny",
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(lackerDeny).toBeInstanceOf(ApprovalDecisionError)
      expect((lackerDeny as ApprovalDecisionError).status).toBe(403)

      // The requester holds every taint scope but not boxtal:approve: she decides her own card.
      await decideApproval({
        orgId: ORG,
        requestId: parked.approvalRequestId as string,
        actor,
        decision: "approve",
      })
      const [after] = (await sql`SELECT status FROM kernel.approval_requests
        WHERE id = ${parked.approvalRequestId as string}`) as Array<{ status: string }>
      expect(after?.status).not.toBe("pending")
    } finally {
      await revokeAll(LACKER)
      // The approved run's execution record pins the row (ON DELETE RESTRICT).
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    }
  })

  it("a ticket reply on a tainted turn parks as an approval when every ticket-draft reader holds the taint", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const frame = turnFrame(REQUESTER_EFFECTIVE_SCOPE)
    const r = await call(frame, "tickets__reply", {
      ticketId: "00000000-0000-4000-8000-0000000e7bff",
      textBody: "Votre colis est parti.",
    })
    expect({ refused: refused(r), r }).toEqual({ refused: false, r })
    expect(r.blocked).toBe(true)
    // Parked, never run inline: auto-approval stays off on a tainted turn.
    expect(ran).toEqual([])
    const [row] = (await sql`SELECT status, approve_scope FROM kernel.approval_requests
      WHERE id = ${r.approvalRequestId as string}`) as Array<{
      status: string
      approve_scope: string | null
    }>
    expect(row?.status).toBe("pending")
    // A gated tool keeps its own deciding scope on a tainted turn (rule 8h applies to ungated
    // writes only); the taint narrows who among its holders decides.
    expect(row?.approve_scope).toBe("tickets:approve")
  })

  it("the same ticket reply PARKS when one ticket reader lacks a tainted scope: the card says why, the reader cannot see it (rule 8)", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    // A ticket reader who could also decide, but lacks one scope the turn read.
    await grant(LACKER, ["tickets:tickets:read", "tickets:approve"])
    try {
      const frame = turnFrame(REQUESTER_EFFECTIVE_SCOPE)
      const r = await call(frame, "tickets__reply", {
        ticketId: "00000000-0000-4000-8000-0000000e7bff",
        textBody: "Votre colis est parti.",
      })
      expect({ refused: refused(r), r }).toEqual({ refused: false, r })
      expect(r.blocked).toBe(true)
      // Parked, never run inline.
      expect(ran).toEqual([])
      const [row] = (await sql`SELECT status, notify_user_ids, metadata, summary
        FROM kernel.approval_requests WHERE id = ${r.approvalRequestId as string}`) as Array<{
        status: string
        notify_user_ids: string[]
        metadata: { taintAudienceMustHold?: string[] }
        summary: { lines: string[] }
      }>
      expect(row?.status).toBe("pending")
      // Routed only to approvers holding the taint: the requester, never the lacker.
      expect(row?.notify_user_ids).toContain(REQUESTER)
      expect(row?.notify_user_ids).not.toContain(LACKER)
      expect(row?.metadata.taintAudienceMustHold).toContain("kernel:agent:memory:read")
      // The card says, in plain words, that approving discloses to readers of the ticket.
      const note = row?.summary.lines.at(-1) ?? ""
      expect(note).toContain("Drafted after reading")
      expect(note).toContain("this ticket")
      expect(note).toContain("approving shares it with them")
      expect(note).not.toContain(LACKER)
      // The lacker reads the ticket, yet cannot read the pending draft (0167).
      const seen = await withRlsContext(
        {
          actorType: "user",
          userId: LACKER,
          orgId: ORG,
          scopes: ["tickets:tickets:read", "tickets:approve"],
          dimensionGrants: {},
        },
        (tx) =>
          tx.execute(
            drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${r.approvalRequestId as string}`,
          ),
      )
      expect(extractRows(seen)).toHaveLength(0)
    } finally {
      await revokeAll(LACKER)
    }
  })

  it("refused only when nobody who may approve it holds the turn's scopes, naming the remedy (rule 8)", async () => {
    ran.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    // The only holder of tickets:approve lacks one tainted scope; the requester no longer holds it.
    await sql`DELETE FROM kernel.user_scope_grants
      WHERE org_id = ${ORG} AND user_id = ${REQUESTER} AND scope = 'tickets:approve'`
    await grant(LACKER, ["tickets:tickets:read", "tickets:approve"])
    const requesterWithoutApprove: UserContext = {
      ...actor,
      scopes: REQUESTER_EFFECTIVE_SCOPE.filter((s) => s !== "tickets:approve"),
    }
    try {
      const frame = turnFrame(REQUESTER_EFFECTIVE_SCOPE)
      const r = await call(
        frame,
        "tickets__reply",
        {
          ticketId: "00000000-0000-4000-8000-0000000e7bff",
          textBody: "Votre colis est parti.",
        },
        requesterWithoutApprove,
      )
      expect(refused(r)).toBe(true)
      const text = JSON.stringify(r)
      expect(text).toContain("nobody holding tickets:approve")
      expect(text).toContain("an admin adjusts scopes")
      expect(text).not.toContain(LACKER)
      expect(ran).toEqual([])
      const rows = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
      expect(rows).toHaveLength(0)
    } finally {
      await revokeAll(LACKER)
      await grant(REQUESTER, ["tickets:approve"])
    }
  })

  describe("rewriting a pending ticket reply on a tainted turn restages it in place (rule 8g)", () => {
    const TICKET = "00000000-0000-4000-8000-0000000e7bfe"
    // The editor may call kernel__approval_update_payload.
    const editor: UserContext = {
      ...actor,
      scopes: [...REQUESTER_EFFECTIVE_SCOPE, "kernel:approvals:write"],
    }
    type Row = {
      id: string
      current_payload: { textBody?: string }
      proposing_turn_scopes: string[] | null
      notify_user_ids: string[]
      metadata: { taintAudienceMustHold?: string[] }
      summary: { lines: string[] }
      thread_id: string
    }
    const rows = async () =>
      (await sql`SELECT id, current_payload, proposing_turn_scopes, notify_user_ids, metadata,
          summary, thread_id
        FROM kernel.approval_requests WHERE org_id = ${ORG}`) as unknown as Row[]
    const seenBy = async (userId: string, scopes: string[], id: string) =>
      extractRows(
        await withRlsContext(
          { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
          (tx) => tx.execute(drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${id}`),
        ),
      ).length
    const LACKER_SCOPES = ["tickets:tickets:read", "tickets:approve"]

    /** A first draft from a turn that read only the ticket: every ticket reader holds that. */
    async function firstDraft(): Promise<string> {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
      const r = await call(turnFrame(["tickets:tickets:read"]), "tickets__reply", {
        ticketId: TICKET,
        textBody: "Nous regardons votre commande.",
      })
      expect(r.blocked).toBe(true)
      const id = r.approvalRequestId as string
      expect(await seenBy(LACKER, LACKER_SCOPES, id)).toBe(1)
      return id
    }

    beforeAll(async () => {
      await grant(REQUESTER, ["kernel:approvals:write"])
      await grant(LACKER, LACKER_SCOPES)
    })
    afterAll(async () => {
      await revokeAll(LACKER)
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE org_id = ${ORG} AND user_id = ${REQUESTER} AND scope = 'kernel:approvals:write'`
    })

    it("approval_update_payload: same approval, new body, union taint, narrowed, scoped diff, no second row", async () => {
      const id = await firstDraft()
      const r = await call(
        turnFrame(REQUESTER_EFFECTIVE_SCOPE),
        "kernel__approval_update_payload",
        { requestId: id, fields: { textBody: "Votre colis de remplacement part aujourd'hui." } },
        editor,
      )
      expect({ refused: refused(r), r }).toEqual({ refused: false, r })
      expect(r.blocked).toBeUndefined()
      const all = await rows()
      expect(all).toHaveLength(1)
      const [row] = all
      expect(row?.id).toBe(id)
      expect(row?.current_payload.textBody).toBe("Votre colis de remplacement part aujourd'hui.")
      expect(row?.proposing_turn_scopes).toContain("kernel:agent:memory:read")
      expect(row?.metadata.taintAudienceMustHold).toContain("kernel:agent:memory:read")
      expect(row?.metadata.taintAudienceMustHold).toContain("tickets:tickets:read")
      expect(row?.notify_user_ids).not.toContain(LACKER)
      expect(row?.summary.lines.at(-1)).toContain("some people who can read this ticket cannot see")
      // The diff quotes both bodies: it is stamped with the union, never unscoped.
      const [diff] = (await sql`SELECT required_scopes FROM kernel.messages
        WHERE thread_id = ${row?.thread_id ?? ""} AND metadata->>'type' = 'payload-edit'
        ORDER BY created_at DESC LIMIT 1`) as unknown as Array<{ required_scopes: string[] }>
      expect(diff?.required_scopes).toContain("kernel:agent:memory:read")
      // The ticket reader lacking the new taint no longer sees the pending row.
      expect(await seenBy(LACKER, LACKER_SCOPES, id)).toBe(0)
      expect(ran).toEqual([])
    })

    it("tickets:reply by the same requester restages its pending draft in place, narrowed", async () => {
      ran.length = 0
      const id = await firstDraft()
      const r = await call(turnFrame(REQUESTER_EFFECTIVE_SCOPE), "tickets__reply", {
        ticketId: TICKET,
        textBody: "Un nouveau colis part aujourd'hui.",
      })
      expect({ refused: refused(r), r }).toEqual({ refused: false, r })
      expect(r.approvalRequestId).toBe(id)
      const all = await rows()
      expect(all).toHaveLength(1)
      expect(all[0]?.current_payload.textBody).toBe("Un nouveau colis part aujourd'hui.")
      expect(all[0]?.metadata.taintAudienceMustHold).toContain("kernel:agent:memory:read")
      expect(await seenBy(LACKER, LACKER_SCOPES, id)).toBe(0)
      expect(ran).toEqual([])
    })

    it("refused when nobody who may decide the row holds the union; the row is unchanged", async () => {
      const id = await firstDraft()
      // The only other approver lacks the new taint, and the requester can no longer approve.
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE org_id = ${ORG} AND user_id = ${REQUESTER} AND scope = 'tickets:approve'`
      try {
        const r = await call(
          turnFrame(REQUESTER_EFFECTIVE_SCOPE),
          "kernel__approval_update_payload",
          { requestId: id, fields: { textBody: "Autre texte." } },
          editor,
        )
        expect(refused(r)).toBe(true)
        expect(JSON.stringify(r)).toContain("nobody holding tickets:approve")
        const all = await rows()
        expect(all).toHaveLength(1)
        expect(all[0]?.current_payload.textBody).toBe("Nous regardons votre commande.")
        expect(all[0]?.metadata.taintAudienceMustHold).toEqual(["tickets:tickets:read"])
        expect(await seenBy(LACKER, LACKER_SCOPES, id)).toBe(1)
      } finally {
        await grant(REQUESTER, ["tickets:approve"])
      }
    })
  })
})

describe("scope taint: a call back to the MCP server the turn's taint came from (rule 6g)", () => {
  const MCP_ORG = "00000000-0000-4000-8000-0000000e7c01"
  const MCP_USER = "00000000-0000-4000-8000-0000000e7c02"
  const MCP_THREAD = "00000000-0000-4000-8000-0000000e7c03"
  const MCP_ROLE = "00000000-0000-4000-8000-0000000e7c04"
  const NOTION_SEARCH = "mcp:notion:notion_search"
  const mcpActor: UserContext = {
    actorType: "user",
    userId: MCP_USER,
    orgId: MCP_ORG,
    scopes: ["*"],
    dimensionGrants: {},
  }
  const mcpRan: string[] = []

  /** A tool as the projector plants it (modules/mcp-client/projector.ts); only the handler is a probe. */
  function plantMcpTool(
    slug: string,
    tool: string,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean },
  ) {
    toolRegistry.set([MCP_ORG, "mcp", `${slug}:${tool}`], {
      appName: "mcp",
      name: `${slug}:${tool}`,
      description: `${tool} on ${slug}`,
      requiredScopes: [`mcp:${slug}:${tool}`],
      gated: false,
      deferLoading: true,
      agentVisible: true,
      gatewayHidden: false,
      ownerUserId: null,
      mcpServerToolName: tool,
      mcpAnnotations: annotations,
      taintSource: true,
      externalEffect: true,
      params: z.object({ id: z.string() }).passthrough(),
      handler: async () => {
        mcpRan.push(`mcp:${slug}:${tool}`)
        return { page: "Studio price: 1490 EUR" }
      },
    } as never)
  }

  type McpCallOutcome = {
    data?: unknown
    blocked?: { reason?: string }
    error?: { code?: string }
  }

  /** One dispatch on a turn that read `taint` (recorded as the tool bridge would). */
  async function callMcp(toolName: string, taint: readonly string[]): Promise<McpCallOutcome> {
    const runId = crypto.randomUUID()
    const turnScopeAccumulator = createTurnScopeAccumulator({ orgId: MCP_ORG })
    turnScopeAccumulator.recordInjected([...taint])
    const frame: RunContext = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      humanTurn: true,
      turnScopeAccumulator,
    }
    try {
      const r = await runContextStore.run(frame, () =>
        executeTool({
          toolName,
          orgId: MCP_ORG,
          actor: mcpActor,
          params: { id: "page-7f3a" },
          threadId: MCP_THREAD,
          origin: "in-app-agent",
        }),
      )
      return r.blocked ? { data: r.data, blocked: { reason: r.blocked.reason } } : { data: r.data }
    } catch (err) {
      // executeTool throws an error envelope; a refusal is an answer here, not a failure.
      return { error: { code: (err as { code?: string }).code } }
    }
  }

  /** Judged by the scope taint: parked for a person or refused, never run inline. */
  function judgedByTaint(r: McpCallOutcome, toolName: string): boolean {
    if (mcpRan.includes(toolName)) return false
    return r.blocked !== undefined || r.error?.code === "E_SCOPE_TAINT_BLOCKED"
  }

  async function approvalRows() {
    return (await sql`SELECT tool_name, reason, metadata FROM kernel.approval_requests
      WHERE org_id = ${MCP_ORG}`) as Array<{
      tool_name: string
      reason: string
      metadata: { taintAudienceMustHold?: string[] }
    }>
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${MCP_ORG}, 'Taint MCP Same Origin Org', 'taint-mcp-same-origin-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${MCP_USER}, ${MCP_ORG}, 'taint-mcp-owner@test.com', 'Owner', 'active', 'x')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${MCP_ROLE}, ${MCP_ORG}, 'taint-mcp-owner', 'all scopes') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${MCP_ROLE}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${MCP_USER}, ${MCP_ROLE}, ${MCP_ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${MCP_THREAD}, ${MCP_ORG}, 'taint-mcp-dm', 'agent_chat', ${MCP_USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${MCP_THREAD}, ${MCP_USER}, ${MCP_ORG}) ON CONFLICT DO NOTHING`
    const read = { readOnlyHint: true }
    plantMcpTool("notion", "notion_search", read)
    plantMcpTool("notion", "notion_fetch", read)
    // A write the admin let run without approval ("Allow everything").
    plantMcpTool("notion", "notion_update_page", { readOnlyHint: false })
    plantMcpTool("linear", "linear_get_issue", read)
  })

  // A projected tool is a taintSource: a call that runs marks the thread as having read outside
  // text, and that mark (a separate hold, scopes/taint.ts) is not what these cases judge.
  beforeEach(async () => {
    await sql`UPDATE kernel.threads SET tainted = false, tainted_sources = NULL
      WHERE id = ${MCP_THREAD}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([MCP_ORG])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
  })

  it("(a) search then fetch on the same server, with only that server's taint: the fetch runs, no approval", async () => {
    mcpRan.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
    const r = await callMcp("mcp:notion:notion_fetch", [NOTION_SEARCH])
    expect({ ran: mcpRan, r }).toEqual({ ran: ["mcp:notion:notion_fetch"], r })
    expect(r.blocked).toBeUndefined()
    expect(await approvalRows()).toEqual([])
  })

  it("(b) the turn also read a knowledge doc or a ticket: the fetch is still judged", async () => {
    for (const other of ["knowledge:documents:read", "tickets:tickets:read"]) {
      mcpRan.length = 0
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
      const r = await callMcp("mcp:notion:notion_fetch", [NOTION_SEARCH, other])
      expect({ other, judged: judgedByTaint(r, "mcp:notion:notion_fetch"), r }).toEqual({
        other,
        judged: true,
        r,
      })
      const [row] = await approvalRows()
      expect(row?.metadata.taintAudienceMustHold).toContain(other)
    }
  })

  it("(c) taint from server A, call to server B: still judged", async () => {
    mcpRan.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
    const r = await callMcp("mcp:linear:linear_get_issue", [NOTION_SEARCH])
    expect(judgedByTaint(r, "mcp:linear:linear_get_issue")).toBe(true)
  })

  it("(d) an unknown taint: still judged", async () => {
    mcpRan.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
    const r = await callMcp("mcp:notion:notion_fetch", ["scope_taint:unknown"])
    expect(judgedByTaint(r, "mcp:notion:notion_fetch")).toBe(true)
  })

  /** Parked by the outside-content hold alone: reason taint_escalation, no scope-taint audience. */
  async function parkedByOutsideTextHold(r: McpCallOutcome, toolName: string) {
    expect(mcpRan).not.toContain(toolName)
    expect(r.blocked?.reason).toBe("taint_escalation")
    const [row] = await approvalRows()
    expect(row?.reason).toBe("taint_escalation")
    expect(row?.metadata.taintAudienceMustHold).toBeUndefined()
  }

  async function freshTurn() {
    mcpRan.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
  }

  it("the live shape: a search on the server, then a fetch of its result, both run with no approval (rules 6g, 6h)", async () => {
    await freshTurn()
    const search = await callMcp("mcp:notion:notion_search", [])
    expect(search.blocked).toBeUndefined()
    // The search's result marked the thread, naming the server it came from.
    const [thread] = (await sql`SELECT tainted, tainted_sources FROM kernel.threads
      WHERE id = ${MCP_THREAD}`) as Array<{ tainted: boolean; tainted_sources: string[] | null }>
    expect(thread).toEqual({ tainted: true, tainted_sources: ["mcp:notion"] })
    const r = await callMcp("mcp:notion:notion_fetch", [NOTION_SEARCH])
    expect({ ran: mcpRan, r }).toEqual({
      ran: ["mcp:notion:notion_search", "mcp:notion:notion_fetch"],
      r,
    })
    expect(r.blocked).toBeUndefined()
    expect(await approvalRows()).toEqual([])
  })

  it("hold: a write on the same server still parks, even when the admin allowed it", async () => {
    await freshTurn()
    await callMcp("mcp:notion:notion_search", [])
    const r = await callMcp("mcp:notion:notion_update_page", [])
    await parkedByOutsideTextHold(r, "mcp:notion:notion_update_page")
  })

  it("hold: the thread also read web, mail or knowledge text (an unnamed source): the read parks", async () => {
    await freshTurn()
    await callMcp("mcp:notion:notion_search", [])
    // How web_fetch, a mail read or a knowledge read marks the thread: no server named.
    await setTaintFlag(MCP_THREAD, MCP_ORG)
    const r = await callMcp("mcp:notion:notion_fetch", [])
    await parkedByOutsideTextHold(r, "mcp:notion:notion_fetch")
  })

  it("hold: outside text from server A, a read on server B parks", async () => {
    await freshTurn()
    await callMcp("mcp:notion:notion_search", [])
    const r = await callMcp("mcp:linear:linear_get_issue", [])
    await parkedByOutsideTextHold(r, "mcp:linear:linear_get_issue")
  })

  it("hold: outside text from servers A and B, a read on A parks", async () => {
    await freshTurn()
    await callMcp("mcp:notion:notion_search", [])
    await callMcp("mcp:linear:linear_get_issue", [])
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
    await setTaintFlag(MCP_THREAD, MCP_ORG, { source: "mcp:linear" })
    const [thread] = (await sql`SELECT tainted_sources FROM kernel.threads
      WHERE id = ${MCP_THREAD}`) as Array<{ tainted_sources: string[] | null }>
    expect(thread?.tainted_sources).toEqual(["mcp:notion", "mcp:linear"])
    const r = await callMcp("mcp:notion:notion_fetch", [])
    await parkedByOutsideTextHold(r, "mcp:notion:notion_fetch")
  })

  it("hold: a legacy thread marked before its sources were recorded (unknown source): the read parks", async () => {
    await freshTurn()
    await sql`UPDATE kernel.threads SET tainted = true, tainted_sources = NULL WHERE id = ${MCP_THREAD}`
    const r = await callMcp("mcp:notion:notion_fetch", [])
    await parkedByOutsideTextHold(r, "mcp:notion:notion_fetch")
  })

  it("after an approved result (#212) the stamp stays the server's own: a later call to it runs, another server's is judged", async () => {
    const stamp = approvalResultRequiredScopes({
      orgId: MCP_ORG,
      toolName: "mcp:notion:notion_fetch",
      proposingTurnScopes: [NOTION_SEARCH],
      requesterScopes: ["*"],
    })
    expect(stamp).toEqual([NOTION_SEARCH, "mcp:notion:notion_fetch"].sort())
    mcpRan.length = 0
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${MCP_ORG}`
    const same = await callMcp("mcp:notion:notion_fetch", stamp)
    expect({ ran: mcpRan, same }).toEqual({ ran: ["mcp:notion:notion_fetch"], same })
    expect(await approvalRows()).toEqual([])
    const other = await callMcp("mcp:linear:linear_get_issue", stamp)
    expect(judgedByTaint(other, "mcp:linear:linear_get_issue")).toBe(true)
  })
})
