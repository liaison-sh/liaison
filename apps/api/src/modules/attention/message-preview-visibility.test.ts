// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A thread_reply attention row carries the message's first 140 characters as
// its summary, and the digest mails that summary. A recipient who cannot see
// the message (its requiredScopes not covered by their grants, and not on its
// disclosure list) gets no row at all, exactly as the thread itself hides the
// message from them. Evaluated per recipient with that recipient's own grants.
//
// The same gate covers the `mention` row. Its summary quotes no content ("X
// mentioned you"), but A18 forbids the PUSH itself: no notification is
// generated for a message whose requiredScopes the recipient does not satisfy
// at send time, and the badge count reflects only what the read path admits.
// A badge at urgency 60 for a message the thread hides is both a signal the
// recipient cannot act on and a disclosure that the message exists.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { AppEvent } from "~/infra/events/event-bus"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { processTranslationEvent, type UserPrefsSnapshot } from "./translator"

const SECRET = "apv:deals:read"
const PREVIEW = "Deal 42 closes Friday at 1.2M"

const prefs: UserPrefsSnapshot = {
  digestCadence: "daily",
  workHoursStart: "00:00",
  workHoursEnd: "00:00",
  workDays: [1, 2, 3, 4, 5, 6, 7],
  timezone: "UTC",
}

function event(
  orgId: string,
  authorId: string,
  participantIds: string[],
  extra: Record<string, unknown>,
): AppEvent {
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    orgId,
    actorId: authorId,
    actorType: "agent",
    entityId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    data: {
      threadId: crypto.randomUUID(),
      participantIds,
      preview: PREVIEW,
      authorType: "agent",
      ...extra,
    },
  } as AppEvent
}

function recorder() {
  const rows: Array<{ userId: string; kind: string; summary: string }> = []
  return {
    rows,
    deps: {
      loadPreferences: async () => prefs,
      insertAttentionRow: async (row: { userId: string; kind: string; summary: string }) => {
        rows.push(row)
      },
      buildSubscriptionFilter: async () => async () => true,
      loadThreadMuteStates: async () => ({ muted: new Set<string>(), archived: new Set<string>() }),
    },
  }
}

const replyRecipients = (rows: Array<{ userId: string; kind: string }>) =>
  rows
    .filter((r) => r.kind === "thread_reply")
    .map((r) => r.userId)
    .sort()

const mentionRecipients = (rows: Array<{ userId: string; kind: string }>) =>
  rows
    .filter((r) => r.kind === "mention")
    .map((r) => r.userId)
    .sort()

const mentionsOf = (...userIds: string[]) => userIds.map((id) => ({ type: "user", id }))

describe("thread_reply attention preview follows message visibility", () => {
  const AUTHOR = "00000000-0000-4000-8000-00000000a701"
  const HOLDER = "00000000-0000-4000-8000-00000000a702"
  const LACKER = "00000000-0000-4000-8000-00000000a703"
  const DISCLOSED = "00000000-0000-4000-8000-00000000a704"
  const ORG = "00000000-0000-4000-8000-00000000a700"
  const grants = new Map<string, string[]>([
    [HOLDER, [SECRET]],
    [LACKER, ["kernel:threads:read"]],
    [DISCLOSED, []],
  ])
  const loadUserGrants = async (ids: string[]) =>
    new Map(ids.map((id) => [id, grants.get(id) ?? []] as const))

  it("a member lacking the scope gets no row, a holder and a disclosed member get the preview", async () => {
    const { rows, deps } = recorder()
    await processTranslationEvent(
      event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER, DISCLOSED], {
        requiredScopes: [SECRET],
        disclosureList: [DISCLOSED],
      }),
      { ...deps, loadUserGrants },
    )
    expect(replyRecipients(rows)).toEqual([DISCLOSED, HOLDER].sort())
    expect(rows.find((r) => r.userId === HOLDER)?.summary).toBe(PREVIEW)
    expect(JSON.stringify(rows.filter((r) => r.userId === LACKER))).not.toContain("Deal 42")
  })

  it("an untagged message notifies every participant without loading grants", async () => {
    const { rows, deps } = recorder()
    let loads = 0
    await processTranslationEvent(
      event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER], { requiredScopes: [], disclosureList: null }),
      {
        ...deps,
        loadUserGrants: async (ids) => {
          loads++
          return loadUserGrants(ids)
        },
      },
    )
    expect(replyRecipients(rows)).toEqual([HOLDER, LACKER].sort())
    expect(loads).toBe(0)
  })

  it("fails closed: an event without requiredScopes writes no preview row", async () => {
    const { rows, deps } = recorder()
    await processTranslationEvent(event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER], {}), {
      ...deps,
      loadUserGrants,
    })
    expect(replyRecipients(rows)).toEqual([])
  })
})

