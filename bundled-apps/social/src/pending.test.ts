// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Awaiting approval" is derived at read time from the live approvals
// (pending.ts): a finding a pending reply/like targets reads awaiting_approval
// with the draft and the approval id, and its stored status once the request is
// no longer pending. findings_list / findings_get / counts / attention all read
// through it.

import { describe, expect, test } from "bun:test"
import { computeSocialAttention } from "./attention"
import type { SocialToolCtx } from "./ctx"
import { deriveFindingApprovalState, pendingFindingApprovals } from "./pending"
import { countsRead, findingsGet, findingsList } from "./reads"
import { createMockDb, type MockDb } from "./test-db"

interface FakeApproval {
  id: string
  tool_name: string
  payload: Record<string, unknown>
  created_at: string
}

/** A ctx whose `approvals.pendingFor` answers from `live` the way the kernel does:
 *  this app's tools only, payload carrying the key, newest first. */
function makeCtx(db: MockDb, live: FakeApproval[] | null): SocialToolCtx & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, body: "{}" })) as never,
    connections: {},
    config: { get: async () => null },
    calls,
    ...(live
      ? {
          approvals: {
            pendingFor: async (key: string, toolNames?: string[]) => {
              calls.push([key, toolNames])
              return JSON.stringify(
                live
                  .filter(
                    (a) =>
                      a.tool_name.startsWith("social:") &&
                      (!toolNames || toolNames.includes(a.tool_name)),
                  )
                  .filter((a) => typeof a.payload[key] === "string")
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((a) => ({
                    id: a.id,
                    tool_name: a.tool_name,
                    target_id: a.payload[key],
                    payload: a.payload,
                    created_at: a.created_at,
                  })),
              )
            },
          },
        }
      : {}),
  } as SocialToolCtx & { calls: unknown[][] }
}

const reply = (
  id: string,
  findingId: string,
  text: string,
  at = "2026-10-01T10:00:00.000Z",
): FakeApproval => ({
  id,
  tool_name: "social:reply_to_finding",
  payload: { finding_id: findingId, reply_text: text },
  created_at: at,
})
const like = (id: string, findingId: string, at = "2026-10-01T10:00:00.000Z"): FakeApproval => ({
  id,
  tool_name: "social:like_item",
  payload: { finding_id: findingId },
  created_at: at,
})

async function seed(db: MockDb) {
  const base = { platform: "facebook", relation: "comment_on_our_content" }
  await db.insert("finding", {
    id: "f1",
    external_id: "e1",
    status: "new",
    occurred_at: "2026-10-01T08:00:00.000Z",
    ...base,
  })
  await db.insert("finding", {
    id: "f2",
    external_id: "e2",
    status: "triaged",
    occurred_at: "2026-10-01T07:00:00.000Z",
    should_reply: true,
    ...base,
  })
  await db.insert("finding", {
    id: "f3",
    external_id: "e3",
    status: "handled",
    occurred_at: "2026-10-01T06:00:00.000Z",
    ...base,
  })
  // Stored awaiting by an earlier handler version, its request long gone.
  await db.insert("finding", {
    id: "f4",
    external_id: "e4",
    status: "awaiting_approval",
    approval_request_id: "dead",
    occurred_at: "2026-10-01T05:00:00.000Z",
    ...base,
  })
}

describe("deriveFindingApprovalState", () => {
  const pending = {
    approval_id: "a1",
    action: "reply" as const,
    draft: "Thanks!",
    created_at: null,
  }

  test("a pending approval reads as awaiting_approval with the draft and the approval id", () => {
    expect(
      deriveFindingApprovalState<Record<string, unknown>>(
        { id: "f1", status: "new", suggested_reply: null },
        pending,
      ),
    ).toEqual({
      id: "f1",
      status: "awaiting_approval",
      suggested_reply: "Thanks!",
      approval_request_id: "a1",
      pending_action: "reply",
    })
  })

  test("a pending like keeps the stored suggestion as the draft", () => {
    const d = deriveFindingApprovalState(
      { id: "f1", status: "triaged", suggested_reply: "triage idea" },
      { approval_id: "a2", action: "like", draft: null, created_at: null },
    )
    expect(d).toMatchObject({
      status: "awaiting_approval",
      suggested_reply: "triage idea",
      approval_request_id: "a2",
      pending_action: "like",
    })
  })

  test("no pending approval: the stored status, unchanged", () => {
    const row = { id: "f1", status: "triaged" }
    expect(deriveFindingApprovalState(row, undefined)).toBe(row)
  })

  test("a handled or dismissed finding keeps its status even with a pending approval", () => {
    expect(deriveFindingApprovalState({ id: "f3", status: "handled" }, pending).status).toBe(
      "handled",
    )
    expect(deriveFindingApprovalState({ id: "f3", status: "dismissed" }, pending).status).toBe(
      "dismissed",
    )
  })

  test("a stale stored awaiting_approval falls back to new and drops its dead approval id", () => {
    expect(
      deriveFindingApprovalState<Record<string, unknown>>(
        { id: "f4", status: "awaiting_approval", approval_request_id: "dead" },
        undefined,
      ),
    ).toEqual({
      id: "f4",
      status: "new",
      approval_request_id: null,
    })
  })
})

