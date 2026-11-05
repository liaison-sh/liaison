// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Rule 5, read once, read everywhere: a read on any device sends the person's
// iPhones the new badge in a badge-only push (no banner, no sound), so the
// icon drops without waiting for the next message.
import { describe, expect, it } from "bun:test"
import type { AppEvent } from "~/infra/events/event-bus"
import { apnsBadgeSyncBody, sendBadgeSync } from "~/modules/push/sender"
import type { PushHttpRequest, PushTokenRow } from "~/modules/push/types"
import { readStateEvent } from "~/modules/threads/read-state-broadcast"
import {
  BADGE_SYNC_DELAY_MS,
  type BadgeSyncEnqueueOptions,
  type BadgeSyncJob,
  badgeSyncFor,
  badgeSyncTargets,
  handleBadgeEvent,
  runBadgeSync,
} from "./read-sync"

const ORG = "00000000-0000-0000-0000-00000000aa01"
const USER = "00000000-0000-0000-0000-00000000aa02"

const frame = (change: Parameters<typeof readStateEvent>[2]) =>
  readStateEvent(ORG, USER, change) as unknown as AppEvent

const ios: PushTokenRow = { id: "t1", platform: "ios", token: "abc", environment: "production" }
const android: PushTokenRow = { id: "t2", platform: "android", token: "def" }

describe("a read schedules the person's badge sync", () => {
  it("for a thread, a reply thread, a mute and an attention read", () => {
    expect(badgeSyncFor(frame({ kind: "thread", threadId: "t", unreadCount: 0 }))).toEqual({
      orgId: ORG,
      userId: USER,
    })
    expect(badgeSyncFor(frame({ kind: "reply_thread", threadId: "t", rootId: "r" }))).not.toBeNull()
    expect(badgeSyncFor(frame({ kind: "attention", all: true }))).not.toBeNull()
    expect(
      badgeSyncFor(
        frame({
          kind: "thread_state",
          threadId: "t",
          isArchived: false,
          isMuted: true,
          isPinned: false,
          notifyAllPosts: false,
        }),
      ),
    ).not.toBeNull()
  })

  it("not for a frame that cannot move the badge, nor for another event", () => {
    expect(badgeSyncFor(frame({ kind: "agent_mail_access", enabled: true, at: 1 }))).toBeNull()
    const other = { ...frame({ kind: "attention", all: true }), entity: "message" }
    expect(badgeSyncFor(other)).toBeNull()
  })

  it("schedules one job per person per window under its real job id; the next window is a new job", async () => {
    // A fake queue with BullMQ's one rule that matters here: a job id already
    // queued is not queued again.
    const queued = new Map<string, { job: BadgeSyncJob; opts: BadgeSyncEnqueueOptions }>()
    const latest: number[] = []
    let now = 10 * BADGE_SYNC_DELAY_MS + 100
    const deps = {
      now: () => now,
      enqueue: async (job: BadgeSyncJob, opts: BadgeSyncEnqueueOptions) => {
        if (!queued.has(opts.jobId)) queued.set(opts.jobId, { job, opts })
      },
      markLatest: async (job: Required<BadgeSyncJob>) => {
        latest.push(job.window)
      },
    }
    await handleBadgeEvent(frame({ kind: "thread", threadId: "t", unreadCount: 0 }), deps)
    now += 500
    await handleBadgeEvent(frame({ kind: "reply_thread", threadId: "t", rootId: "r" }), deps)
    expect([...queued.keys()]).toEqual([`badge-sync:${ORG}:${USER}:10`])
    const first = queued.get(`badge-sync:${ORG}:${USER}:10`)
    expect(first?.job).toEqual({ orgId: ORG, userId: USER, window: 10 })
    expect(first?.opts.delay).toBe(BADGE_SYNC_DELAY_MS)
    now += BADGE_SYNC_DELAY_MS
    await handleBadgeEvent(frame({ kind: "attention", all: true }), deps)
    expect([...queued.keys()]).toEqual([
      `badge-sync:${ORG}:${USER}:10`,
      `badge-sync:${ORG}:${USER}:11`,
    ])
    expect(latest).toEqual([10, 10, 11])
  })
})

