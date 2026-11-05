// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node session push (P4, spec C9). The text is built from the request's
// TYPE and, for a permission, its tool NAME only: never from a tool input, a
// path, a command or a question's text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import {
  NODE_SESSION_SOUND_WINDOW_S,
  nodeSessionPushText,
  pushNodeSessionWaiting,
} from "~/modules/push/node-session-push"
import { PUSH_BODY_MAX } from "~/modules/push/redact"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"

const sessionTitle = "Fix the sum bug"

describe("nodeSessionPushText", () => {
  it("French and English titles and bodies for permission, question and plan", () => {
    const permission = { type: "permission_request" as const, tool: "Bash" }
    const question = { type: "question" as const, tool: "AskUserQuestion" }
    const plan = { type: "plan_request" as const, tool: "ExitPlanMode" }

    expect(
      nodeSessionPushText("en", {
        sessionTitle,
        notice: { kind: "needs_you", request: permission },
      }),
    ).toEqual({
      title: "Session needs you",
      body: "Fix the sum bug: permission for Bash",
    })
    expect(
      nodeSessionPushText("en", { sessionTitle, notice: { kind: "needs_you", request: question } }),
    ).toEqual({
      title: "Session needs you",
      body: "Fix the sum bug: a question",
    })
    expect(
      nodeSessionPushText("en", { sessionTitle, notice: { kind: "needs_you", request: plan } }),
    ).toEqual({
      title: "Session needs you",
      body: "Fix the sum bug: a plan to review",
    })
    expect(
      nodeSessionPushText("fr", {
        sessionTitle,
        notice: { kind: "needs_you", request: permission },
      }),
    ).toEqual({
      title: "Une session vous attend",
      body: "Fix the sum bug : autorisation pour Bash",
    })
    expect(
      nodeSessionPushText("fr", { sessionTitle, notice: { kind: "needs_you", request: question } }),
    ).toEqual({
      title: "Une session vous attend",
      body: "Fix the sum bug : une question",
    })
    expect(
      nodeSessionPushText("fr", { sessionTitle, notice: { kind: "needs_you", request: plan } }),
    ).toEqual({
      title: "Une session vous attend",
      body: "Fix the sum bug : un plan à approuver",
    })
  })

  it("a tool name carrying a command or a path falls back to 'a tool'", () => {
    for (const tool of ["Bash; rm -rf ~/x", "/Users/someone/.ssh/id_ed25519", "cat x", "", null]) {
      const en = nodeSessionPushText("en", {
        sessionTitle,
        notice: { kind: "needs_you", request: { type: "permission_request", tool } },
      })
      expect(en.body).toBe("Fix the sum bug: permission for a tool")
      const fr = nodeSessionPushText("fr", {
        sessionTitle,
        notice: { kind: "needs_you", request: { type: "permission_request", tool } },
      })
      expect(fr.body).toBe("Fix the sum bug : autorisation pour un outil")
    }
    // A plain MCP-style tool name is kept.
    const mcp = nodeSessionPushText("en", {
      sessionTitle,
      notice: {
        kind: "needs_you",
        request: { type: "permission_request", tool: "mcp__files.read:v2" },
      },
    })
    expect(mcp.body).toBe("Fix the sum bug: permission for mcp__files.read:v2")
  })

  it("the body is at most PUSH_BODY_MAX, cutting the session title only", () => {
    const longTitle = "x".repeat(400)
    for (const locale of ["en", "fr"] as const) {
      for (const request of [
        { type: "permission_request" as const, tool: "A".repeat(64) },
        { type: "question" as const, tool: null },
        { type: "plan_request" as const, tool: null },
      ]) {
        const { body } = nodeSessionPushText(locale, {
          sessionTitle: longTitle,
          notice: { kind: "needs_you", request },
        })
        expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
        expect(body.startsWith("xxx")).toBe(true)
        expect(body).toContain("…")
      }
    }
    // Cut at a code point: an emoji title never leaves half a surrogate pair.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const pad of ["", "x"]) {
      for (const locale of ["en", "fr"] as const) {
        const { body } = nodeSessionPushText(locale, {
          sessionTitle: `${pad}${"😀".repeat(200)}`,
          notice: { kind: "needs_you", request: { type: "question", tool: null } },
        })
        expect(body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
        expect(lone.test(body)).toBe(false)
        expect(body).toContain("😀…")
      }
    }
    const fits = nodeSessionPushText("en", {
      sessionTitle,
      notice: { kind: "needs_you", request: { type: "question", tool: null } },
    })
    expect(fits.body).not.toContain("…")
  })
})

