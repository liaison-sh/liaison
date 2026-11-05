// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The computer session notices (round 2, S12-S16), against REAL rows (org,
// owner, preferences, push tokens, attention rows, the presence registry in
// Redis). Only the wires are doubles: the push `send` and the desktop emitter.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { renderDigestEmail } from "~/modules/attention/digest"
import type { NodeSessionRow } from "~/modules/node-sessions/store"
import type { SessionStatusChange } from "~/modules/node-sessions/waiting-hook"
import {
  type DesktopNotifyPayload,
  registerDesktopEmitter,
} from "~/modules/notifications/desktop-hook"
import { notificationIdFor } from "~/modules/notifications/router"
import { PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import {
  nodeSessionNoticeBody,
  notifyNodeSessionStatus,
  sessionWords,
} from "~/modules/push/node-session-notify"
import { nodeSessionNotifyId } from "~/modules/push/node-session-push"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"

const ORG = "00000000-0000-0000-0000-00000000a5a0"
const OWNER = "00000000-0000-0000-0000-00000000a5a1"
const OTHER = "00000000-0000-0000-0000-00000000a5a2"
const TITLE = "Fix the sum bug"

const pushes: Array<{ token: PushTokenRow; payload: PushPayload }> = []
const desktops: DesktopNotifyPayload[] = []

const deps = {
  send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
    pushes.push({ token, payload })
    return { kind: "sent" }
  },
  badgeCount: async () => 1,
  jobScopes: async () => [] as string[],
}

let n = 0
/** A fresh session row (only the columns the notifier reads matter). */
function session(over: Partial<NodeSessionRow> = {}): NodeSessionRow {
  n++
  const id = `00000000-0000-0000-0000-${String(0xa5c000 + n).padStart(12, "0")}`
  return {
    id,
    orgId: ORG,
    ownerUserId: OWNER,
    nodeId: null,
    jobId: "00000000-0000-0000-0000-00000000a5b0",
    agentId: "00000000-0000-0000-0000-00000000a5b1",
    source: "app",
    configKind: "owner",
    configDir: null,
    sourceThreadId: null,
    sourceMessageId: null,
    title: TITLE,
    prompt: TITLE,
    folderName: "app",
    folderPath: null,
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "standard",
    effort: null,
    muted: false,
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    sdkSessionId: null,
    claudeCode: null,
    lastSeq: 10,
    lastBatchNo: 1,
    lastBatchHash: null,
    lastCommandSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite5m: 0,
    tokensCacheWrite1h: 0,
    resultSummary: null,
    error: null,
    createdAt: new Date(),
    startedAt: new Date(),
    endedAt: null,
    updatedAt: new Date(),
    ...over,
  } as NodeSessionRow
}

/** Move the row to `to` (the notifier reads the row as the hook hands it over). */
async function move(
  row: NodeSessionRow,
  to: NodeSessionRow["status"],
  over: Partial<SessionStatusChange> & { endedAt?: Date; lastSeq?: number } = {},
): Promise<NodeSessionRow> {
  const ended = to === "done" || to === "failed" || to === "needs_you" || to === "stopped"
  const next = {
    ...row,
    status: to,
    lastSeq: over.lastSeq ?? row.lastSeq + 1,
    endedAt: ended ? (over.endedAt ?? new Date(Date.now() + n * 1000 + row.lastSeq)) : null,
  } as NodeSessionRow
  await notifyNodeSessionStatus(
    next,
    {
      from: row.status,
      to,
      cause: over.cause ?? "node",
      ...(over.becameWaiting ? { becameWaiting: over.becameWaiting } : {}),
    },
    deps,
  )
  return next
}

async function notices(sessionId: string) {
  return sql<
    Array<{
      kind: string
      summary: string
      read_at: Date | null
      metadata: Record<string, any>
      digest_state: string
      is_urgent: boolean
      user_id: string
    }>
  >`SELECT kind, summary, read_at, metadata, digest_state, is_urgent, user_id
      FROM kernel.attention_events
     WHERE org_id = ${ORG} AND app = 'kernel' AND entity_type = 'node_session'
       AND entity_id = ${sessionId}
     ORDER BY created_at`
}

/** W1-D8: the router-level delivery rows of one notice (what the router held back). */
async function heldBack(row: NodeSessionRow, kind: "needs_you" | "done" | "failed") {
  const transition = row.endedAt ? row.endedAt.getTime() : row.lastSeq
  const id = notificationIdFor(OWNER, nodeSessionNotifyId(row.id, kind, transition))
  const rows = await sql<Array<{ channel: string; result: string; reason: string | null }>>`
    SELECT channel, result, reason FROM kernel.notification_deliveries
     WHERE org_id = ${ORG} AND notification_id = ${id} AND device_id IS NULL
     ORDER BY channel`
  return [...rows]
}

