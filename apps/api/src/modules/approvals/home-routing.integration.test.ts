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
      ${JSON.stringify({ title: spec.title })}::jsonb, ${JSON.stringify(spec.metadata ?? {})}::jsonb,
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
    for (const name of ["ines", "tom", "sara", "owner"]) {
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
})