describe("the badge also follows what lowers it without a read (rule 5)", () => {
  const OTHER = "00000000-0000-0000-0000-00000000aa03"
  const audience = {
    directThreadMembers: async () => [USER, OTHER],
    scopeRequestHolders: async () => [OTHER],
  }
  const users = (jobs: BadgeSyncJob[]) => jobs.map((j) => j.userId).sort()

  it("an approval decided by someone else: everyone it asked", async () => {
    const decided = {
      app: "kernel",
      entity: "approval_request",
      action: "update",
      orgId: ORG,
      actorId: OTHER,
      data: { status: "approved", notifyUserIds: [USER, OTHER] },
    } as unknown as AppEvent
    expect(users(await badgeSyncTargets(decided, audience))).toEqual([USER, OTHER].sort())
    const pending = { ...decided, data: { status: "pending", notifyUserIds: [USER] } } as AppEvent
    expect(await badgeSyncTargets(pending, audience)).toEqual([])
  })

  it("a deleted message: the members of its direct conversation", async () => {
    const deleted = {
      app: "kernel",
      entity: "message",
      action: "delete",
      orgId: ORG,
      actorId: OTHER,
      data: { id: "m1", threadId: "t1" },
    } as unknown as AppEvent
    expect(users(await badgeSyncTargets(deleted, audience))).toEqual([USER, OTHER].sort())
  })

  it("leaving a conversation: the person who left", async () => {
    const left = {
      app: "kernel",
      entity: "participant",
      action: "remove",
      orgId: ORG,
      actorId: OTHER,
      data: { threadId: "t1", userId: USER },
    } as unknown as AppEvent
    expect(await badgeSyncTargets(left, audience)).toEqual([{ orgId: ORG, userId: USER }])
  })

  it("an access request granted or denied: the people it asked", async () => {
    const resolved = {
      app: "kernel",
      entity: "scope_request",
      action: "update",
      entityId: "sr1",
      orgId: ORG,
      actorId: USER,
      data: { status: "denied" },
    } as unknown as AppEvent
    expect(users(await badgeSyncTargets(resolved, audience))).toEqual([OTHER])
  })

  it("nothing for an event that cannot lower anybody's badge", async () => {
    const created = {
      app: "kernel",
      entity: "message",
      action: "create",
      orgId: ORG,
      data: { id: "m2", threadId: "t1" },
    } as unknown as AppEvent
    expect(await badgeSyncTargets(created, audience)).toEqual([])
  })
})

describe("the latest window wins (rule 5)", () => {
  const deps = (latestWindow: number | null, sent: number[]) => ({
    loadTokens: async () => [ios],
    badgeCount: async () => 7,
    latest: async () => latestWindow,
    send: async (_token: PushTokenRow, count: number) => {
      sent.push(count)
      return { kind: "sent" as const }
    },
  })

  it("a job a newer window has superseded sends nothing: the newer job sends the count", async () => {
    const sent: number[] = []
    expect(await runBadgeSync({ orgId: ORG, userId: USER, window: 5 }, deps(6, sent))).toBe(0)
    expect(sent).toEqual([])
  })

  it("the newest job sends", async () => {
    const sent: number[] = []
    expect(await runBadgeSync({ orgId: ORG, userId: USER, window: 6 }, deps(6, sent))).toBe(1)
    expect(sent).toEqual([7])
  })
})

describe("the badge sync push", () => {
  it("sends each iPhone the shared badge count, and nothing to Android", async () => {
    const sent: Array<{ token: string; count: number }> = []
    const n = await runBadgeSync(
      { orgId: ORG, userId: USER },
      {
        loadTokens: async () => [ios, android],
        badgeCount: async () => 3,
        send: async (token, count) => {
          sent.push({ token: token.token, count })
          return { kind: "sent" }
        },
      },
    )
    expect(n).toBe(1)
    expect(sent).toEqual([{ token: "abc", count: 3 }])
  })

  it("is a badge-only APNs notification: no alert, no sound, no extension", async () => {
    expect(JSON.parse(apnsBadgeSyncBody(4))).toEqual({ aps: { badge: 4 } })
    const requests: PushHttpRequest[] = []
    const result = await sendBadgeSync(ios, 0, {
      credentials: {
        apns: {
          teamId: "T",
          keyId: "K",
          bundleId: "sh.example.app",
          key: (await import("node:crypto"))
            .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
      },
      transport: {
        request: async (req) => {
          requests.push(req)
          return { status: 200, body: "" }
        },
      },
    })
    expect(result.kind).toBe("sent")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers["apns-priority"]).toBe("5")
    expect(requests[0]!.headers["apns-collapse-id"]).toBeUndefined()
    // Never stored for an offline phone: APNs keeps one notification per
    // device, and a stored badge-only push would replace a real alert.
    expect(requests[0]!.headers["apns-expiration"]).toBe("0")
    expect(JSON.parse(requests[0]!.body)).toEqual({ aps: { badge: 0 } })
  })

  it("a BadDeviceToken on the recorded host is retried on the other, as every push is", async () => {
    const requests: PushHttpRequest[] = []
    const result = await sendBadgeSync({ ...ios, environment: "sandbox" }, 2, {
      credentials: {
        apns: {
          teamId: "T",
          keyId: "K",
          bundleId: "sh.example.app",
          key: (await import("node:crypto"))
            .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .privateKey.export({ type: "pkcs8", format: "pem" })
            .toString(),
        },
      },
      transport: {
        request: async (req) => {
          requests.push(req)
          return requests.length === 1
            ? { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) }
            : { status: 200, body: "" }
        },
      },
    })
    expect(requests.map((r) => new URL(r.url).host)).toEqual([
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
    ])
    expect(result.kind).toBe("sent")
    expect(result.environment).toBe("production")
    expect(requests[1]!.headers["apns-expiration"]).toBe("0")
  })
})
