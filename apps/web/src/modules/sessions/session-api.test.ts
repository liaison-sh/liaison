// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T06 (S4): starting a session from the app answers the row, or the
// refusal with its detail (candidates, offered models, nodes to confirm),
// read from the error body where the API client's error does not carry it.
import { describe, expect, it, vi } from "vitest"
import { createSession, listImportable, startImport } from "./session-api"

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("createSession", () => {
  it("201 answers the row and posts quietly", async () => {
    const rawPost = vi.fn(async () => response(201, { data: { id: "s1", title: "x" } }))
    const out = await createSession({ rawPost }, { prompt: "x", model: "m" })
    expect(out).toEqual({ ok: true, session: { id: "s1", title: "x" } })
    expect(rawPost).toHaveBeenCalledWith(
      "/me/node-sessions",
      { prompt: "x", model: "m" },
      { suppressGlobalError: true },
    )
  })

  it("a refusal carries its code and the detail beside it", async () => {
    const rawPost = vi.fn(async () =>
      response(422, { error: { code: "folder_unresolved", message: "m", candidates: ["a", "b"] } }),
    )
    expect(await createSession({ rawPost }, { prompt: "x", model: "m" })).toEqual({
      ok: false,
      code: "folder_unresolved",
      candidates: ["a", "b"],
    })
  })

  it("reads nodeIds from the body or from details", async () => {
    const rawPost = vi.fn(async () =>
      response(403, { error: { code: "confirmation_required", details: { nodeIds: ["n1"] } } }),
    )
    expect(await createSession({ rawPost }, { prompt: "x", model: "m" })).toEqual({
      ok: false,
      code: "confirmation_required",
      nodeIds: ["n1"],
    })
  })
})

// P3-T13 (S40, S42, D42): the import routes answer rows or a refusal; the
// generic 404 of an API older than wave 3 is `server_outdated`.
describe("importing a session", () => {
  const ROW = {
    candidateId: "c1",
    title: "Fix the build",
    firstPrompt: "fix it",
    folderName: "repo",
    cwdSubdir: "sub",
    branch: "main",
    lastModified: 1_760_000_000_000,
    createdAt: null,
    sizeBytes: 2048,
    from: "vscode",
    liveNow: false,
    inLiaison: null,
  }

  it("S40: the listing reads rows and truncated, asking quietly with the node and the query", async () => {
    const WT = { ...ROW, candidateId: "c2", worktreePath: "/tmp/repo-wt", cwdSubdir: "" }
    const rawGet = vi.fn(async () => response(200, { data: { rows: [ROW, WT], truncated: true } }))
    // D53: a row names the worktree it ran in, or null (an API row without one).
    expect(await listImportable({ rawGet }, "n1", "fix build")).toEqual({
      ok: true,
      rows: [{ ...ROW, worktreePath: null }, WT],
      truncated: true,
    })
    expect(rawGet).toHaveBeenCalledWith(
      "/me/node-session-imports?nodeId=n1&query=fix%20build",
      expect.objectContaining({ suppressGlobalError: true }),
    )
  })

  it("D42: the generic 404 of an older API is server_outdated; the route's own not_found is not", async () => {
    const old = vi.fn(async () =>
      response(404, { error: { code: "NOT_FOUND", message: "Not found" } }),
    )
    expect(await listImportable({ rawGet: old }, "n1")).toEqual({
      ok: false,
      code: "server_outdated",
    })
    const own = vi.fn(async () => response(404, { error: { code: "not_found", message: "x" } }))
    expect(await listImportable({ rawGet: own }, "n1")).toEqual({ ok: false, code: "not_found" })
  })

  it("S42: a start answers the session id, and already_in_liaison carries the holding session", async () => {
    const rawPost = vi.fn(async () => response(201, { data: { sessionId: "s9" } }))
    expect(await startImport({ rawPost }, { candidateId: "c1", mode: "follow" })).toEqual({
      ok: true,
      sessionId: "s9",
    })
    expect(rawPost).toHaveBeenCalledWith(
      "/me/node-session-imports",
      { candidateId: "c1", mode: "follow" },
      { suppressGlobalError: true },
    )
    const held = vi.fn(async () =>
      response(409, { error: { code: "already_in_liaison", message: "m", sessionId: "s1" } }),
    )
    expect(await startImport({ rawPost: held }, { candidateId: "c1", mode: "take_over" })).toEqual({
      ok: false,
      code: "already_in_liaison",
      sessionId: "s1",
    })
  })
})