describe("nodeSessionPushText, done and failed (S16)", () => {
  it("S16: a fixed phrase per kind after the title, in English and French", () => {
    expect(nodeSessionPushText("en", { sessionTitle, notice: { kind: "done" } })).toEqual({
      title: "Session done",
      body: "Fix the sum bug is done",
    })
    expect(nodeSessionPushText("en", { sessionTitle, notice: { kind: "failed" } })).toEqual({
      title: "Session failed",
      body: "Fix the sum bug failed",
    })
    expect(nodeSessionPushText("en", { sessionTitle, notice: { kind: "needs_you" } })).toEqual({
      title: "Session needs you",
      body: "Fix the sum bug needs you",
    })
    expect(nodeSessionPushText("fr", { sessionTitle, notice: { kind: "done" } })).toEqual({
      title: "Session terminée",
      body: "Fix the sum bug : la session est terminée",
    })
    expect(nodeSessionPushText("fr", { sessionTitle, notice: { kind: "failed" } })).toEqual({
      title: "Échec de la session",
      body: "Fix the sum bug : la session a échoué",
    })
    expect(nodeSessionPushText("fr", { sessionTitle: null, notice: { kind: "done" } })).toEqual({
      title: "Session terminée",
      body: "Une session est terminée",
    })
    expect(nodeSessionPushText("en", { sessionTitle: null, notice: { kind: "failed" } })).toEqual({
      title: "Session failed",
      body: "A session failed",
    })
    const long = nodeSessionPushText("fr", {
      sessionTitle: "x".repeat(400),
      notice: { kind: "done" },
    })
    expect(long.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX)
    expect(long.body.endsWith("… : la session est terminée")).toBe(true)
  })
})

describe("nodeSessionPushText, redacted (scope rule of push/redact.ts)", () => {
  it("no session title: a generic body in English and French, nothing from the session", () => {
    for (const request of [
      { type: "permission_request" as const, tool: "Bash" },
      { type: "question" as const, tool: null },
      { type: "plan_request" as const, tool: null },
    ]) {
      expect(
        nodeSessionPushText("en", { sessionTitle: null, notice: { kind: "needs_you", request } }),
      ).toEqual({
        title: "Session needs you",
        body: "A session is waiting for you",
      })
      expect(
        nodeSessionPushText("fr", { sessionTitle: null, notice: { kind: "needs_you", request } }),
      ).toEqual({
        title: "Une session vous attend",
        body: "Une session attend votre réponse",
      })
    }
  })
})

// ---------------------------------------------------------------------------
// The send (P4-T03): routed, localised, collapsed per session, idempotent per
// transition, against REAL rows (org, owner, preferences, a push token). Only
// the wire (`send`) is a double, plus the router where a case is about its
// failure.
// ---------------------------------------------------------------------------

const ORG = "00000000-0000-0000-0000-0000000009a0"
const OWNER = "00000000-0000-0000-0000-0000000009a1"
const OTHER = "00000000-0000-0000-0000-0000000009a2"
const SESSION = "00000000-0000-0000-0000-0000000009b0"
const SESSION_B = "00000000-0000-0000-0000-0000000009b1"
const CANARY = "id_ed25519"

function spy() {
  const calls: Array<{ token: PushTokenRow; payload: PushPayload }> = []
  return {
    calls,
    send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
      calls.push({ token, payload })
      return { kind: "sent" }
    },
  }
}

const row = {
  id: SESSION,
  orgId: ORG,
  ownerUserId: OWNER,
  title: "Fix the sum bug",
  source: "app" as const,
  jobId: "00000000-0000-0000-0000-0000000009c0",
  folderName: "app",
  repo: null,
}

/** The job's source scopes, as the default lookup would read them. */
const unscoped = async () => [] as string[]

/** A node permission_request event as it is stored: the input holds a secret path. */
const permissionEvent = {
  seq: 7,
  type: "permission_request",
  payload: {
    requestId: "req-1",
    tool: "Bash",
    input: { command: `cat ~/.ssh/${CANARY}` },
  },
}

