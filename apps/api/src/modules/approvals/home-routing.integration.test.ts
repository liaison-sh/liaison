// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO A PENDING APPROVAL IS FOR, AS HOME AND THE BADGE READ IT.
//
// Routing sorts the audience the feed already has; it never widens it. The first block pins
// that a world with no route input changes nothing: the feed and the badge equal, row for row,
// a snapshot taken before routing existed (`home-routing.snapshot.json`). Only the keys routing
// adds to an item's metadata are left out of the comparison.
//
// Write the snapshot again (only on purpose): HOME_ROUTING_SNAPSHOT_WRITE=1.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { type AttentionItem, countBadge } from "@liaison/shared"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import {
  computeApprovalAttentionItems,
  computeApprovalBadgeItems,
} from "~/modules/approvals/attention"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { updateItemRoutePerson } from "~/modules/approvals/route-world"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SNAPSHOT_PATH = new URL("./home-routing.snapshot.json", import.meta.url).pathname
/** The keys routing adds to a feed item's metadata, left out of the before/after comparison. */
const ROUTING_KEYS = new Set(["route", "placement", "routeLine"])

let ORG = ""
let THREAD = ""
const people: Record<string, string> = {}
const rows: Record<string, string> = {}

async function ctxOf(userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ORG, "home-routing-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, ORG),
  )
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

interface RowSpec {
  tool?: string
  requestedBy: string
  notify: string[]
  status?: "pending" | "approving"
  metadata?: Record<string, unknown>
  resourceOwner?: string | null
  bundleId?: string | null
  bundlePosition?: number | null
  title: string
  routePersonId?: string | null
  links?: unknown[]
}

