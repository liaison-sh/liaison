// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint, rule 6l (modules/agent/scopes/scope-taint.ts): a first-party app's write back into
// itself, on a turn whose every taint is a read scope of that app, is not judged. A walk with the
// real agent (2026-11-28) found every agent calendar create/update parked for approval because the
// agent's own list_calendars/list_events read tainted the turn, and the card said approving
// "shares" data that went straight back into the calendar it came from.
//
// Both sides, through the real dispatch and the calendar's real registered declarations (only the
// handlers are probes):
//   - calendar read -> calendar create/update that emails nobody: runs inline, no approval;
//   - any other scope in the taint (mail), an unknown taint, or a call that emails the guests
//     (sendUpdates "all"): judged exactly as before, so it parks for a person.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { returnsToOwnApp, UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedOrgRow, seedUserRows, seedUserScopeGrantRow } from "~/seed/factories/org/rows"
import { agentDm } from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000e7d01"
const REQUESTER = "00000000-0000-4000-8000-0000000e7d02"
/** Reads and writes the calendar, but no mail: a reader the mail taint must not reach. */
const COLLEAGUE = "00000000-0000-4000-8000-0000000e7d03"
/** The requester's DM with their agent, where the calls are made. */
let thread = ""
const CALENDAR_ID = "00000000-0000-4000-8000-0000000e7d05"

const CALENDAR_READ = "calendar:events:read"
const MAIL_READ = "mail:conversations:read"

const actor: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: ["calendar:events:read", "calendar:events:write", MAIL_READ],
  dimensionGrants: {},
}

const ran: string[] = []

type Outcome = { ran: boolean; blocked: boolean; refused: boolean }

async function callOnTurn(
  tool: "create_event" | "update_event",
  taint: readonly string[],
  params: Record<string, unknown>,
): Promise<Outcome> {
  ran.length = 0
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId: ORG })
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
        toolName: `calendar:${tool}`,
        orgId: ORG,
        actor,
        params,
        threadId: thread,
        origin: "in-app-agent",
      }),
    )
    return { ran: ran.includes(tool), blocked: r.blocked !== undefined, refused: false }
  } catch (err) {
    const code = (err as { code?: string }).code
    return { ran: ran.includes(tool), blocked: false, refused: code === "E_SCOPE_TAINT_BLOCKED" }
  }
}

/** Whether the one parked card says approving shares the turn's data (rule 8e's line). */
async function cardSaysItShares(): Promise<boolean> {
  const rows = (await sql`SELECT metadata FROM kernel.approval_requests
    WHERE org_id = ${ORG}`) as Array<{ metadata: { taintDisclosedToReaders?: boolean } | null }>
  expect(rows).toHaveLength(1)
  return rows[0]?.metadata?.taintDisclosedToReaders === true
}

