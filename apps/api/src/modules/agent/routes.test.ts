// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { setDraining } from "~/lib/readiness"
import { beginShutdown, ShutdownTestAccess } from "~/lib/shutdown"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { LIVE_LLM } from "~/tests/e2e/helpers/live-llm"
import { clearTestCreditPricing, setTestCreditPricing } from "~/tests/helpers/credit-pricing"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "test" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

// A provider stream that errors BEFORE emitting any text — the AI SDK v6 shape
// for a credit-block / timeout / upstream failure mid-stream. No `finish` part
// follows an in-band `error`, so the `error` chunk is the only terminal signal.
const PROVIDER_ERROR_DETAIL = "credits_exhausted: upstream provider key sk-live-abcdef123 exhausted"
function fakeAgentStreamTextErrorBeforeText() {
  return {
    fullStream: (async function* () {
      yield { type: "error", error: new Error(PROVIDER_ERROR_DETAIL) }
    })(),
  } as never
}

const ORG_ID = "00000000-0000-4000-8000-000000ab0001"
const USER_ID = "00000000-0000-4000-8000-000000ab0002"
const THREAD_ID = "00000000-0000-4000-8000-000000ab0003"

describe("agent routes", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    // Agent billing (402 on zero balance) is managed-edition behaviour.
    _setEdition("managed")
    // A managed cell meters nothing without the control plane's pushed rate.
    await setTestCreditPricing()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'RouteOrg', 'route-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'route@test.com', 'Route User')`
    // Every registered user has a personal agent, and an agent-authored row
    // names the agent that spoke (0080).
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@route', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    // The room floor reads the members' PERSISTED grants, so the actor's '*'
    // has to exist in the database too or the turn runs at no scope at all.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'agent-route-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '5.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')`

    token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Route User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    _setEdition(null)
    AgentServiceTestAccess.setStreamText()
    await clearTestCreditPricing()
    await releaseTestLock()
  })

  it("returns 401 without auth token", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, content: "Hello" }),
    })
    expect(res.status).toBe(401)
  })

  it("returns 400 for missing threadId", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content: "Hello" }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 400 for missing content", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ threadId: THREAD_ID }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 400 for empty content", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ threadId: THREAD_ID, content: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 402 when balance is zero", async () => {
    const zeroOrgId = "00000000-0000-4000-8000-000000ab0004"
    const zeroUserId = "00000000-0000-4000-8000-000000ab0005"
    const zeroThreadId = "00000000-0000-4000-8000-000000ab0006"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${zeroOrgId}, 'ZeroRouteOrg', 'zero-route-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${zeroUserId}, ${zeroOrgId}, 'zero-route@test.com', 'Zero Route User')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${zeroOrgId}, 'personal', '@zero-route', 'Test agent', ${zeroUserId}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${zeroUserId}, ${zeroOrgId}, '*')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${zeroThreadId}, ${zeroOrgId}, 'zero-route-chat', 'agent_chat', ${zeroUserId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${zeroThreadId}, ${zeroUserId}, ${zeroOrgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${zeroOrgId}, '0.00000000', '0.00000000', 'EUR')`

    const zeroToken = await signAccessToken(
      {
        userId: zeroUserId,
        orgId: zeroOrgId,
        name: "Zero",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${zeroToken}`,
        },
        body: JSON.stringify({ threadId: zeroThreadId, content: "Hello" }),
      })
      expect(res.status).toBe(402)
      const body = (await res.json()) as any
      expect(body.error.message).toContain("usage")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("returns SSE content-type for valid request", async () => {
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId: THREAD_ID, content: "Hello" }),
      })
      const contentType = res.headers.get("content-type")
      expect(contentType).toContain("text/event-stream")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // The sender's surface chooses which steps to computer mode a server turn
  // gives; it has to reach the prompt's runtime-context tail.
  it("carries the client surface into the turn's runtime context", async () => {
    const surfaceThreadId = "00000000-0000-4000-8000-000000ab0008"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${surfaceThreadId}, ${ORG_ID}, 'agent-route-surface', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${surfaceThreadId}, ${USER_ID}, ${ORG_ID})`
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    const seen: string[] = []
    AgentServiceTestAccess.setStreamText(((args: unknown) => {
      seen.push(JSON.stringify(args))
      return fakeAgentStreamText()
    }) as never)
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          threadId: surfaceThreadId,
          content: "make the monthly report",
          clientSurface: "mobile",
        }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]).toContain("The person is using the Liaison mobile app.")
    } finally {
      AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("returns 400 for an unknown client surface", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: THREAD_ID, content: "Hello", clientSurface: "fridge" }),
    })
    expect(res.status).toBe(400)
  })

  it("finalizes an errored turn (no text) and sends the client a sanitized error", async () => {
    // Dedicated thread so the assertion isn't perturbed by other tests' agent
    // messages on THREAD_ID.
    const errThreadId = "00000000-0000-4000-8000-000000ab0007"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${errThreadId}, ${ORG_ID}, 'agent-route-err', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${errThreadId}, ${USER_ID}, ${ORG_ID})`

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(fakeAgentStreamTextErrorBeforeText as never)
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId: errThreadId, content: "trigger a provider error" }),
      })
      expect(res.status).toBe(200)
      // Drain the SSE stream so the handler's finalize/finally completes.
      const body = await res.text()

      // The client receives the class line AND the failure's own detail, made safe:
      // never a generic line alone, never a secret-shaped token.
      expect(body).toContain("I couldn't complete that response")
      expect(body).toContain('"code":"credits_exhausted"')
      expect(body).toContain("upstream provider key [redacted] exhausted")
      expect(body).not.toContain("sk-live-abcdef123")

      // The thread must NOT be left with a dangling user message and no reply:
      // there is a finalized AGENT message recording the error.
      const agentMsgs = await sql`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${errThreadId} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      expect(agentMsgs.length).toBe(1)
      // Not a blank bubble — the failure shows in the chat.
      expect(String(agentMsgs[0].content)).not.toBe("")
      expect(String(agentMsgs[0].content)).toContain("I couldn't complete that response")
      expect(String(agentMsgs[0].content)).toContain("upstream provider key [redacted] exhausted")
      expect(String(agentMsgs[0].content)).not.toContain("sk-live-abcdef123")
      const meta = agentMsgs[0].metadata as any
      expect(typeof meta.agentNotice).toBe("string")
      expect(meta.finishReason).toBe("error")
      // The raw detail rides in metadata.error for distinct rendering / field debugging.
      expect(meta.error).toBe(PROVIDER_ERROR_DETAIL)

      // Exactly one user turn, and it is no longer dangling (an agent reply exists).
      const userMsgs = await sql`
        SELECT id FROM kernel.messages
        WHERE thread_id = ${errThreadId} AND author_type = 'user'
      `
      expect(userMsgs.length).toBe(1)
    } finally {
      // Restore the success stub for any later tests.
      AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("returns 400 for whitespace-only content with no fileIds", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ threadId: THREAD_ID, content: "   " }),
    })
    expect(res.status).toBe(400)
  })

  it("returns 403 when fileIds are not staged in a visible upload session", async () => {
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        threadId: THREAD_ID,
        content: "look at this",
        fileIds: ["00000000-0000-4000-8000-00000000dead"],
      }),
    })
    expect(res.status).toBe(403)
  })

  it("the draining 503 persists no message; the retry persists exactly one", async () => {
    const drainThreadId = "00000000-0000-4000-8000-000000ab00d1"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${drainThreadId}, ${ORG_ID}, 'agent-route-drain', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${drainThreadId}, ${USER_ID}, ${ORG_ID})`
    const post = () =>
      app.request("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ threadId: drainThreadId, content: "Hello during a deploy" }),
      })
    const userMessages = () =>
      sql`SELECT id FROM kernel.messages WHERE thread_id = ${drainThreadId} AND author_type = 'user'`

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      setDraining(true)
      const refused = await post()
      expect(refused.status).toBe(503)
      expect(refused.headers.get("retry-after")).toBe("1")
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("RESTARTING")
      expect(await userMessages()).toHaveLength(0)

      // The client retries on a live process (here: the same one, ready again).
      setDraining(false)
      const retried = await post()
      expect(retried.status).toBe(200)
      await retried.text()
      expect(await userMessages()).toHaveLength(1)
    } finally {
      setDraining(false)
      if (ORIG_ANTHROPIC_KEY) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("within the edge grace a draining process still takes a turn; past it, it refuses", async () => {
    const graceThreadId = "00000000-0000-4000-8000-000000ab00d2"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${graceThreadId}, ${ORG_ID}, 'agent-route-grace', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${graceThreadId}, ${USER_ID}, ${ORG_ID})`
    const post = (content: string) =>
      app.request("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ threadId: graceThreadId, content }),
      })
    const userMessages = () =>
      sql`SELECT content FROM kernel.messages WHERE thread_id = ${graceThreadId} AND author_type = 'user'`

    // A shutdown parked at its edge grace: the clock is ours, no sleep ends,
    // so the sequence neither stops a listener nor exits.
    const clock = { t: 0, now: () => clock.t, sleep: () => new Promise<void>(() => {}) }
    ShutdownTestAccess.configure({ clock, exit: () => {}, edgeGraceMs: 5_000 })
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      void beginShutdown("SIGTERM")
      setDraining(true)

      // 1 s in: the edge may still route here (its probe has not seen /readyz 503).
      clock.t = 1_000
      const accepted = await post("Sent while the edge still routes here")
      expect(accepted.status).toBe(200)
      await accepted.text()
      expect(await userMessages()).toHaveLength(1)

      // Past the grace the listener is stopped: a request on a kept-alive
      // connection is refused before anything is written.
      clock.t = 5_000
      const refused = await post("Sent after the edge grace")
      expect(refused.status).toBe(503)
      expect(refused.headers.get("retry-after")).toBe("1")
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("RESTARTING")
      expect(await userMessages()).toHaveLength(1)
    } finally {
      setDraining(false)
      ShutdownTestAccess.reset()
      if (ORIG_ANTHROPIC_KEY) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("reparents staged files onto the user message and injects an attachment note", async () => {
    const attachThreadId = "00000000-0000-4000-8000-000000ab0010"
    const sessionId = "00000000-0000-4000-8000-000000ab0011"
    const fileId = "00000000-0000-4000-8000-000000ab0012"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${attachThreadId}, ${ORG_ID}, 'agent-route-attach', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${attachThreadId}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.file_upload_sessions (id, org_id, created_by, target_app, target_entity_type) VALUES (${sessionId}, ${ORG_ID}, ${USER_ID}, 'kernel', 'message')`
    await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
              VALUES (${fileId}, ${ORG_ID}, 'kernel', 'file_upload_session', ${sessionId}, 'screenshot.png', 'image/png', 123, ${`test/agent-attach/${fileId}`}, ${USER_ID})`
    // Arm the real files_select RLS policy (normally rebuilt at boot) so the
    // session-parented file is visible to its owner under RLS.
    const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
    await rebuildFilesSelectPolicy()

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // Attachment-only send: empty content is allowed when fileIds are present.
        body: JSON.stringify({ threadId: attachThreadId, content: "", fileIds: [fileId] }),
      })
      expect(res.status).toBe(200)
      // Drain the SSE stream so the handler completes.
      await res.text()

      // The user message carries the attachment note (filename + file id) so
      // the agent can files_read / analyze_media the file.
      const userMsgs = await sql`
        SELECT id, content FROM kernel.messages
        WHERE thread_id = ${attachThreadId} AND author_type = 'user'
      `
      expect(userMsgs.length).toBe(1)
      const content = String(userMsgs[0].content)
      expect(content).toContain("Attached files")
      expect(content).toContain("screenshot.png")
      expect(content).toContain(fileId)

      // The staged file was reparented from the upload session onto the message.
      const fileRows = await sql`
        SELECT app, entity_type, entity_id FROM kernel.files WHERE id = ${fileId}
      `
      expect(fileRows.length).toBe(1)
      expect(fileRows[0].app).toBe("kernel")
      expect(fileRows[0].entity_type).toBe("message")
      expect(fileRows[0].entity_id).toBe(String(userMsgs[0].id))
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // ── Full attachment flow, end to end ──────────────────────────────────────
  // Reproduces the real prod flow at the API level: create an upload session,
  // upload REAL PNG bytes through the real presign/PUT/confirm endpoints
  // (the object store), POST /agent/chat with fileIds + a question, and prove the agent
  // TURN can execute the registered kernel__files_read and
  // kernel__analyze_media tools against that file — real registry, real
  // bridge, real RLS db, real storage. Only the provider stream is stubbed:
  // the stub *calls the actual tools* it is handed (the piece the earlier
  // tests missed — a red analyze_media in prod while every unit was green).
  it("agent turn executes files_read on a freshly attached PNG, then analyze_media runs inline on the tainted turn without storing the briefed analysis (real flow)", async () => {
    // Real 1x1 PNG bytes — sniffable by file-type and decodable by sharp.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )

    // Preconditions: object store reachable + a Gemini key for the live analyze call.
    // Mirror the media-analysis scenario suite's guard so environments without
    // the infra skip loudly instead of failing on unrelated grounds.
    const { putObject, deleteObject } = await import("~/infra/storage/object-storage")
    let objectstoreReachable = true
    const probeKey = `test/agent-chat-attach-probe-${crypto.randomUUID()}`
    try {
      await putObject({ key: probeKey, body: Buffer.from("x"), contentType: "text/plain" })
      await deleteObject(probeKey)
    } catch {
      objectstoreReachable = false
    }
    if (!objectstoreReachable) {
      console.warn("SKIP agent-chat attachment e2e: object store unreachable")
      return
    }

    const e2eThreadId = "00000000-0000-4000-8000-000000ab0020"
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${e2eThreadId}, ${ORG_ID}, 'agent-attach-e2e', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${e2eThreadId}, ${USER_ID}, ${ORG_ID})`
    // Pricing row for the vision model analyze_media bills against.
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
              VALUES ('google', 'gemini-flash-lite-latest', 'Gemini Flash Lite', '0.09000000', '0.35000000', 1000000, true, 'manual')
              ON CONFLICT DO NOTHING`
    const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
    await rebuildFilesSelectPolicy()

    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }

    // 1. Real upload flow: session → presigned PUT → confirm.
    const sessionRes = await app.request("/api/files/upload-sessions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ targetApp: "kernel", targetEntityType: "message" }),
    })
    expect(sessionRes.status).toBe(200)
    const session = ((await sessionRes.json()) as any).data as { id: string }

    const presignRes = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        app: "kernel",
        entityType: "file_upload_session",
        entityId: session.id,
        filename: "prod-screenshot.png",
        mimeType: "image/png",
        sizeBytes: pngBytes.length,
      }),
    })
    expect(presignRes.status).toBe(200)
    const presign = ((await presignRes.json()) as any).data as {
      uploadUrl: string
      uploadMode: "direct" | "relay"
      fileToken: string
    }

    // "relay" (the default unless the object store is browser-reachable) PUTs
    // through the API's own /api/file-relay route, which this in-process app
    // serves; "direct" PUTs to the presigned object-store URL.
    const put = { method: "PUT", headers: { "Content-Type": "image/png" }, body: pngBytes }
    const putRes =
      presign.uploadMode === "relay"
        ? await app.request(new URL(presign.uploadUrl).pathname, put)
        : await fetch(presign.uploadUrl, put)
    expect(putRes.ok).toBe(true)

    const confirmRes = await app.request("/api/files/confirm", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ fileToken: presign.fileToken }),
    })
    expect(confirmRes.status).toBe(200)
    const fileRow = ((await confirmRes.json()) as any).data as { id: string; filename: string }
    expect(fileRow.filename).toBe("prod-screenshot.png")

    // 2. Stub ONLY the provider: the stub executes the REAL tools it is handed
    //    (same execute closures the model would call), capturing their results.
    const captured: {
      parentAtToolTime?: { entity_type: string; entity_id: string }
      filesRead?: any
      analyze?: any
    } = {}
    function toolExecutingStream(options: any) {
      return {
        fullStream: (async function* () {
          // Parent AT TOOL TIME — proves the reparent ran BEFORE the turn
          // (a session-parented file here would mean the old race is back).
          const rows = await sql`
            SELECT entity_type, entity_id FROM kernel.files WHERE id = ${fileRow.id}`
          captured.parentAtToolTime = rows[0] as { entity_type: string; entity_id: string }

          captured.filesRead = await options.tools.kernel__files_read.execute(
            { fileId: fileRow.id },
            { toolCallId: "tc-1", messages: [] },
          )
          captured.analyze = await options.tools.kernel__analyze_media.execute(
            { fileId: fileRow.id, context: "What is in this screenshot?" },
            { toolCallId: "tc-2", messages: [] },
          )
          yield { type: "text-delta", text: "analyzed" }
          yield {
            type: "finish-step",
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
      } as never
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(toolExecutingStream as never)
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          threadId: e2eThreadId,
          content: "whats in that screenshot?",
          fileIds: [fileRow.id],
        }),
      })
      expect(res.status).toBe(200)
      const sse = await res.text()
      expect(sse).toContain("analyzed")

      // The file was already parented to the user message when the tools ran.
      expect(captured.parentAtToolTime?.entity_type).toBe("message")

      // files_read succeeded: real signed URL + metadata for the real bytes.
      expect(captured.filesRead?.error).toBeUndefined()
      expect(captured.filesRead?.fileId).toBe(fileRow.id)
      expect(captured.filesRead?.filename).toBe("prod-screenshot.png")
      expect(captured.filesRead?.downloadUrl).toBeTruthy()
      expect(captured.filesRead?.sizeBytes).toBe(pngBytes.length)

      // analyze_media RUNS on the tainted turn. files_read above is scoped, so the turn is
      // tainted (scope-taint.ts) by the time it is called, and it used to park for an
      // approver: it stored the analysis on the kernel.files row, which every reader of the
      // file sees, and the briefing (the agent's own text) can carry what the turn read. A
      // briefed analysis now comes back to the agent only and the row is left as it was, so
      // the tool is a read and nothing the turn read reaches the file's readers.
      expect(captured.analyze?.blocked).toBeUndefined()
      expect(captured.analyze?.status).not.toBe("pending_approval")
      if (LIVE_LLM) {
        expect(captured.analyze?.error).toBeUndefined()
        expect(typeof captured.analyze?.summary).toBe("string")
        expect(captured.analyze?.summary.length).toBeGreaterThan(0)
      } else {
        // This file runs managed, so media analysis goes to OpenRouter on the cell's key
        // (S31), a placeholder here: the call reached the provider, which is what this
        // proves, and the provider refused it.
        expect(String(captured.analyze?.error ?? captured.analyze)).toMatch(
          /API key|OpenRouter answered HTTP 401/,
        )
      }
      // Success or failure, a briefed call leaves the row as it was.
      const [analysedRow] = await sql`
        SELECT analysis_status, analysis_summary FROM kernel.files WHERE id = ${fileRow.id}`
      expect(analysedRow.analysis_status).toBeNull()
      expect(analysedRow.analysis_summary).toBeNull()

      // 3. The persisted user message exposes the attachment in the messages
      //    GET payload (what the UI renders after reload).
      const listRes = await app.request(`/api/threads/${e2eThreadId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(listRes.status).toBe(200)
      const messages = ((await listRes.json()) as any).data as Array<{
        authorType: string
        attachments?: Array<{ id: string; filename: string }>
      }>
      const userMsg = messages.find((m) => m.authorType === "user")
      expect(userMsg).toBeTruthy()
      expect(userMsg?.attachments?.length).toBe(1)
      expect(userMsg?.attachments?.[0].id).toBe(fileRow.id)
      expect(userMsg?.attachments?.[0].filename).toBe("prod-screenshot.png")
    } finally {
      AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