describe("pendingFindingApprovals", () => {
  test("asks for this app's finding tools by finding_id; a reply wins over a like, newest reply first", async () => {
    const ctx = makeCtx(createMockDb(), [
      like("l1", "f1", "2026-10-01T12:00:00.000Z"),
      reply("r-old", "f1", "old draft", "2026-10-01T09:00:00.000Z"),
      reply("r-new", "f1", "new draft", "2026-10-01T11:00:00.000Z"),
      like("l2", "f2"),
      {
        id: "dm",
        tool_name: "social:send_dm",
        payload: { conversation_id: "c1", body: "x" },
        created_at: "2026-10-01T10:00:00.000Z",
      },
    ])
    const index = await pendingFindingApprovals(ctx)
    expect(ctx.calls).toEqual([["finding_id", ["social:reply_to_finding", "social:like_item"]]])
    expect(index?.get("f1")).toEqual({
      approval_id: "r-new",
      action: "reply",
      draft: "new draft",
      created_at: "2026-10-01T11:00:00.000Z",
    })
    expect(index?.get("f2")).toMatchObject({ approval_id: "l2", action: "like", draft: null })
    expect(index?.size).toBe(2)
  })

  test("a host without approvals.pendingFor: null (the live state is unknown)", async () => {
    expect(await pendingFindingApprovals(makeCtx(createMockDb(), null))).toBeNull()
  })
})

describe("reads derive the status from the live approvals", () => {
  test("findings_get reads awaiting with the draft while pending, its stored status once it is not", async () => {
    const db = createMockDb()
    await seed(db)
    const live = [reply("a1", "f1", "Thanks for the kind words")]
    const during = (await findingsGet({ finding_id: "f1" }, makeCtx(db, live))).finding
    expect(during).toMatchObject({
      status: "awaiting_approval",
      suggested_reply: "Thanks for the kind words",
      approval_request_id: "a1",
    })
    // Denied / expired / cancelled: the kernel no longer lists it as pending.
    const after = (await findingsGet({ finding_id: "f1" }, makeCtx(db, []))).finding as {
      status: string
    }
    expect(after.status).toBe("new")
    // Nothing was ever written on the stored row.
    expect(((await db.findOne("finding", "f1")) as { status: string }).status).toBe("new")
  })

  test("findings_list overlays every row; the status filter and the count use the derived status", async () => {
    const db = createMockDb()
    await seed(db)
    const ctx = makeCtx(db, [reply("a1", "f1", "hi"), like("a2", "f3")])
    const all = await findingsList({}, ctx)
    const byId = Object.fromEntries(
      (all.findings as Array<{ id: string; status: string }>).map((f) => [f.id, f.status]),
    )
    expect(byId).toEqual({ f1: "awaiting_approval", f2: "triaged", f3: "handled", f4: "new" })
    expect(all.totalCount).toBe(4)

    const awaiting = await findingsList({ status: "awaiting_approval" }, ctx)
    expect((awaiting.findings as Array<{ id: string }>).map((f) => f.id)).toEqual(["f1"])
    expect(awaiting.totalCount).toBe(1)

    // f1 left `new` while its reply is pending; the stale f4 joined it.
    const fresh = await findingsList({ status: "new" }, ctx)
    expect((fresh.findings as Array<{ id: string }>).map((f) => f.id)).toEqual(["f4"])
    expect(fresh.totalCount).toBe(1)
  })

  test("counts follow the derived status", async () => {
    const db = createMockDb()
    await seed(db)
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG1",
      status: "open",
    })
    expect(await countsRead({}, makeCtx(db, [reply("a1", "f1", "hi")]))).toMatchObject({
      findings_new: 1, // f1 is awaiting; stale f4 reads new
      awaiting_approval: 1,
      open_dms: 1,
    })
    // The same counts as rows, the list a dashboard block charts.
    expect(await countsRead({}, makeCtx(db, []))).toEqual({
      findings_new: 2,
      awaiting_approval: 0,
      open_dms: 1,
      rows: [
        { key: "findings_new", value: 2 },
        { key: "awaiting_approval", value: 0 },
        { key: "open_dms", value: 1 },
      ],
    })
  })

  test("attention: a pending reply is an approval item routed to its decision; a gone one is not", async () => {
    const db = createMockDb()
    await seed(db)
    const items = await computeSocialAttention(
      makeCtx(db, [reply("a9", "f2", "hi")]),
      "org-1",
      "u1",
    )
    const approval = items.filter((i) => i.kind === "approval_pending")
    expect(approval.map((i) => [i.entityId, i.action])).toEqual([
      ["f2", { type: "decide_approval", approvalId: "a9" }],
    ])
    // f2's reply is already staged: no separate "needs a reply" item for it.
    expect(items.some((i) => i.kind === "mention" && i.entityId === "f2")).toBe(false)

    const none = await computeSocialAttention(makeCtx(db, []), "org-1", "u1")
    expect(none.filter((i) => i.kind === "approval_pending")).toEqual([])
    expect(none.some((i) => i.kind === "mention" && i.entityId === "f2")).toBe(true)
  })
})