export async function insertRow(spec: RowSpec): Promise<string> {
  const id = randomUUID()
  const wedged = spec.status === "approving"
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, summary, metadata,
      resource_owner_id, bundle_id, bundle_position, approving_started_at, route_person_id
    ) VALUES (
      ${id}::uuid, ${ORG}::uuid, ${`APR-${id.slice(0, 8)}`}, ${THREAD}::uuid, ${THREAD}::uuid,
      ${spec.tool ?? "projects:createTask"}, '{}'::jsonb,
      ${JSON.stringify({ title: spec.title })}::jsonb, now() + INTERVAL '3 days',
      ${spec.notify}::uuid[], ${spec.requestedBy}::uuid, ${spec.status ?? "pending"},
      ${JSON.stringify({ title: spec.title, ...(spec.links ? { links: spec.links } : {}) })}::jsonb,
      ${JSON.stringify(spec.metadata ?? {})}::jsonb,
      ${spec.resourceOwner ?? null}, ${spec.bundleId === "self" ? id : (spec.bundleId ?? null)},
      ${spec.bundlePosition ?? null},
      ${wedged ? sql`now() - INTERVAL '2 hours'` : null},
      ${spec.routePersonId ?? null}
    )`
  return id
}

/** Ids and clock-bound values replaced by names, so a run compares to another run. */
function normalise(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") {
    let out = value
    for (const [id, name] of names) out = out.split(id).join(`<${name}>`)
    return out.replace(/APR-[0-9a-f]{8}/g, "<handle>")
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, names))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (["occurredAt", "expiresAt", "expiresInSeconds"].includes(k)) continue
      if (ROUTING_KEYS.has(k)) continue
      out[k] = normalise(v, names)
    }
    return out
  }
  return value
}

function nameMap(): Map<string, string> {
  const names = new Map<string, string>()
  for (const [k, v] of Object.entries(people)) names.set(v, k)
  for (const [k, v] of Object.entries(rows)) names.set(v, `row:${k}`)
  names.set(THREAD, "thread")
  names.set(ORG, "org")
  return names
}

async function feedOf(userId: string): Promise<AttentionItem[]> {
  const ctx = await ctxOf(userId)
  const items = await withRlsContext(ctx, (tx) => computeApprovalAttentionItems(tx, ORG, userId))
  return items.sort((a, b) => a.entityId.localeCompare(b.entityId))
}

async function badgeOf(userId: string) {
  const ctx = await ctxOf(userId)
  const items = await withRlsContext(ctx, (tx) => computeApprovalBadgeItems(tx, ORG, userId, 200))
  return items.sort((a, b) => a.entityId.localeCompare(b.entityId))
}

async function readWorld() {
  const names = nameMap()
  const out: Record<string, unknown> = {}
  for (const viewer of ["ines", "tom", "sara", "owner"]) {
    const userId = people[viewer] as string
    const feed = await feedOf(userId)
    const badge = await badgeOf(userId)
    const viewerFacts = { userId, canGrantAccess: false }
    out[viewer] = normalise(
      {
        feed: [...feed].sort((a, b) =>
          (names.get(a.entityId) ?? "").localeCompare(names.get(b.entityId) ?? ""),
        ),
        badgeItems: [...badge].sort((a, b) =>
          (names.get(a.entityId) ?? "").localeCompare(names.get(b.entityId) ?? ""),
        ),
        feedCount: countBadge({ threads: [], items: feed, viewer: viewerFacts }),
        badgeCount: countBadge({ threads: [], items: badge, viewer: viewerFacts }),
      },
      names,
    )
  }
  return out
}

describe("home routing: who a pending approval is for", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    for (const name of ["ines", "tom", "sara", "owner", "lea"]) {
      people[name] = (await minimal.person(ORG, { name: `Fixture ${name}` })).id
    }
    for (const name of ["ines", "tom", "sara", "owner"]) {
      await minimal.grantScope(people[name] as string, "projects:approve")
    }
    THREAD = await minimal.thread(ORG, people.ines as string, { title: "Routing fixtures" })
    const deciders = [people.ines, people.tom, people.sara] as string[]
    // Tom raised it and could approve it himself: noise for the others.
    rows.peer = await insertRow({
      requestedBy: people.tom as string,
      notify: deciders,
      title: "Peer row",
    })
    rows.routine = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders,
      metadata: { originRoutineId: randomUUID() },
      title: "Routine row",
    })
    rows.twoApprovers = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      metadata: { minApprovers: 2, approvedBy: [people.tom] },
      title: "Two approver row",
    })
    rows.wedged = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders,
      status: "approving",
      metadata: { approvedBy: [people.sara] },
      title: "Wedged row",
    })
    rows.owner = await insertRow({
      requestedBy: people.owner as string,
      notify: [people.owner as string],
      resourceOwner: people.owner as string,
      title: "Owner row",
    })
    rows.bundle = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      bundleId: "self",
      bundlePosition: 0,
      title: "Bundle head",
    })
    rows.bundleStep = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      bundleId: rows.bundle,
      bundlePosition: 1,
      title: "Bundle outcome",
    })
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("with no route input, the feed and the badge equal the snapshot taken before routing, row for row", async () => {
    const world = await readWorld()
    if (process.env.HOME_ROUTING_SNAPSHOT_WRITE === "1") {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(world, null, 2)}\n`)
    }
    expect(existsSync(SNAPSHOT_PATH)).toBe(true)
    expect(world).toEqual(JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")))
  })

  /** The row as this viewer's feed has it, or null when it is not in their feed. */
  async function placed(viewer: string, rowId: string) {
    const item = (await feedOf(people[viewer] as string)).find((i) => i.entityId === rowId)
    if (!item) return null
    const meta = item.metadata as Record<string, unknown>
    return {
      placement: meta.placement,
      route: meta.route as Record<string, unknown>,
      peerSelfApprovable: meta.peerSelfApprovable,
      item,
    }
  }

  /** What this row adds to the viewer's badge, through the badge's own read. */
  async function badgeFrom(viewer: string, rowId: string): Promise<number> {
    const items = (await badgeOf(people[viewer] as string)).filter((i) => i.entityId === rowId)
    return countBadge({
      threads: [],
      items,
      viewer: { userId: people[viewer] as string, canGrantAccess: false },
    })
  }

  async function away(userId: string, nextInLineId: string | null): Promise<string> {
    const [r] = (await sql`
      INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, next_in_line_id, source)
      VALUES (${ORG}::uuid, ${userId}::uuid, current_date - 1, current_date + 2,
              ${nextInLineId}, 'said')
      RETURNING id`) as Array<{ id: string }>
    return (r as { id: string }).id
  }

  async function requestColumns(): Promise<unknown[]> {
    return [
      ...(await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY id`),
    ]
  }

  const deciders = () => [people.ines, people.tom, people.sara] as string[]
  const ticketLink = (id: string) => [
    { label: "Ticket", app: "tickets", entityType: "ticket", entityId: id },
  ]

  it("a row with a person on the item is theirs; the other deciders have it as for someone else", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "On the item",
    })
    const sara = await placed("sara", id)
    expect(sara?.placement).toBe("mine")
    expect(sara?.route).toMatchObject({ to: "person", userId: people.sara, why: "on_item" })
    for (const other of ["ines", "tom"]) {
      const p = await placed(other, id)
      expect(p?.placement).toBe("others")
      // A client that reads the peer flag alone folds it too.
      expect(p?.peerSelfApprovable).toBe(true)
    }
    expect(await badgeFrom("sara", id)).toBe(1)
    expect(await badgeFrom("ines", id)).toBe(0)
  })

  it("a request its requester could approve is theirs, asked, and for someone else in the others' feeds", async () => {
    const tom = await placed("tom", rows.peer as string)
    expect(tom?.route).toMatchObject({ to: "person", userId: people.tom, why: "asked" })
    expect(tom?.placement).toBe("mine")
    expect((await placed("ines", rows.peer as string))?.placement).toBe("others")
  })

  it("reassigning the item moves the row on the next read, and leaves other items' rows alone", async () => {
    const ticket = randomUUID()
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      links: ticketLink(ticket),
      title: "Reassigned",
    })
    const untouched = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      links: ticketLink(randomUUID()),
      title: "Other ticket",
    })
    expect(
      await updateItemRoutePerson({
        orgId: ORG,
        app: "tickets",
        entityType: "ticket",
        entityId: ticket,
        personId: people.tom as string,
      }),
    ).toBe(1)
    expect((await placed("tom", id))?.placement).toBe("mine")
    expect((await placed("sara", id))?.placement).toBe("others")
    expect((await placed("sara", untouched))?.placement).toBe("mine")
  })

  it("going away rewrites no row; the next in line stands in, counted in their badge; ending it restores every placement", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Away on the item",
    })
    const before = await requestColumns()
    const range = await away(people.sara as string, people.tom as string)
    try {
      expect(await requestColumns()).toEqual(before)
      const tom = await placed("tom", id)
      expect(tom?.placement).toBe("standing_in")
      expect(tom?.route).toMatchObject({ userId: people.sara, standIn: people.tom })
      expect(typeof tom?.route.awayUntil).toBe("string")
      expect(await badgeFrom("tom", id)).toBe(1)
      expect((await placed("ines", id))?.placement).toBe("others")
      // The person it is for can still act while away.
      expect((await placed("sara", id))?.placement).toBe("mine")
    } finally {
      await sql`UPDATE kernel.away_ranges SET ended_early_on = current_date - 1 WHERE id = ${range}`
    }
    expect((await placed("tom", id))?.placement).toBe("others")
    expect((await placed("sara", id))?.placement).toBe("mine")
    expect(await requestColumns()).toEqual(before)
    await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
  })

  it("a range with no next in line uses the person's standing one, read for a colleague under row security", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Standing next in line",
    })
    await sql`
      INSERT INTO kernel.user_preferences (user_id, next_in_line_id) VALUES (${people.sara}, ${people.tom})
      ON CONFLICT (user_id) DO UPDATE SET next_in_line_id = EXCLUDED.next_in_line_id`
    const range = await away(people.sara as string, null)
    try {
      expect((await placed("tom", id))?.placement).toBe("standing_in")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
      await sql`UPDATE kernel.user_preferences SET next_in_line_id = NULL WHERE user_id = ${people.sara}`
    }
  })

  it("a next in line without the deciding scope gets nothing: no row, decide not found, and the others hold it naming them blocked", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Blocked stand-in",
    })
    const range = await away(people.sara as string, people.lea as string)
    try {
      expect(await placed("lea", id)).toBeNull()
      const refused = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.lea as string),
        decision: "deny",
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(refused).toBeInstanceOf(ApprovalDecisionError)
      // Refused as any row they cannot read is: not found, which says nothing of the row.
      expect((refused as ApprovalDecisionError).status).toBe(404)
      for (const other of ["ines", "tom"]) {
        const p = await placed(other, id)
        expect(p?.placement).toBe("mine")
        expect(p?.route).toMatchObject({ standIn: null, blockedStandIn: people.lea })
      }
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("granted the scope after the row was proposed, a next in line is still not notified: no row, decide not found", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Granted later",
    })
    await minimal.grantScope(people.lea as string, "projects:approve")
    const range = await away(people.sara as string, people.lea as string)
    try {
      expect(await placed("lea", id)).toBeNull()
      const refused = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.lea as string),
        decision: "deny",
      }).then(
        () => null,
        (err: unknown) => err,
      )
      // Refused as any row they cannot read is: not found, which says nothing of the row.
      expect((refused as ApprovalDecisionError).status).toBe(404)
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("an owner-routed row with its owner away reaches nobody else: not the next in line, not in their badge", async () => {
    const range = await away(people.owner as string, people.tom as string)
    try {
      expect(await placed("tom", rows.owner as string)).toBeNull()
      expect(await badgeFrom("tom", rows.owner as string)).toBe(0)
      const owner = await placed("owner", rows.owner as string)
      expect(owner?.route).toEqual({ to: "owner", userId: people.owner })
      expect(owner?.placement).toBe("mine")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("a decision records whose it was taken for: next in line, also could, and nothing by the person it is for", async () => {
    const make = (title: string) =>
      insertRow({
        requestedBy: people.ines as string,
        notify: deciders(),
        metadata: { originRoutineId: randomUUID() },
        routePersonId: people.sara as string,
        title,
      })
    const byStandIn = await make("Decided by the stand-in")
    const byOther = await make("Decided by another")
    const byOwn = await make("Decided by its person")
    const decide = async (viewer: string, id: string) =>
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people[viewer] as string),
        decision: "deny",
      })
    const decidedFor = async (id: string) =>
      (
        (await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`)[0] as {
          metadata: Record<string, unknown>
        }
      ).metadata.decidedFor
    const range = await away(people.sara as string, people.tom as string)
    try {
      await decide("tom", byStandIn)
      const audit = (await decidedFor(byStandIn)) as Record<string, unknown>
      expect(audit).toMatchObject({ userId: people.sara, as: "next_in_line" })
      expect(typeof audit.awayUntil).toBe("string")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
    await decide("ines", byOther)
    expect(await decidedFor(byOther)).toEqual({ userId: people.sara, as: "also_could" })
    await decide("sara", byOwn)
    expect(await decidedFor(byOwn)).toBeUndefined()
  })

  describe("an item changing hands moves its pending rows", () => {
    let admin: UserContext
    beforeAll(async () => {
      await ensureAppsForOrg(ORG)
      admin = await ctxOf((await minimal.orgAdmin(ORG)).id)
    }, 120_000)

    async function routedTo(link: unknown[], personId: string): Promise<string> {
      return insertRow({
        requestedBy: people.ines as string,
        notify: deciders(),
        metadata: { originRoutineId: randomUUID() },
        routePersonId: personId,
        links: link,
        title: "Follows its item",
      })
    }

    async function newTicket(): Promise<string> {
      const created = await executeTool({
        toolName: "tickets:create",
        orgId: ORG,
        actor: admin,
        params: { subject: "Routing door", channel: "manual" },
      })
      const ticketId = (created.data as { ticketId?: string } | undefined)?.ticketId
      if (!ticketId) throw new Error(`ticket not created: ${JSON.stringify(created)}`)
      return ticketId
    }

    it("assigning a ticket moves its row to the new assignee on the next read", async () => {
      const ticketId = await newTicket()
      const id = await routedTo(ticketLink(ticketId), people.sara as string)
      const res = await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.tom },
      })
      expect(res.error).toBeUndefined()
      expect((await placed("tom", id))?.route).toMatchObject({ userId: people.tom, why: "on_item" })
      expect((await placed("sara", id))?.placement).toBe("others")
    })

    it("claiming an unassigned ticket moves its row to the one who claimed it", async () => {
      const ticketId = await newTicket()
      const id = await routedTo(ticketLink(ticketId), people.sara as string)
      const res = await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.tom, onlyIfUnassigned: true },
      })
      expect(res.error).toBeUndefined()
      expect((await placed("tom", id))?.placement).toBe("mine")
    })

    it("changing a task's assignee moves its row on the next read", async () => {
      const project = await executeTool({
        toolName: "projects:createProject",
        orgId: ORG,
        actor: admin,
        params: { name: "Routing doors", tasks: [{ title: "Door task" }] },
      })
      const data = project.data as { tasks?: Array<{ id: string }> } | undefined
      const taskId = data?.tasks?.[0]?.id
      if (!taskId) throw new Error(`task not created: ${JSON.stringify(project)}`)
      const id = await routedTo(
        [{ label: "Task", app: "projects", entityType: "task", entityId: taskId }],
        people.sara as string,
      )
      const res = await executeTool({
        toolName: "projects:update",
        orgId: ORG,
        actor: admin,
        params: { taskId, assigneeId: people.tom },
      })
      expect(res.error).toBeUndefined()
      expect((await placed("tom", id))?.placement).toBe("mine")
    })

    it("a failing route update is logged and changes nothing else", async () => {
      expect(
        await updateItemRoutePerson({
          orgId: ORG,
          app: "tickets",
          entityType: "ticket",
          entityId: randomUUID(),
          personId: "not-a-person",
        }),
      ).toBe(0)
    })
  })
})
