// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T15 (spec-protocol.md, client reads): the owner's session list by group,
// one row, and its events after a seq, read through the owner's own RLS.
// Another user and an org admin get 404; no answer carries the folder path.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { decodeJwt } from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeSessions } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { fanOut } from "./store"

const SECRET_PATH = "/Users/someone/private/code"

describe("node session client reads (P1-T15)", () => {
  let admin: minimal.Session
  let owner: minimal.Session
  let other: minimal.Session
  let agentId: string

  const get = (p: string, session = owner) =>
    app.request(p, { headers: { Authorization: `Bearer ${session.bearer}` } })
  const patch = (p: string, body: unknown, session = owner) =>
    app.request(p, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function seed(
    status: string,
    over: { endedDaysAgo?: number; updatedAt?: string; title?: string } = {},
  ): Promise<string> {
    const ended =
      over.endedDaysAgo === undefined
        ? null
        : new Date(Date.now() - over.endedDaysAgo * 86_400_000).toISOString()
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, agent_id, source, config_kind, title, prompt, model, level,
         status, folder_name, folder_path, ended_at, updated_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'app', 'owner',
              ${over.title ?? status}, 'Fix the build', 'claude-haiku-4-5', 'strict', ${status},
              'code', ${SECRET_PATH}, ${ended}, ${over.updatedAt ?? new Date().toISOString()})
      RETURNING id`
    return row.id
  }

  async function seedEvents(sessionId: string, n: number) {
    for (let seq = 1; seq <= n; seq++) {
      await sql`
        INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload, truncated, full_bytes)
        VALUES (${sessionId}, ${seq}, now(), 'assistant_text', ${JSON.stringify({ text: `step ${seq}` })}::jsonb,
                ${seq === 2}, ${seq === 2 ? 70_000 : null})`
    }
    await sql`UPDATE kernel.node_sessions SET last_seq = ${n} WHERE id = ${sessionId}`
  }

  async function all(group: string, session = owner, v2 = false) {
    const ids: string[] = []
    let cursor: string | null = null
    const pages: number[] = []
    do {
      const qs: string = (cursor ? `&cursor=${cursor}` : "") + (v2 ? "&v=2" : "")
      const res = await get(`/api/me/node-sessions?group=${group}${qs}`, session)
      expect(res.status).toBe(200)
      const d = await data(res)
      pages.push(d.sessions.length)
      ids.push(...d.sessions.map((s: { id: string }) => s.id))
      cursor = d.nextCursor
    } while (cursor)
    return { ids, pages }
  }

  beforeAll(async () => {
    await acquireTestLock()
    admin = await minimal.adminSession((await createTestOrg()).id)
    owner = await minimal.session(admin.orgId)
    other = await minimal.session(admin.orgId)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@rm-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_sessions WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("each status lands in its group; a session ended 31 days ago is in older", async () => {
    const waiting = await seed("waiting")
    const queued = await seed("queued")
    const running = await seed("running")
    const paused = await seed("paused")
    const done = await seed("done", { endedDaysAgo: 1 })
    const stopped = await seed("stopped", { endedDaysAgo: 29 })
    const failed = await seed("failed", { endedDaysAgo: 2 })
    const old = await seed("done", { endedDaysAgo: 31 })
    const oldFailed = await seed("failed", { endedDaysAgo: 90 })

    expect((await all("waiting")).ids).toEqual([waiting])
    expect(new Set((await all("running")).ids)).toEqual(new Set([queued, running, paused]))
    expect(new Set((await all("done")).ids)).toEqual(new Set([done, stopped, failed]))
    expect(new Set((await all("older")).ids)).toEqual(new Set([old, oldFailed]))
    // Newest end first.
    expect((await all("done")).ids).toEqual([done, failed, stopped])

    const bad = await get("/api/me/node-sessions?group=everything")
    expect(bad.status).toBe(400)
  })

  it("pages of 50 with a stable cursor", async () => {
    // 120 live sessions, many sharing one updated_at to the microsecond.
    const same = new Date().toISOString()
    const seeded = new Set<string>()
    for (let i = 0; i < 120; i++) {
      seeded.add(
        await seed("running", {
          updatedAt: i % 3 === 0 ? same : new Date(Date.now() - i * 1000).toISOString(),
        }),
      )
    }
    const { ids, pages } = await all("running")
    expect(pages).toEqual([50, 50, 20])
    expect(ids.length).toBe(120)
    expect(new Set(ids)).toEqual(seeded)
    const garbage = await get("/api/me/node-sessions?group=running&cursor=bm90LWpzb24")
    expect(garbage.status).toBe(400)
  })

  it("events after 3 return seq 4… in order", async () => {
    const id = await seed("running")
    await seedEvents(id, 7)
    const res = await get(`/api/me/node-sessions/${id}/events?after=3`)
    expect(res.status).toBe(200)
    const d = await data(res)
    expect(d.lastSeq).toBe(7)
    expect(d.events.map((e: { seq: number }) => e.seq)).toEqual([4, 5, 6, 7])
    expect(d.events[0]).toMatchObject({ type: "assistant_text", payload: { text: "step 4" } })
    const limited = await data(await get(`/api/me/node-sessions/${id}/events?limit=2`))
    expect(limited.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2])
    const tooMany = await get(`/api/me/node-sessions/${id}/events?limit=501`)
    expect(tooMany.status).toBe(400)
  })

  /** 1 top, 2-4 subagent tu_a, 5 top, 6 subagent tu_b, 7 subagent tu_a. */
  async function seedMixed(sessionId: string) {
    const parents = [null, "tu_a", "tu_a", "tu_a", null, "tu_b", "tu_a"]
    for (let i = 0; i < parents.length; i++) {
      await sql`
        INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload, parent_tool_use_id)
        VALUES (${sessionId}, ${i + 1}, now(), 'assistant_text', ${JSON.stringify({ text: `step ${i + 1}` })}::jsonb,
                ${parents[i]})`
    }
    await sql`UPDATE kernel.node_sessions SET last_seq = ${parents.length} WHERE id = ${sessionId}`
  }
  const seqs = (d: { events: { seq: number }[] }) => d.events.map((e) => e.seq)

  it("S53: scope=top returns top-level events only and `through` covers the subagent tail; parent=<id> returns that subagent's events, paged; the plain read stays complete for older clients", async () => {
    const id = await seed("running")
    await seedMixed(id)
    const base = `/api/me/node-sessions/${id}/events`

    const top = await data(await get(`${base}?scope=top`))
    expect(seqs(top)).toEqual([1, 5])
    expect(top.events.every((e: { parentToolUseId?: string }) => !e.parentToolUseId)).toBe(true)
    // Everything up to the session's last seq was read: the client moves past the subagents' 6 and 7.
    expect(top.through).toBe(7)
    expect(top.lastSeq).toBe(7)
    // A full page stops `through` at its last event, so nothing after it is skipped.
    const page = await data(await get(`${base}?scope=top&limit=1`))
    expect([seqs(page), page.through]).toEqual([[1], 1])

    const a = await data(await get(`${base}?parent=tu_a`))
    expect(seqs(a)).toEqual([2, 3, 4, 7])
    expect(a.events.every((e: { parentToolUseId?: string }) => e.parentToolUseId === "tu_a")).toBe(
      true,
    )
    expect(a.through).toBe(7)
    const aPaged = await data(await get(`${base}?parent=tu_a&after=2&limit=2`))
    expect([seqs(aPaged), aPaged.through]).toEqual([[3, 4], 4])
    expect(seqs(await data(await get(`${base}?parent=tu_b`)))).toEqual([6])
    expect(seqs(await data(await get(`${base}?parent=tu_none`)))).toEqual([])

    // An older client sends neither: it still gets every event, contiguous.
    expect(seqs(await data(await get(base)))).toEqual([1, 2, 3, 4, 5, 6, 7])

    // Owner-only: another user and an admin get 404 for a subagent's events too.
    for (const session of [other, admin]) {
      expect((await get(`${base}?parent=tu_a`, session)).status).toBe(404)
    }
    expect((await get(`${base}?parent=${"x".repeat(201)}`)).status).toBe(400)
  })

  it("S53 (D29): files-changed sums every applied edit, a subagent's included, with paths relative to the session; hunks only when asked; owner-only", async () => {
    const id = await seed("running")
    const add = async (seq: number, type: string, payload: unknown, parent: string | null = null) =>
      sql`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload, parent_tool_use_id)
          VALUES (${id}, ${seq}, now(), ${type}, ${JSON.stringify(payload)}::jsonb, ${parent})`
    await add(1, "system", { subtype: "start", data: { cwd: `${SECRET_PATH}/repo` } })
    await add(2, "tool_call", {
      id: "e1",
      name: "Edit",
      input: { file_path: `${SECRET_PATH}/repo/a.ts`, old_string: "x", new_string: "y\nz" },
    })
    await add(3, "tool_result", { id: "e1", isError: false, output: "ok" })
    await add(4, "tool_call", { id: "tu_a", name: "Agent", input: { description: "d" } })
    await add(
      5,
      "tool_call",
      {
        id: "w1",
        name: "Write",
        input: { file_path: `${SECRET_PATH}/repo/b.ts`, content: "1\n2" },
      },
      "tu_a",
    )
    await add(6, "tool_result", { id: "w1", isError: false, output: "ok" }, "tu_a")
    // Refused: changed nothing.
    await add(7, "tool_call", {
      id: "e2",
      name: "Edit",
      input: { file_path: `${SECRET_PATH}/repo/c.ts`, old_string: "a", new_string: "b" },
    })
    await add(8, "tool_result", { id: "e2", isError: true, output: "denied" })
    await sql`UPDATE kernel.node_sessions SET last_seq = 8 WHERE id = ${id}`

    const res = await get(`/api/me/node-sessions/${id}/files-changed`)
    expect(res.status).toBe(200)
    const text = await res.clone().text()
    expect(text).not.toContain(SECRET_PATH)
    const d = await data(res)
    expect(d.files).toEqual([
      { path: "a.ts", added: 2, removed: 1, cut: false },
      { path: "b.ts", added: 2, removed: 0, cut: false },
    ])
    const full = await data(await get(`/api/me/node-sessions/${id}/files-changed?hunks=1`))
    expect(full.files[1].hunks).toEqual([
      [
        { type: "add", text: "1" },
        { type: "add", text: "2" },
      ],
    ])
    for (const session of [other, admin]) {
      expect((await get(`/api/me/node-sessions/${id}/files-changed`, session)).status).toBe(404)
    }
  })

  it("D31d: files-changed is computed once per (session, last seq): a read at the same seq reuses it, hunks included, and a new seq recomputes; the cache never answers another user", async () => {
    const id = await seed("running")
    const edit = (newString: string) => ({
      id: "e1",
      name: "Edit",
      input: { file_path: `${SECRET_PATH}/repo/a.ts`, old_string: "x", new_string: newString },
    })
    await sql`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload) VALUES
      (${id}, 1, now(), 'system', ${JSON.stringify({ subtype: "start", data: { cwd: `${SECRET_PATH}/repo` } })}::jsonb),
      (${id}, 2, now(), 'tool_call', ${JSON.stringify(edit("y"))}::jsonb),
      (${id}, 3, now(), 'tool_result', ${JSON.stringify({ id: "e1", isError: false, output: "ok" })}::jsonb)`
    await sql`UPDATE kernel.node_sessions SET last_seq = 3 WHERE id = ${id}`
    const url = `/api/me/node-sessions/${id}/files-changed`
    const counts = async (path = url) =>
      ((await data(await get(path))).files as Array<{ added: number; removed: number }>).map(
        (f) => [f.added, f.removed],
      )
    expect(await counts()).toEqual([[1, 1]])
    // An edit lands before the row's seq moves: the same seq reads nothing again.
    await sql`INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload) VALUES
      (${id}, 4, now(), 'tool_call', ${JSON.stringify({ ...edit("p\nq"), id: "e2" })}::jsonb),
      (${id}, 5, now(), 'tool_result', ${JSON.stringify({ id: "e2", isError: false, output: "ok" })}::jsonb)`
    expect(await counts()).toEqual([[1, 1]])
    expect(await counts(`${url}?hunks=1`)).toEqual([[1, 1]])
    expect((await get(url, other)).status).toBe(404)
    // The session moved on: computed again.
    await sql`UPDATE kernel.node_sessions SET last_seq = 5 WHERE id = ${id}`
    expect(await counts()).toEqual([[3, 2]])
  })

  it("a truncated event reads back with truncated and fullBytes", async () => {
    const id = await seed("running")
    await seedEvents(id, 3)
    const d = await data(await get(`/api/me/node-sessions/${id}/events`))
    expect(d.events[1]).toMatchObject({ seq: 2, truncated: true, fullBytes: 70_000 })
    expect(d.events[0].truncated).toBeUndefined()
    expect(d.events[0].fullBytes).toBeUndefined()
  })

  it("S56: before=<seq> reads the last `limit` events below a seq, in seq order, in its scope; owner-only", async () => {
    const id = await seed("running")
    await seedMixed(id)
    const base = `/api/me/node-sessions/${id}/events`
    // The client's "load earlier": the main thread below the oldest seq it holds.
    const top = await data(await get(`${base}?scope=top&before=6`))
    expect(seqs(top)).toEqual([1, 5])
    expect(top.lastSeq).toBe(7)
    // `limit` keeps the newest below `before`, still in seq order.
    expect(seqs(await data(await get(`${base}?before=6&limit=2`)))).toEqual([4, 5])
    expect(seqs(await data(await get(`${base}?scope=top&before=5&limit=1`)))).toEqual([1])
    expect(seqs(await data(await get(`${base}?parent=tu_a&before=7`)))).toEqual([2, 3, 4])
    expect(seqs(await data(await get(`${base}?before=1`)))).toEqual([])
    // One event by seq, again (an elided output): the range read after seq-1, limit 1.
    expect(seqs(await data(await get(`${base}?scope=top&after=4&limit=1`)))).toEqual([5])
    // A read is one direction.
    expect((await get(`${base}?after=2&before=6`)).status).toBe(400)
    for (const session of [other, admin]) {
      expect((await get(`${base}?scope=top&before=6`, session)).status).toBe(404)
    }
  })

  it("another user and an admin get 404 for the row and the events", async () => {
    const id = await seed("running")
    await seedEvents(id, 2)
    for (const session of [other, admin]) {
      expect((await get(`/api/me/node-sessions/${id}`, session)).status).toBe(404)
      expect((await get(`/api/me/node-sessions/${id}/events`, session)).status).toBe(404)
      expect((await all("running", session)).ids).toEqual([])
    }
    const mine = await get(`/api/me/node-sessions/${id}`)
    expect(mine.status).toBe(200)
    expect((await data(mine)).id).toBe(id)
  })

  it("no response carries folder_path", async () => {
    const id = await seed("running")
    await seedEvents(id, 1)
    for (const p of [
      "/api/me/node-sessions?group=running",
      `/api/me/node-sessions/${id}`,
      `/api/me/node-sessions/${id}/events`,
    ]) {
      const res = await get(p)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(SECRET_PATH)
      expect(text).not.toContain("folderPath")
    }
    const row = await data(await get(`/api/me/node-sessions/${id}`))
    expect(row.folderName).toBe("code")
  })

  it("S9: group needs_you lists waiting and needs_you, oldest first; group failed lists failed and stopped", async () => {
    const day = 86_400_000
    const oldestNeed = await seed("needs_you", { endedDaysAgo: 3 })
    const waiting = await seed("waiting", {
      updatedAt: new Date(Date.now() - 2 * day).toISOString(),
    })
    const newestNeed = await seed("needs_you", { endedDaysAgo: 1 })
    const done = await seed("done", { endedDaysAgo: 1 })
    const failed = await seed("failed", { endedDaysAgo: 1 })
    const stopped = await seed("stopped", { endedDaysAgo: 2 })
    const oldNeed = await seed("needs_you", { endedDaysAgo: 40 })
    await seed("running")

    expect((await all("needs_you")).ids).toEqual([oldestNeed, waiting, newestNeed])
    expect((await all("done")).ids).toContain(done)
    expect((await all("failed")).ids).toEqual([failed, stopped])
    expect((await all("older")).ids).toEqual([oldNeed])
  })

  it("S9: the old group id waiting still answers", async () => {
    const waiting = await seed("waiting")
    const need = await seed("needs_you", { endedDaysAgo: 1 })
    const done = await seed("done", { endedDaysAgo: 1 })
    const stopped = await seed("stopped", { endedDaysAgo: 2 })
    const failed = await seed("failed", { endedDaysAgo: 3 })
    expect(new Set((await all("waiting")).ids)).toEqual(new Set([waiting, need]))
    // An older client's `done` still holds done, failed and stopped (S9); its
    // needs_you rows come in `waiting`.
    expect(new Set((await all("done")).ids)).toEqual(new Set([done, stopped, failed]))
  })

  it("S9: group done with v=2 lists done only, newest end first", async () => {
    const need = await seed("needs_you", { endedDaysAgo: 1 })
    const older = await seed("done", { endedDaysAgo: 3 })
    const newer = await seed("done", { endedDaysAgo: 1 })
    await seed("failed", { endedDaysAgo: 1 })
    await seed("stopped", { endedDaysAgo: 2 })
    await seed("done", { endedDaysAgo: 40 })
    expect((await all("done", owner, true)).ids).toEqual([newer, older])
    expect((await all("done", owner, true)).ids).not.toContain(need)
    expect((await get("/api/me/node-sessions?group=done&v=3")).status).toBe(400)
  })

  it("S9: a needs_you row is served with status waiting and state needs_you in GET, list and the node_session frame", async () => {
    const id = await seed("needs_you", { endedDaysAgo: 1 })
    const one = await data(await get(`/api/me/node-sessions/${id}`))
    expect(one.status).toBe("waiting")
    expect(one.state).toBe("needs_you")
    expect(one.muted).toBe(false)
    expect(one.effort).toBeNull()
    const list = await data(await get("/api/me/node-sessions?group=needs_you"))
    expect(list.sessions.map((r: any) => [r.id, r.status, r.state])).toEqual([
      [id, "waiting", "needs_you"],
    ])
    const running = await seed("running")
    const plain = await data(await get(`/api/me/node-sessions/${running}`))
    expect([plain.status, plain.state]).toEqual(["running", "running"])

    const [loaded] = await withPrivilegedDb(owner.orgId, "test:frame", (tx) =>
      tx.select().from(nodeSessions).where(eq(nodeSessions.id, id)),
    )
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      await fanOut(loaded, [])
      const frame = spy.mock.calls
        .map((c) => c[0] as { entity: string; data: Record<string, unknown> })
        .find((e) => e.entity === "node_session")
      expect(frame?.data.status).toBe("waiting")
      expect(frame?.data.state).toBe("needs_you")
    } finally {
      spy.mockRestore()
    }
  })

  it("S14: PATCH muted by another user is 404", async () => {
    const id = await seed("running")
    for (const session of [other, admin]) {
      expect((await patch(`/api/me/node-sessions/${id}`, { muted: true }, session)).status).toBe(
        404,
      )
    }
    const [still] = await sql<Array<{ muted: boolean }>>`
      SELECT muted FROM kernel.node_sessions WHERE id = ${id}`
    expect(still.muted).toBe(false)
    const mine = await patch(`/api/me/node-sessions/${id}`, { muted: true })
    expect(mine.status).toBe(200)
    expect((await data(mine)).muted).toBe(true)
    expect((await data(await get(`/api/me/node-sessions/${id}`))).muted).toBe(true)
    expect((await patch(`/api/me/node-sessions/${id}`, { muted: "yes" })).status).toBe(400)
  })

  it("S14: a restricted device session cannot mute a session", async () => {
    const id = await seed("running")
    const claims = decodeJwt(owner.bearer) as Record<string, any>
    const restricted = await signAccessToken(
      {
        userId: claims.userId,
        orgId: claims.orgId,
        name: claims.name,
        authVersion: claims.authVersion,
        permissionVersion: claims.permissionVersion,
        roles: claims.roles,
        scopes: claims.scopes,
        restricted: true,
      },
      env.JWT_SECRET,
      600,
    )
    const res = await patch(
      `/api/me/node-sessions/${id}`,
      { muted: true },
      {
        ...owner,
        bearer: restricted,
      },
    )
    expect(res.status).toBe(403)
    const [still] = await sql<Array<{ muted: boolean }>>`
      SELECT muted FROM kernel.node_sessions WHERE id = ${id}`
    expect(still.muted).toBe(false)
  })

  /** An import row (A51's shape: the four import columns set). */
  async function seedImport(status = "needs_you"): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_sessions
        (org_id, owner_user_id, agent_id, source, config_kind, title, prompt, model, level,
         status, folder_name, folder_path, finish_with, autonomy, import_mode,
         import_sdk_session_id, sdk_session_id, import_from, cwd_subdir, ended_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, 'import', 'owner', 'Imported',
              'Fix the build', 'claude-haiku-4-5', 'strict', ${status}, 'code', ${SECRET_PATH},
              'none', 'guided', 'follow', ${crypto.randomUUID()}, NULL, 'vscode', 'app', now())
      RETURNING id`
    return row.id
  }
  const del = (p: string, session = owner) =>
    app.request(p, { method: "DELETE", headers: { Authorization: `Bearer ${session.bearer}` } })

  it("A49: DELETE of another user's import → 404, row intact", async () => {
    const id = await seedImport()
    expect((await del(`/api/me/node-sessions/${id}`, other)).status).toBe(404)
    expect((await del(`/api/me/node-sessions/${id}`, admin)).status).toBe(404)
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.node_sessions WHERE id = ${id}`
    expect(n).toBe(1)
  })

  it("A49: DELETE of a dispatch session → 409 not_import", async () => {
    const id = await seed("done", { endedDaysAgo: 1 })
    const res = await del(`/api/me/node-sessions/${id}`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe("not_import")
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.node_sessions WHERE id = ${id}`
    expect(n).toBe(1)
  })

  it("A49: DELETE of an ended import removes it; a second DELETE is 404", async () => {
    const id = await seedImport()
    const res = await del(`/api/me/node-sessions/${id}`)
    expect(res.status).toBe(200)
    expect(await data(res)).toEqual({ id, deleted: true })
    expect((await get(`/api/me/node-sessions/${id}`)).status).toBe(404)
    expect((await del(`/api/me/node-sessions/${id}`)).status).toBe(404)
  })
})