async function approvalCount(): Promise<number> {
  const rows = (await sql`SELECT count(*)::int AS n FROM kernel.approval_requests
    WHERE org_id = ${ORG}`) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

const createParams = {
  calendarId: CALENDAR_ID,
  title: "Roadmap review",
  start: "2026-12-01T15:00:00Z",
  end: "2026-12-01T16:00:00Z",
  // A teammate: a known guest, so no unknown-guest gate (host-approval-gates.ts) parks the call.
  attendees: ["taint-own-app-colleague@test.com"],
}

describe("scope taint: a first-party app's write back into itself (rule 6l)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await seedOrgRow(
      { id: ORG, name: "Taint Own App Org", slug: "taint-own-app-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [
        [REQUESTER, "taint-own-app-requester@test.com"],
        [COLLEAGUE, "taint-own-app-colleague@test.com"],
      ].map(([id, email]) => ({
        id,
        orgId: ORG,
        email,
        name: email,
        status: "active",
        passwordHash: "x",
      })),
      { onConflict: "skip" },
    )
    for (const scope of actor.scopes) {
      await seedUserScopeGrantRow({ userId: REQUESTER, orgId: ORG, scope })
    }
    for (const scope of ["calendar:events:read", "calendar:events:write"]) {
      await seedUserScopeGrantRow({ userId: COLLEAGUE, orgId: ORG, scope })
    }
    thread = await agentDm(ORG, REQUESTER)

    await ensureAppsForOrg(ORG)
    for (const tool of ["create_event", "update_event"] as const) {
      const entry = toolRegistry.get([ORG, "calendar", tool])
      if (!entry) throw new Error(`calendar:${tool} is not registered`)
      // The registered declaration comes from the calendar's real manifest.
      expect(entry.taintReturnsToOwnApp?.outwardWhen?.sendUpdates).toContain("all")
      toolRegistry.set([ORG, "calendar", tool], {
        ...entry,
        preflight: undefined,
        handler: async () => {
          ran.push(tool)
          return { eventId: "probe" }
        },
      } as never)
    }
  }, 180_000)

  beforeEach(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`UPDATE kernel.threads SET tainted = false, tainted_sources = NULL WHERE id = ${thread}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("calendar read, then create_event with guests and no email: runs inline, no approval", async () => {
    const r = await callOnTurn("create_event", [CALENDAR_READ], createParams)
    expect(r).toEqual({ ran: true, blocked: false, refused: false })
    expect(await approvalCount()).toBe(0)
  })

  it("calendar read, then update_event with sendUpdates none: runs inline, no approval", async () => {
    const r = await callOnTurn("update_event", [CALENDAR_READ], {
      eventId: "00000000-0000-4000-8000-0000000e7d06",
      start: "2026-12-01T16:00:00Z",
      end: "2026-12-01T17:00:00Z",
      sendUpdates: "none",
    })
    expect(r).toEqual({ ran: true, blocked: false, refused: false })
    expect(await approvalCount()).toBe(0)
  })

  it("mail read too, then a create with guests and a description: still parks", async () => {
    const r = await callOnTurn("create_event", [CALENDAR_READ, MAIL_READ], {
      ...createParams,
      description: "Follow-up on the quote thread: 1490 EUR studio price",
    })
    expect(r.ran).toBe(false)
    expect(r.blocked || r.refused).toBe(true)
    if (r.blocked) expect(await cardSaysItShares()).toBe(true)
  })

  it("mail read alone, then a create: still parks", async () => {
    const r = await callOnTurn("create_event", [MAIL_READ], createParams)
    expect(r.ran).toBe(false)
    expect(r.blocked || r.refused).toBe(true)
  })

  it("calendar read, then a create that emails the guests (sendUpdates all): judged, parks", async () => {
    const r = await callOnTurn("create_event", [CALENDAR_READ], {
      ...createParams,
      sendUpdates: "all",
    })
    expect(r.ran).toBe(false)
    expect(r.blocked || r.refused).toBe(true)
    // The guests are on the card; the calendar's own data shares nothing with its readers.
    expect(r.blocked).toBe(true)
    expect(await cardSaysItShares()).toBe(false)
  })

  it("an unknown taint: judged, parks", async () => {
    const r = await callOnTurn("create_event", [...UNKNOWN_TURN_TAINT], createParams)
    expect(r.ran).toBe(false)
    expect(r.blocked || r.refused).toBe(true)
  })
})

describe("returnsToOwnApp (rule 6l), the predicate", () => {
  const decl = { taintReturnsToOwnApp: { outwardWhen: { sendUpdates: ["all", "externalOnly"] } } }

  it("only the app's own read scopes, nothing outward: not judged", () => {
    expect(returnsToOwnApp("calendar", decl, ["calendar:events:read"], {})).toBe(true)
    expect(
      returnsToOwnApp("calendar", decl, ["calendar:events:read"], { sendUpdates: "none" }),
    ).toBe(true)
    expect(returnsToOwnApp("calendar", decl, ["calendar:events:read"], undefined)).toBe(true)
  })

  it("fails closed on everything else", () => {
    const own = ["calendar:events:read"]
    // No declaration.
    expect(returnsToOwnApp("calendar", {}, own, {})).toBe(false)
    // Another app's, the kernel's, a non-read, a wildcard, the unknown sentinel, an empty taint.
    expect(returnsToOwnApp("calendar", decl, [...own, "mail:conversations:read"], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, [...own, "kernel:threads:read"], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, ["calendar:admin"], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, ["calendar:*:read"], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, ["calendar:*"], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, [...UNKNOWN_TURN_TAINT], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, [], {})).toBe(false)
    expect(returnsToOwnApp("calendar", decl, "calendar:events:read", {})).toBe(false)
    // A look-alike namespace.
    expect(returnsToOwnApp("calendar", decl, ["calendar-x:events:read"], {})).toBe(false)
    expect(returnsToOwnApp("cal", decl, own, {})).toBe(false)
    // Outward for this call, or unreadable arguments.
    expect(returnsToOwnApp("calendar", decl, own, { sendUpdates: "all" })).toBe(false)
    expect(returnsToOwnApp("calendar", decl, own, { sendUpdates: "externalOnly" })).toBe(false)
    expect(returnsToOwnApp("calendar", decl, own, null)).toBe(false)
    expect(returnsToOwnApp("calendar", decl, own, "x")).toBe(false)
  })
})