const pushesFor = (sessionId: string) => pushes.filter((p) => p.payload.sessionId === sessionId)
const desktopsFor = (sessionId: string) => desktops.filter((d) => d.notifyId.includes(sessionId))

async function setPrefs(language: string, grid: Record<string, unknown> | null = null) {
  await sql`INSERT INTO kernel.user_preferences (user_id, language, notification_channels)
    VALUES (${OWNER}, ${language}, ${grid ? JSON.stringify({ grid }) : null}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language,
      notification_channels = EXCLUDED.notification_channels`
}

/** A live presence entry of the owner, as infra/websocket.ts stores it. */
async function present(connId: string, viewing: string[], lastActiveAt: number) {
  await redis.set(
    `ws:notify-conn:${connId}`,
    JSON.stringify({
      connId,
      instanceId: "i1",
      kind: "desktop_app",
      lastActiveAt,
      viewing: { threadIds: viewing, focused: true },
    }),
    "EX",
    60,
  )
  await redis.sadd(`ws:notify-presence:${ORG}:${OWNER}`, connId)
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'SessionNotifyOrg', 'session-notify-org') ON CONFLICT (id) DO NOTHING`
  for (const [id, name] of [
    [OWNER, "owner"],
    [OTHER, "other"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${id}, ${ORG}, ${`session-notify-${name}@example.com`}, ${name}, 'x')
      ON CONFLICT (id) DO NOTHING`
  }
  await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
  await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
    VALUES (${ORG}, ${OWNER}, 'ios', 'session-notify-owner-token')`
  await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
    VALUES (${ORG}, ${OTHER}, 'ios', 'session-notify-other-token')`
  registerDesktopEmitter((_decision, payload) => {
    desktops.push(payload)
  })
})

