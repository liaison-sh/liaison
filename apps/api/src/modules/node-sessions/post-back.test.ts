// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T04 (S60, D36b, A38): a dispatch session that ends done by its own
// signal posts one agent message into the conversation that dispatched it,
// once per end. Real rows and the real routes; the status hook is the seam.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { setSessionSourceMessage } from "~/modules/node-sessions/store"
import { createNodeJob, type NodeJobSessionInput } from "~/modules/nodes/jobs"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { postBackContent, postBackSessionResult } from "./post-back"
import type { NodeSessionRow } from "./store"
import { onSessionStatus } from "./waiting-hook"

const HAIKU = "claude-haiku-4-5-20251001"
const SCOPE = "kernel:threads:read"
const PR = "https://github.com/example/repo/pull/7"

describe("S60: the finished session posts back into its thread (P2-T04)", () => {
  let owner: minimal.Session
  let agentId: string
  let threadId: string
  let off: () => void
  const pending: Promise<void>[] = []

  const call = (path: string, method: string, body?: unknown, nodeCredential?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async (res: Response) => (await res.json()) as any

  async function enable() {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
    const d = (await json(res)).data
    const node = { nodeId: d.node.id as string, credential: d.credential as string }
    const caps = await call(
      `/api/nodes/${node.nodeId}/capabilities`,
      "PUT",
      { sharedFolders: [], models: [{ id: HAIKU, label: "Haiku 4.5" }] },
      node.credential,
    )
    expect(caps.status).toBe(200)
    return node
  }

  /** A claimed run; a dispatch one has its card in the thread, as run_on_my_computer leaves it. */
  async function run(source: "dispatch" | "app", scopes: string[] = []) {
    const node = await enable()
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId: source === "app" ? null : threadId,
      source,
      prompt: "Fix the flaky test",
      sourceRequiredScopes: scopes,
      targetNodeId: node.nodeId,
      session: {
        source,
        configKind: "owner",
        model: HAIKU,
        level: "strict",
        title: "Fix the flaky test",
        ...(source === "dispatch" ? { sourceThreadId: threadId } : {}),
      } as NodeJobSessionInput,
    })
    const sessionId = job.sessionId as string
    let cardId: string | null = null
    if (source === "dispatch") {
      const [card] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, author_agent_id, content, required_scopes)
        VALUES (${owner.orgId}, ${threadId}, ${owner.userId}, 'agent', ${agentId}, 'Started', '{}')
        RETURNING id`
      cardId = card.id
      await setSessionSourceMessage(owner.orgId, sessionId, { threadId, messageId: card.id })
    }
    const claimed = await call(`/api/nodes/jobs/${job.id}/claim`, "POST", {}, node.credential)
    expect(claimed.status).toBe(200)
    const gen = (await json(claimed)).data.leaseGeneration as number
    return { node, job, gen, sessionId, cardId }
  }

  const result = (
    r: { job: { id: string }; gen: number; node: { credential: string } },
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    call(
      `/api/nodes/jobs/${r.job.id}/result`,
      "POST",
      { leaseGeneration: r.gen, text, ...extra },
      r.node.credential,
    )

  /** Every post-back the status hook started, settled. */
  async function settled() {
    await Promise.all(pending.splice(0))
  }

  async function posts() {
    return sql<
      Array<{
        id: string
        content: string
        metadata: Record<string, any>
        parent_message_id: string | null
        reply_root_id: string | null
        required_scopes: string[]
        author_type: string
      }>
    >`SELECT id, content, metadata, parent_message_id, reply_root_id, required_scopes, author_type
        FROM kernel.messages
       WHERE thread_id = ${threadId} AND metadata->>'kind' = 'node_session_result'
       ORDER BY created_at`
  }

  async function sessionRow(id: string): Promise<NodeSessionRow> {
    const { nodeSessions } = await import("~/db/schema/kernel")
    const { withPrivilegedDb } = await import("~/db/privileged")
    const { eq } = await import("drizzle-orm")
    const [row] = await withPrivilegedDb(owner.orgId, "test-post-back-row", (tx) =>
      tx.select().from(nodeSessions).where(eq(nodeSessions.id, id)),
    )
    return row as NodeSessionRow
  }

  beforeAll(async () => {
    await acquireTestLock()
    owner = await minimal.session((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@pb-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    // English for the owner, so the fixed lines are known.
    await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${owner.userId}, 'en')
      ON CONFLICT (user_id) DO UPDATE SET language = 'en'`
    off = onSessionStatus((row, change) => {
      pending.push(postBackSessionResult(row, change))
    })
  })

  beforeEach(async () => {
    await settled()
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    threadId = await minimal.thread(owner.orgId, owner.userId)
  })

  afterAll(async () => {
    off?.()
    await settled()
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${owner.userId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("S60: a dispatch session ending done by mark_done posts one agent message in its source thread with the summary and the PR link fenced", async () => {
    const r = await run("dispatch")
    const res = await result(r, "Fixed it.", {
      completion: { by: "session", summary: "Fixed the flaky test.", prUrl: PR },
    })
    expect(res.status).toBe(201)
    await settled()
    const [nodeRow] = await sql<{ name: string }[]>`
      SELECT name FROM kernel.nodes WHERE id = ${r.node.nodeId}`
    const out = await posts()
    expect(out).toHaveLength(1)
    expect(out[0].author_type).toBe("agent")
    expect(out[0].content).toBe(
      [
        `Finished on ${nodeRow.name}: Fix the flaky test.`,
        "The session says: <session-data>Fixed the flaky test.</session-data>",
        // The link is the session's word too: inside the fence (D43 F5).
        `Pull request: <session-data>${PR}</session-data>`,
      ].join("\n"),
    )
    expect(out[0].metadata.kind).toBe("node_session_result")
    expect(out[0].metadata.sessionId).toBe(r.sessionId)
    expect(out[0].metadata.prUrl).toBe(PR)
    expect(out[0].parent_message_id).toBe(r.cardId)
    expect(out[0].reply_root_id).toBeNull()
  })

  it("S60: the same transition twice posts once", async () => {
    const r = await run("dispatch")
    await result(r, "Done.", { completion: { by: "session", summary: "Done." } })
    await settled()
    const row = await sessionRow(r.sessionId)
    await postBackSessionResult(row, { from: "running", to: "done", cause: "node" })
    expect(await posts()).toHaveLength(1)
  })

  it("S60: two concurrent transitions for the same end (Promise.all) post once", async () => {
    const r = await run("dispatch")
    // The session ends done without the hook seeing it (straight in the row).
    await sql`UPDATE kernel.node_sessions SET status = 'done', ended_at = now(),
                result_summary = 'Done.' WHERE id = ${r.sessionId}`
    const row = await sessionRow(r.sessionId)
    const change = { from: "running", to: "done", cause: "node" } as const
    await Promise.all([postBackSessionResult(row, change), postBackSessionResult(row, change)])
    expect(await posts()).toHaveLength(1)
  })

  it("S60: a session reopened and ended done again posts a second message", async () => {
    const r = await run("dispatch")
    await result(r, "Done.", { completion: { by: "session", summary: "First pass." } })
    await settled()
    expect(await posts()).toHaveLength(1)
    // Reopened (D1) and ended again: a new end.
    await sql`UPDATE kernel.node_sessions SET status = 'done', result_summary = 'Second pass.',
                ended_at = ended_at + interval '1 minute' WHERE id = ${r.sessionId}`
    const row = await sessionRow(r.sessionId)
    await postBackSessionResult(row, { from: "running", to: "done", cause: "node" })
    const out = await posts()
    expect(out).toHaveLength(2)
    expect(out[1].content).toContain("<session-data>Second pass.</session-data>")
  })

  it("S60: owner Mark done posts nothing", async () => {
    const r = await run("dispatch")
    await result(r, "Which branch?", {
      completion: { by: "needs_you", reason: "Which branch?" },
    })
    await settled()
    const res = await call(`/api/me/node-sessions/${r.sessionId}/commands`, "POST", {
      type: "mark_done",
      payload: { summary: "Merged by hand." },
    })
    expect(res.status).toBe(201)
    await settled()
    expect((await sessionRow(r.sessionId)).status).toBe("done")
    expect(await posts()).toHaveLength(0)
  })

  it("A45: a change caused by a follow (cause follow) posts nothing", async () => {
    const r = await run("dispatch")
    await result(r, "Which branch?", {
      completion: { by: "needs_you", reason: "Which branch?" },
    })
    await settled()
    await sql`UPDATE kernel.node_sessions SET status = 'done' WHERE id = ${r.sessionId}`
    const row = await sessionRow(r.sessionId)
    await postBackSessionResult(row, {
      from: "needs_you",
      to: "done",
      cause: "follow",
    } as Parameters<typeof postBackSessionResult>[1])
    expect(await posts()).toHaveLength(0)
  })

  it("S60: an app session (no source thread) posts nothing", async () => {
    const r = await run("app")
    const res = await result(r, "Done in the app.", { completion: { by: "session" } })
    expect(res.status).toBe(201)
    await settled()
    expect((await sessionRow(r.sessionId)).status).toBe("done")
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE org_id = ${owner.orgId} AND metadata->>'sessionId' = ${r.sessionId}`
    expect(n).toBe(0)
  })

  it("S60: needs_you and failed post nothing", async () => {
    const a = await run("dispatch")
    await result(a, "Which name?", { completion: { by: "needs_you", reason: "Which name?" } })
    await settled()
    expect((await sessionRow(a.sessionId)).status).toBe("needs_you")
    await sql`UPDATE kernel.node_sessions SET status = 'failed' WHERE id = ${a.sessionId}`
    const failed = await sessionRow(a.sessionId)
    await postBackSessionResult(failed, { from: "running", to: "failed", cause: "node" })
    expect(await posts()).toHaveLength(0)
  })

  it("S60: a summary '<b>x</b> [l](javascript:alert(1))' is posted as clipped plain text inside session-data", async () => {
    const r = await run("dispatch")
    const summary = `<b>x</b> [l](javascript:alert(1)) ${"y".repeat(260)}`
    expect(summary.length).toBeLessThanOrEqual(300)
    await result(r, "Done.", { completion: { by: "session", summary } })
    await settled()
    const [post] = await posts()
    expect(post.content.split("\n")[1]).toBe(
      `The session says: <session-data>x l) ${"y".repeat(260)}</session-data>`,
    )
    expect(post.content).not.toContain("<b>")
    expect(post.content).not.toContain("javascript")
    expect(post.content).not.toContain("Pull request")
    // Words longer than the row may hold today are still clipped to 300.
    const said = postBackContent("en", {
      nodeName: "Mac",
      title: "T",
      summary: `<b>x</b> ${"z".repeat(400)}`,
      prUrl: "javascript:alert(1)",
    }).split("\n")
    expect(said).toHaveLength(2)
    const inside = said[1].slice(
      "The session says: <session-data>".length,
      -"</session-data>".length,
    )
    expect(inside.length).toBe(300)
    expect(inside.endsWith("…")).toBe(true)
  })

  it("W2-D8: the words keep everything but the link the PR line carries, and the lead line never ends '..'", () => {
    const lines = postBackContent("en", {
      nodeName: "Mac",
      title: "Fix the failing test on your own, don't ask me anything.",
      summary: `Fixed cartTotal (src/cart.js) adding price + quantity instead of multiplying; npm test now 3/3 passing. PR: ${PR}`,
      prUrl: PR,
    }).split("\n")
    expect(lines).toEqual([
      "Finished on Mac: Fix the failing test on your own, don't ask me anything.",
      "The session says: <session-data>Fixed cartTotal (src/cart.js) adding price + quantity instead of multiplying; npm test now 3/3 passing.</session-data>",
      `Pull request: <session-data>${PR}</session-data>`,
    ])
  })

  it("W2-D8 review: a sentence that ends on 'link' or 'PR' with no colon is kept whole", () => {
    for (const summary of ["Fixed the broken link", "Rebased and reopened the PR"]) {
      const lines = postBackContent("en", {
        nodeName: "Mac",
        title: "Fix it",
        summary,
        prUrl: null,
      }).split("\n")
      expect(lines[1]).toBe(`The session says: <session-data>${summary}</session-data>`)
    }
  })

  it("S60: the message requires the job's source scopes", async () => {
    const r = await run("dispatch", [SCOPE])
    await result(r, "Done.", { completion: { by: "session", summary: "Done." } })
    await settled()
    const [post] = await posts()
    expect(post.required_scopes).toEqual([SCOPE])
  })
})