/** What the caller passes: the request's type and tool NAME, never its payload. */
function requestOf(event: typeof permissionEvent, eventSeq = event.seq) {
  return {
    requestId: event.payload.requestId,
    eventSeq,
    type: "permission_request" as const,
    tool: event.payload.tool,
  }
}

async function setOwnerPrefs(language: string | null, grid: Record<string, unknown> | null) {
  const stored = grid ? JSON.stringify({ grid }) : null
  await sql`INSERT INTO kernel.user_preferences (user_id, language, notification_channels)
    VALUES (${OWNER}, ${language}, ${stored}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET language = EXCLUDED.language,
      notification_channels = EXCLUDED.notification_channels`
}

/**
 * Forget every send this suite made: the process dedupe AND the durable effect
 * ledger (push sends are claimed there per notify id and device since the
 * effect ledger landed), so a case may replay a transition an earlier case sent.
 */
async function forgetSends() {
  PushFanoutTestAccess.resetDedupe()
  await sql`DELETE FROM kernel.effect_ledger WHERE org_id = ${ORG}`
}

describe("pushNodeSessionWaiting", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'SessionPushOrg', 'session-push-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [OWNER, "owner"],
      [OTHER, "other"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`session-push-${name}@example.com`}, ${name}, 'x')
        ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${OWNER}, 'ios', 'session-push-owner-token')`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${OTHER}, 'ios', 'session-push-other-token')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.effect_ledger WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${OWNER}, ${OTHER})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    await forgetSends()
    await redis.del(`push:node-session:sounded:${SESSION}`)
    await setOwnerPrefs("fr", null)
  })

  afterEach(() => PushFanoutTestAccess.resetDedupe())

  it("sends one routed, localised push with the session link and collapse id, and no tool input", async () => {
    const wire = spy()
    const sent = await pushNodeSessionWaiting(row, requestOf(permissionEvent), {
      send: wire.send,
      badgeCount: async () => 4,
      jobScopes: unscoped,
    })
    expect(sent).toBe(1)
    expect(wire.calls).toHaveLength(1)
    const [{ token, payload }] = wire.calls
    expect(token.token).toBe("session-push-owner-token")
    expect(payload.type).toBe("node_session")
    expect(payload.sessionId).toBe(SESSION)
    expect(payload.threadId).toBeUndefined()
    expect(payload.deepLink).toBe(`liaison://session/${SESSION}`)
    expect(payload.collapseId).toBe(SESSION)
    expect(payload.badgeCount).toBe(4)
    expect(payload.title).toBe("Une session vous attend")
    expect(payload.body).toBe("Fix the sum bug : autorisation pour Bash")
    expect(payload.notificationId).toMatch(/^[0-9a-f-]{36}$/)
    // Rule 5: withdrawn on the phone once the session's notices are read.
    expect(payload.settle).toBe(`attention/kernel/node_session/${SESSION}`)
    expect(JSON.stringify(payload)).not.toContain(CANARY)
  })

  it("the same transition twice is one send; a new transition sends again with the same collapse id", async () => {
    const wire = spy()
    const deps = { send: wire.send, badgeCount: async () => 1, jobScopes: unscoped }
    await pushNodeSessionWaiting(row, requestOf(permissionEvent, 7), deps)
    await pushNodeSessionWaiting(row, requestOf(permissionEvent, 7), deps)
    expect(wire.calls).toHaveLength(1)
    await pushNodeSessionWaiting(row, requestOf(permissionEvent, 12), deps)
    expect(wire.calls).toHaveLength(2)
    expect(wire.calls[1].payload.collapseId).toBe(SESSION)
    expect(wire.calls[1].payload.notificationId).not.toBe(wire.calls[0].payload.notificationId)
  })

  it("an English owner gets English text", async () => {
    await setOwnerPrefs("en", null)
    const wire = spy()
    await pushNodeSessionWaiting(
      row,
      { requestId: "q-1", eventSeq: 3, type: "question", tool: "AskUserQuestion" },
      { send: wire.send, badgeCount: async () => 0, jobScopes: unscoped },
    )
    expect(wire.calls[0].payload.title).toBe("Session needs you")
    expect(wire.calls[0].payload.body).toBe("Fix the sum bug: a question")
  })

  it("an absolute local path in the title reaches the lock screen relative to the folder", async () => {
    for (const [language, expected] of [
      ["en", "Fix src/sum.ts now: a question"],
      ["fr", "Fix src/sum.ts now : une question"],
    ] as const) {
      await forgetSends()
      await setOwnerPrefs(language, null)
      const wire = spy()
      await pushNodeSessionWaiting(
        { ...row, title: "Fix /Users/sam/code/app/src/sum.ts now" },
        { requestId: "q-2", eventSeq: 30, type: "question", tool: null },
        { send: wire.send, badgeCount: async () => 0, jobScopes: unscoped },
      )
      expect(wire.calls[0].payload.body).toBe(expected)
      expect(JSON.stringify(wire.calls[0].payload)).not.toContain("/Users")
    }
  })

  it("a session whose job carries source scopes, or another person's agent_tag run, pushes no title", async () => {
    const secret = "Payroll export for ACME"
    const cases = [
      { label: "scoped job", over: {}, jobScopes: async () => ["finance"] },
      { label: "agent_tag", over: { source: "agent_tag" as const }, jobScopes: unscoped },
      // The default lookup on a job that does not exist: fails closed.
      { label: "unknown job", over: { jobId: crypto.randomUUID() }, jobScopes: undefined },
      { label: "no job", over: { jobId: null }, jobScopes: undefined },
    ]
    for (const [language, body] of [
      ["en", "A session is waiting for you"],
      ["fr", "Une session attend votre réponse"],
    ] as const) {
      await setOwnerPrefs(language, null)
      for (const [i, c] of cases.entries()) {
        await forgetSends()
        const wire = spy()
        await pushNodeSessionWaiting(
          { ...row, title: secret, ...c.over },
          requestOf(permissionEvent, 40 + i),
          { send: wire.send, badgeCount: async () => 0, jobScopes: c.jobScopes },
        )
        expect(wire.calls, c.label).toHaveLength(1)
        expect(wire.calls[0].payload.body, c.label).toBe(body)
        expect(JSON.stringify(wire.calls[0].payload), c.label).not.toContain("Payroll")
        expect(JSON.stringify(wire.calls[0].payload), c.label).not.toContain("Bash")
      }
    }
  })

  // S12 "No push while that session is on screen": the server does not know
  // which session a web or desktop client shows, so a session sounds at most
  // once per NODE_SESSION_SOUND_WINDOW_S; a later push in the window is silent
  // (it still replaces the banner through the collapse id).
  it("a second transition of the same session within the window is silent; another session sounds", async () => {
    await redis.del(
      `push:node-session:sounded:${SESSION}`,
      `push:node-session:sounded:${SESSION_B}`,
    )
    expect(NODE_SESSION_SOUND_WINDOW_S).toBe(60)
    const wire = spy()
    const deps = { send: wire.send, badgeCount: async () => 1, jobScopes: unscoped }
    await pushNodeSessionWaiting(row, requestOf(permissionEvent, 50), deps)
    await pushNodeSessionWaiting(row, requestOf(permissionEvent, 51), deps)
    await pushNodeSessionWaiting({ ...row, id: SESSION_B }, requestOf(permissionEvent, 52), deps)
    expect(wire.calls).toHaveLength(3)
    expect(wire.calls[0].payload.silent).toBeUndefined()
    expect(wire.calls[1].payload.silent).toBe(true)
    expect(wire.calls[1].payload.collapseId).toBe(SESSION)
    expect(wire.calls[2].payload.silent).toBeUndefined()
    const ttl = await redis.ttl(`push:node-session:sounded:${SESSION}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
    await redis.del(
      `push:node-session:sounded:${SESSION}`,
      `push:node-session:sounded:${SESSION_B}`,
    )
  })

  it("S11: the grid with session_needs_you push off gives no send (agent push off does not matter)", async () => {
    await setOwnerPrefs("fr", { agent: { push: true }, session_needs_you: { push: false } })
    const wire = spy()
    const sent = await pushNodeSessionWaiting(row, requestOf(permissionEvent), {
      send: wire.send,
      badgeCount: async () => 0,
    })
    expect(sent).toBe(0)
    expect(wire.calls).toHaveLength(0)
  })

  it("a router failure gives no send and no throw", async () => {
    const wire = spy()
    const sent = await pushNodeSessionWaiting(row, requestOf(permissionEvent), {
      send: wire.send,
      route: async () => {
        throw new Error("router down")
      },
    })
    expect(sent).toBe(0)
    expect(wire.calls).toHaveLength(0)
  })
})