afterAll(async () => {
  registerDesktopEmitter(null)
  await redis.del(`ws:notify-presence:${ORG}:${OWNER}`)
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${OWNER}, ${OTHER})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

beforeEach(async () => {
  PushFanoutTestAccess.resetDedupe()
  pushes.length = 0
  desktops.length = 0
  await redis.del(`ws:notify-presence:${ORG}:${OWNER}`)
  await setPrefs("en")
})

afterEach(() => PushFanoutTestAccess.resetDedupe())

describe("the session notices (S12)", () => {
  it("S12: needs_you writes one attention row and one push, done one each, failed one each; a repeat of the same transition sends nothing new", async () => {
    for (const [to, kind, title, body] of [
      ["needs_you", "node_session_needs_you", "Session needs you", `${TITLE} needs you`],
      ["done", "node_session_done", "Session done", `${TITLE} is done`],
      ["failed", "node_session_failed", "Session failed", `${TITLE} failed`],
    ] as const) {
      const row = session()
      const endedAt = new Date("2026-10-15T12:00:00.000Z")
      await move(row, to, { endedAt, lastSeq: 11 })
      await move(row, to, { endedAt, lastSeq: 11 })
      const rows = await notices(row.id)
      expect(
        rows.map((r) => [r.kind, r.read_at, r.user_id]),
        to,
      ).toEqual([[kind, null, OWNER]])
      expect(rows[0].summary).toBe(body)
      expect(rows[0].is_urgent).toBe(to !== "done")
      const sent = pushesFor(row.id)
      expect(sent, to).toHaveLength(1)
      expect(sent[0].token.token).toBe("session-notify-owner-token")
      expect(sent[0].payload).toMatchObject({
        type: "node_session",
        deepLink: `liaison://session/${row.id}`,
        collapseId: row.id,
        title,
        body,
      })
      expect(
        desktopsFor(row.id).map((d) => [d.title, d.body]),
        to,
      ).toEqual([[title, body]])
    }
    // Only ever the owner.
    expect(pushes.some((p) => p.token.token === "session-notify-other-token")).toBe(false)
  })

  it("S12: entering done marks the unread needs_you row read", async () => {
    const row = session()
    const waiting = await move(row, "waiting", {
      becameWaiting: { requestId: "r1", eventSeq: 11, type: "question", tool: null },
    })
    const running = { ...waiting, status: "running" } as NodeSessionRow
    await move(running, "done")
    const rows = await notices(row.id)
    expect(rows.map((r) => [r.kind, r.read_at === null])).toEqual([
      ["node_session_needs_you", false],
      ["node_session_done", true],
    ])
    expect(rows[0].summary).toBe(`${TITLE}: a question`)
  })

  it("S12: a resume (to running) marks the needs_you row read", async () => {
    const row = session()
    const needs = await move(row, "needs_you")
    await move(needs, "queued", { cause: "owner" })
    await move({ ...needs, status: "queued" } as NodeSessionRow, "running", { cause: "server" })
    const rows = await notices(row.id)
    expect(rows.map((r) => [r.kind, r.read_at === null])).toEqual([
      ["node_session_needs_you", false],
    ])
    expect(pushesFor(row.id)).toHaveLength(1)
  })

  it("S12: owner mark_done (cause owner) sends nothing and marks the needs_you row read", async () => {
    const row = session()
    const needs = await move(row, "needs_you")
    await move(needs, "done", { cause: "owner" })
    const rows = await notices(row.id)
    expect(rows.map((r) => [r.kind, r.read_at === null])).toEqual([
      ["node_session_needs_you", false],
    ])
    expect(pushesFor(row.id)).toHaveLength(1)
    expect(desktopsFor(row.id)).toHaveLength(1)
  })

  it("A45: a follow's end (cause follow) sends nothing on any channel and marks the earlier rows read", async () => {
    const row = session({ source: "import" } as Partial<NodeSessionRow>)
    const failed = await move(row, "failed")
    await move({ ...failed, status: "running", endedAt: null } as NodeSessionRow, "needs_you", {
      cause: "follow",
    } as Partial<SessionStatusChange>)
    const rows = await notices(row.id)
    expect(rows.map((r) => [r.kind, r.read_at === null])).toEqual([["node_session_failed", false]])
    expect(pushesFor(row.id)).toHaveLength(1)
    expect(desktopsFor(row.id)).toHaveLength(1)
  })

  it("S12: the attention row links to tabType kernel:session", async () => {
    const row = session()
    await move(row, "done")
    const [r] = await notices(row.id)
    expect(r.metadata.link).toEqual({ tabType: "kernel:session", entityId: row.id })
  })
})

describe("on screen, mute and sound (S13-S15)", () => {
  it("S13: a focused client viewing the session within 2 min holds push and desktop back, in-app row still written; after 2 min idle it pushes", async () => {
    const watched = session()
    await present("conn-watch", [watched.id], Date.now() - 60_000)
    await move(watched, "done")
    expect(await notices(watched.id)).toHaveLength(1)
    expect(pushesFor(watched.id)).toHaveLength(0)
    expect(desktopsFor(watched.id)).toHaveLength(0)

    // The same client, idle for more than 2 min: the next notice goes out.
    const idle = session()
    await present("conn-watch", [idle.id], Date.now() - 121_000)
    await move(idle, "needs_you")
    expect(await notices(idle.id)).toHaveLength(1)
    expect(pushesFor(idle.id)).toHaveLength(1)
    expect(desktopsFor(idle.id)).toHaveLength(1)
  })

  it("S14: a muted session writes the in-app row only", async () => {
    await setPrefs("en", { session_needs_you: { email: true } })
    const row = session({ muted: true })
    await move(row, "needs_you")
    const rows = await notices(row.id)
    expect(rows.map((r) => [r.kind, r.digest_state])).toEqual([
      ["node_session_needs_you", "suppressed"],
    ])
    expect(pushesFor(row.id)).toHaveLength(0)
    expect(desktopsFor(row.id)).toHaveLength(0)

    // The same session unmuted, email cell on: the digest takes it.
    const loud = session()
    await move(loud, "needs_you")
    expect((await notices(loud.id))[0].digest_state).toBe("pending")
  })

  it("W1-D8: the S13 and S14 hold-backs write their router-level delivery rows; a sent notice writes none", async () => {
    const watched = session()
    await present("conn-watch", [watched.id], Date.now() - 30_000)
    const done = await move(watched, "done")
    expect(pushesFor(watched.id)).toHaveLength(0)
    const onScreen = await heldBack(done, "done")
    expect(onScreen.map((r) => r.channel)).toEqual(["desktop", "push"])
    for (const r of onScreen) {
      expect(r.result).toBe("suppressed")
      expect(r.reason).toBeTruthy()
    }

    const muted = session({ muted: true })
    const needs = await move(muted, "needs_you")
    expect(await heldBack(needs, "needs_you")).toEqual([
      { channel: "desktop", result: "suppressed", reason: "session_muted" },
      { channel: "push", result: "suppressed", reason: "session_muted" },
    ])

    await redis.del(`ws:notify-presence:${ORG}:${OWNER}`)
    const loud = session()
    const failed = await move(loud, "failed")
    expect(pushesFor(loud.id)).toHaveLength(1)
    expect(await heldBack(failed, "failed")).toEqual([])
  })

  it("S15: a second push within 60 s is silent", async () => {
    const row = session()
    await redis.del(`push:node-session:sounded:${row.id}`)
    const needs = await move(row, "needs_you")
    const running = await move(needs, "running", { cause: "owner" })
    await move(running, "needs_you")
    const sent = pushesFor(row.id)
    expect(sent).toHaveLength(2)
    expect(sent[0].payload.silent).toBeUndefined()
    expect(sent[1].payload.silent).toBe(true)
    expect(sent[1].payload.collapseId).toBe(row.id)
    expect(sent[1].payload.notificationId).not.toBe(sent[0].payload.notificationId)
    await redis.del(`push:node-session:sounded:${row.id}`)
  })
})

describe("model-written text (S16)", () => {
  it("S16: for a done session whose summary is 'secret plan' and whose last tool input is 'rm x', the push and computer bodies exclude both and equal the fixed phrase for the kind", async () => {
    for (const [to, phrase] of [
      ["done", `${TITLE} is done`],
      ["needs_you", `${TITLE} needs you`],
      ["failed", `${TITLE} failed`],
    ] as const) {
      const row = session({ resultSummary: "secret plan", latestActivity: "rm x" })
      await move(row, to)
      const [push] = pushesFor(row.id)
      const [desk] = desktopsFor(row.id)
      expect(push.payload.body, to).toBe(phrase)
      expect(desk.body, to).toBe(phrase)
      for (const out of [JSON.stringify(push.payload), JSON.stringify(desk)]) {
        expect(out).not.toContain("secret")
        expect(out).not.toContain("rm x")
      }
    }
  })

  it("S16: the email subject equals title + fixed phrase", async () => {
    await setPrefs("en", { session_done: { email: true } })
    const row = session({ resultSummary: "secret plan" })
    await move(row, "done")
    const [r] = await notices(row.id)
    expect(r.digest_state).toBe("pending")
    // The email is the digest: its line for this notice is the row's summary,
    // title + fixed phrase; the digest's subject is its own fixed line.
    expect(r.summary).toBe(`${TITLE} is done`)
    const email = renderDigestEmail({
      rows: [
        {
          id: "x",
          orgId: ORG,
          userId: OWNER,
          app: "kernel",
          entityType: "node_session",
          entityId: row.id,
          kind: "node_session_done",
          urgency: 50,
          summary: r.summary,
          isUrgent: false,
          occurredAt: new Date(),
        },
      ],
      baseUrl: "https://app.example",
      now: new Date(),
      toAddress: "owner@example.com",
      locale: "en",
    })
    expect(email.subject).not.toContain("secret")
    expect(email.html).toContain(`${TITLE} is done`)
    expect(email.html).toContain(`https://app.example/sessions/${row.id}`)
    expect(`${email.html}${email.text}`).not.toContain("secret")
  })

  it("S16: the attention body renders '<b>x</b> [l](http://evil)' as clipped plain text after the session-says label", async () => {
    const row = session({ resultSummary: "<b>x</b> [l](http://evil)" })
    await move(row, "needs_you")
    const [r] = await notices(row.id)
    expect(r.metadata.body).toBe(`${TITLE} needs you\nThe session says: x l`)

    await setPrefs("fr")
    const fr = session({
      resultSummary: `**Fini** ![img](http://evil/p.png) see https://evil.example/x\u0007 ${"y".repeat(400)}`,
    })
    await move(fr, "done")
    const [f] = await notices(fr.id)
    const [line, says] = String(f.metadata.body).split("\n")
    expect(line).toBe(`${TITLE} : la session est terminée`)
    expect(says.startsWith("La session indique : Fini see y")).toBe(true)
    expect(says).not.toContain("http")
    expect(says).not.toContain("evil")
    expect(says).not.toContain("\u0007")
    expect(says.length).toBeLessThanOrEqual("La session indique : ".length + 300)
    expect(says.endsWith("…")).toBe(true)
  })

  it("S16: sessionWords strips markup, URLs and control characters and clips at 300", () => {
    expect(sessionWords("<script>alert(1)</script>ok")).toBe("alert(1) ok")
    expect(sessionWords("go to www.evil.example now")).toBe("go to now")
    expect(sessionWords("[a](javascript:alert(1)) b")).toBe("a) b")
    expect(sessionWords("line1\nline2\ttab")).toBe("line1 line2 tab")
    expect(sessionWords("   ")).toBe("")
    expect(sessionWords("😀".repeat(400)).length).toBeLessThanOrEqual(300)
    expect(nodeSessionNoticeBody("en", "T is done", "<i></i>")).toBe("T is done")
    expect(nodeSessionNoticeBody("en", "T is done", null)).toBe("T is done")
  })
})