describe("mention attention rows follow message visibility", () => {
  const AUTHOR = "00000000-0000-4000-8000-00000000a711"
  const HOLDER = "00000000-0000-4000-8000-00000000a712"
  const LACKER = "00000000-0000-4000-8000-00000000a713"
  const DISCLOSED = "00000000-0000-4000-8000-00000000a714"
  const ORG = "00000000-0000-4000-8000-00000000a710"
  const grants = new Map<string, string[]>([
    [HOLDER, [SECRET]],
    [LACKER, ["kernel:threads:read"]],
    [DISCLOSED, []],
  ])
  const loadUserGrants = async (ids: string[]) =>
    new Map(ids.map((id) => [id, grants.get(id) ?? []] as const))

  it("a mentioned member lacking the scope gets no row: no badge for a message the read path hides", async () => {
    const { rows, deps } = recorder()
    await processTranslationEvent(
      event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER, DISCLOSED], {
        requiredScopes: [SECRET],
        disclosureList: [DISCLOSED],
        mentions: mentionsOf(HOLDER, LACKER, DISCLOSED),
      }),
      { ...deps, loadUserGrants },
    )
    // The holder and the disclosed member can read the message, so the push is
    // theirs to act on. The lacker gets nothing at all: no row, so no badge.
    expect(mentionRecipients(rows)).toEqual([DISCLOSED, HOLDER].sort())
    expect(rows.filter((r) => r.userId === LACKER)).toEqual([])
  })

  it("fails closed: a mention event without requiredScopes writes no mention row", async () => {
    const { rows, deps } = recorder()
    await processTranslationEvent(
      event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER], { mentions: mentionsOf(HOLDER, LACKER) }),
      { ...deps, loadUserGrants },
    )
    expect(mentionRecipients(rows)).toEqual([])
  })

  it("an untagged message still mentions every mentioned member, without loading grants", async () => {
    const { rows, deps } = recorder()
    let loads = 0
    await processTranslationEvent(
      event(ORG, AUTHOR, [AUTHOR, HOLDER, LACKER], {
        requiredScopes: [],
        disclosureList: null,
        mentions: mentionsOf(HOLDER, LACKER),
      }),
      {
        ...deps,
        loadUserGrants: async (ids) => {
          loads++
          return loadUserGrants(ids)
        },
      },
    )
    expect(mentionRecipients(rows)).toEqual([HOLDER, LACKER].sort())
    expect(loads).toBe(0)
  })
})

describe("thread_reply attention preview with the production grants loader", () => {
  let orgId: string
  let author: string
  let holder: string
  let lacker: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    author = (await minimal.person(orgId)).id
    holder = (await minimal.person(orgId)).id
    lacker = (await minimal.person(orgId)).id
    await minimal.grantScope(holder, SECRET)
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("loads each recipient's own grants: the holder gets the preview, the lacker no row", async () => {
    const { rows, deps } = recorder()
    await processTranslationEvent(
      event(orgId, author, [author, holder, lacker], {
        requiredScopes: [SECRET],
        disclosureList: null,
      }),
      deps,
    )
    expect(replyRecipients(rows)).toEqual([holder])
    expect(rows[0]?.summary).toBe(PREVIEW)
  })
})
