// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T11 (S4, D24, D32, D42): New session from the app. The agent defaults to
// the personal agent and the level to its profile; a raise, or Open, opens the
// in-app confirmation first and the start carries its id; Cancel creates
// nothing; 403 confirmation_required asks again; a refusal is said in words.
import type { NodeLevel } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { resetNodesStore, setNodesStoreApi } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import { NewSessionDialog } from "./NewSessionDialog"

const b64 = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

function signInAs(userId: string): void {
  setTokens(
    `${b64({ alg: "none" })}.${b64({
      userId,
      orgId: "org-1",
      name: userId,
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.x`,
  )
}

function node(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "n1",
    name: "Studio Mac",
    enabled: true,
    online: true,
    lastSeenAt: "2026-10-13T10:00:00.000Z",
    os: "macos",
    appVersion: "0.1.20",
    deviceId: "d1",
    queue: { queued: 0, running: 0 },
    sharedFolderNames: ["liaison-walk-sample"],
    models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
    levelPins: [],
    ...over,
  }
}

const SESSION_ROW = {
  id: "s-new",
  ownerUserId: "me",
  nodeId: "n1",
  jobId: "j1",
  agentId: "agent-personal",
  source: "app",
  configKind: "owner",
  sourceThreadId: null,
  sourceMessageId: null,
  title: "Fix it",
  folderName: null,
  repo: null,
  branch: null,
  pushed: false,
  prUrl: null,
  model: "claude-haiku-4-5",
  level: "strict",
  status: "queued",
  pendingCount: 0,
  waitingReason: null,
  claudeCode: null,
  lastSeq: 0,
  latestActivity: null,
  tokensIn: 0,
  tokensOut: 0,
  resultSummary: null,
  error: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  startedAt: null,
  endedAt: null,
  updatedAt: "2026-10-13T10:00:00.000Z",
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

interface Setup {
  nodes?: NodeSummary[]
  profiles?: Array<{ agentId: string; level: NodeLevel }>
  starts?: Response[]
}

function setup(opts: Setup = {}) {
  const nodes = opts.nodes ?? [node()]
  const profiles = (opts.profiles ?? []).map((p) => ({
    id: `p-${p.agentId}`,
    agentId: p.agentId,
    agentName: null,
    level: p.level,
    liaisonTools: true,
    updatedAt: "2026-10-13T10:00:00.000Z",
    nodes: [],
  }))
  const get = vi.fn(async (path: string) => {
    if (path === "/nodes/me") return { nodes }
    if (path === "/nodes/me/profiles") return profiles
    if (path === "/agents")
      return [
        {
          id: "agent-personal",
          handle: "@me",
          displayName: "Personal agent",
          kind: "personal",
          ownerUserId: "me",
        },
        { id: "agent-data", handle: "@data", displayName: "Data", kind: "role" },
      ]
    throw new Error(`unexpected GET ${path}`)
  })
  let n = 0
  const post = vi.fn(async (_path: string, body: { nodeId: string }) => ({
    confirmationId: `00000000-0000-4000-8000-00000000000${++n}`,
    expiresAt: "2026-10-13T11:00:00.000Z",
    nodeId: body.nodeId,
  }))
  const starts = [...(opts.starts ?? [json(201, { data: SESSION_ROW })])]
  const rawPost = vi.fn(
    async (_path: string, _body: unknown, _init?: unknown) =>
      starts.shift() ?? json(201, { data: SESSION_ROW }),
  )
  const api = { get, post, rawPost, put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never
  setNodesStoreApi(() => api)
  const onOpenChange = vi.fn()
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <NewSessionDialog open onOpenChange={onOpenChange} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { get, post, rawPost, onOpenChange }
}

async function ready() {
  await waitFor(() =>
    expect((screen.getByTestId("new-session-agent") as HTMLSelectElement).value).toBe(
      "agent-personal",
    ),
  )
  await waitFor(() =>
    expect((screen.getByTestId("new-session-model") as HTMLSelectElement).value).toBe(
      "claude-haiku-4-5",
    ),
  )
}

function type(prompt: string) {
  fireEvent.input(screen.getByTestId("new-session-prompt"), { target: { value: prompt } })
}

function pickLevel(level: NodeLevel) {
  fireEvent.change(screen.getByTestId("new-session-level"), { target: { value: level } })
}

beforeEach(() => {
  signInAs("me")
  vi.mocked(openTab).mockClear()
})

afterEach(() => {
  resetNodesStore()
  setNodesStoreApi(() => null)
  resetAgentDirectory()
  clearAuth()
})

describe("New session (S4)", () => {
  it("the agent defaults to the personal agent and the level to its profile", async () => {
    setup({ profiles: [{ agentId: "agent-personal", level: "standard" }] })
    await ready()
    await waitFor(() =>
      expect((screen.getByTestId("new-session-level") as HTMLSelectElement).value).toBe("standard"),
    )
    const folder = screen.getByTestId("new-session-folder") as HTMLSelectElement
    expect([...folder.options].map((o) => o.textContent)).toEqual([
      "No folder (Liaison Node)",
      "liaison-walk-sample",
    ])
  })

  it("Open asks, and Cancel creates nothing (no POST to node-sessions)", async () => {
    const { rawPost, post } = setup()
    await ready()
    type("Fix the failing test")
    pickLevel("open")
    fireEvent.click(screen.getByTestId("new-session-start"))
    const dialog = await screen.findByTestId("node-level-confirm")
    expect(dialog.textContent).toContain("Run this session at Open?")
    expect(dialog.textContent).toContain("A plain Claude Code session")
    fireEvent.click(screen.getByTestId("node-level-confirm-cancel"))
    await waitFor(() => expect(screen.queryByTestId("node-level-confirm")).toBeNull())
    expect(rawPost).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it("Standard over a Strict profile asks; Strict over Standard does not", async () => {
    const first = setup()
    await ready()
    type("Do it")
    pickLevel("standard")
    fireEvent.click(screen.getByTestId("new-session-start"))
    expect(await screen.findByTestId("node-level-confirm")).toBeTruthy()
    expect(first.rawPost).not.toHaveBeenCalled()
    document.body.innerHTML = ""
    resetNodesStore()
    resetAgentDirectory()

    const second = setup({ profiles: [{ agentId: "agent-personal", level: "standard" }] })
    await ready()
    await waitFor(() =>
      expect((screen.getByTestId("new-session-level") as HTMLSelectElement).value).toBe("standard"),
    )
    type("Do it")
    pickLevel("strict")
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(second.rawPost).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("node-level-confirm")).toBeNull()
    expect(second.post).not.toHaveBeenCalled()
  })

  it("confirmed: the POST carries the confirmation id and the view opens", async () => {
    const { rawPost, post, onOpenChange } = setup()
    await ready()
    type("Fix the failing test")
    pickLevel("open")
    fireEvent.click(screen.getByTestId("new-session-start"))
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toEqual({
      nodeId: "n1",
      level: "open",
      purpose: "session_start",
      agentId: "agent-personal",
    })
    expect(rawPost.mock.calls[0][1]).toEqual({
      prompt: "Fix the failing test",
      model: "claude-haiku-4-5",
      agentId: "agent-personal",
      level: "open",
      // S57, D42: the default pull request goes unsaid.
      confirmationIds: ["00000000-0000-4000-8000-000000000001"],
    })
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1))
    expect(vi.mocked(openTab).mock.calls[0][0]).toMatchObject({
      type: "kernel:session",
      entityId: "s-new",
      routePath: "/sessions/s-new",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("a 403 naming the server's node asks for exactly that node and sends every id (m6)", async () => {
    const refused = json(403, {
      error: {
        code: "confirmation_required",
        message: "Confirm this level",
        nodeIds: ["n2"],
        nodes: [{ nodeId: "n2", nodeName: "Laptop" }],
        level: "open",
      },
    })
    const { rawPost, post } = setup({
      // n2 never published models: the client guesses n1, the server picks n2.
      nodes: [node(), node({ id: "n2", name: "Laptop", models: [], lastSeenAt: null })],
      starts: [refused, json(201, { data: SESSION_ROW })],
    })
    await ready()
    type("Do it")
    pickLevel("open")
    fireEvent.click(screen.getByTestId("new-session-start"))
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    const again = await screen.findByTestId("node-level-confirm")
    expect(again.textContent).toContain("Laptop")
    fireEvent.click(screen.getByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(2))
    expect(post.mock.calls.map((c) => (c[1] as { nodeId: string }).nodeId)).toEqual(["n1", "n2"])
    expect((rawPost.mock.calls[1][1] as { confirmationIds: string[] }).confirmationIds).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ])
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1))
  })

  it("the same refusal for a node already confirmed is said in words, not looped (m6)", async () => {
    const refused = () =>
      json(403, {
        error: {
          code: "confirmation_required",
          message: "Confirm this level",
          nodeIds: ["n1"],
          nodes: [{ nodeId: "n1", nodeName: "Studio Mac" }],
        },
      })
    const { rawPost } = setup({ starts: [refused(), refused()] })
    await ready()
    type("Do it")
    pickLevel("open")
    fireEvent.click(screen.getByTestId("new-session-start"))
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId("node-level-confirm")).toBeNull())
    expect(await screen.findByText(/This level needs your confirmation first/)).toBeTruthy()
    expect(openTab).not.toHaveBeenCalled()
  })

  it("a level the client thought needed nothing, refused by the server, asks for the server's node (m6)", async () => {
    const { rawPost } = setup({
      profiles: [{ agentId: "agent-personal", level: "standard" }],
      starts: [
        json(403, {
          error: {
            code: "confirmation_required",
            nodes: [{ nodeId: "n1", nodeName: "Studio Mac" }],
          },
        }),
        json(201, { data: SESSION_ROW }),
      ],
    })
    await ready()
    await waitFor(() =>
      expect((screen.getByTestId("new-session-level") as HTMLSelectElement).value).toBe("standard"),
    )
    type("Do it")
    fireEvent.click(screen.getByTestId("new-session-start"))
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(2))
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("confirmationIds")
    expect(
      (rawPost.mock.calls[1][1] as { confirmationIds: string[] }).confirmationIds,
    ).toHaveLength(1)
  })

  it("folder_unresolved shows its sentence and candidates", async () => {
    setup({
      starts: [
        json(422, {
          error: {
            code: "folder_unresolved",
            message: "No shared folder has that name.",
            candidates: ["liaison-walk-sample", "liaison-notes"],
          },
        }),
      ],
    })
    await ready()
    type("Do it")
    fireEvent.change(screen.getByTestId("new-session-folder"), {
      target: { value: "liaison-walk-sample" },
    })
    fireEvent.click(screen.getByTestId("new-session-start"))
    const refusal = await screen.findByTestId("new-session-refusal")
    expect(refusal.textContent).toContain("No folder added on this computer matches")
    expect(screen.getByTestId("new-session-refusal-list").textContent).toBe(
      "liaison-walk-sample, liaison-notes",
    )
  })

  it("with no enabled node it says how to set one up and Start is disabled", async () => {
    setup({ nodes: [] })
    expect(await screen.findByTestId("new-session-no-node")).toBeTruthy()
    expect((screen.getByTestId("new-session-start") as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("Reasoning level at start (S23, S25)", () => {
  const withEfforts = () =>
    node({ models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: ["low", "high"] }] })

  it("S23: the new-session dialog sends effort only when chosen", async () => {
    const { rawPost } = setup({ nodes: [withEfforts()] })
    await ready()
    const select = screen.getByTestId("new-session-effort") as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default", "Low", "High"])
    type("First run")
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("effort")
  })

  it("S23: a chosen level is sent as effort", async () => {
    const { rawPost } = setup({ nodes: [withEfforts()] })
    await ready()
    type("Second run")
    fireEvent.change(screen.getByTestId("new-session-effort"), { target: { value: "high" } })
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(rawPost.mock.calls[0][1]).toMatchObject({ effort: "high" })
  })

  it("S25: a model without efforts shows no reasoning select", async () => {
    setup()
    await ready()
    expect(screen.queryByTestId("new-session-effort")).toBeNull()
  })
})

/**
 * D42: the API before wave 2. Its start body was strict (routes-me.ts
 * `startSchema.strict()` through lib/validate.ts): an unknown key is a 400
 * VALIDATION_ERROR whose message names it, and anything else starts.
 */
const OLD_API_KEYS = new Set([
  "prompt",
  "folderName",
  "model",
  "agentId",
  "level",
  "effort",
  "confirmationId",
  "confirmationIds",
])
function oldApiStart(_path: string, body: unknown): Promise<Response> {
  const unknown = Object.keys(body as object).filter((k) => !OLD_API_KEYS.has(k))
  if (unknown.length > 0) {
    return Promise.resolve(
      json(400, {
        error: {
          message: `Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(", ")}`,
          code: "VALIDATION_ERROR",
        },
      }),
    )
  }
  return Promise.resolve(json(201, { data: SESSION_ROW }))
}

describe("Autonomy and finish with at start (S30, S57, D42)", () => {
  it("S57/D42: the default start omits finishWith (pr) and autonomy (guided); a chosen Commit only is sent", async () => {
    const { rawPost } = setup()
    await ready()
    const select = screen.getByTestId("new-session-finish") as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Open a pull request",
      "Commit only",
      "Leave uncommitted",
    ])
    expect(select.value).toBe("pr")
    type("First run")
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("finishWith")
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("autonomy")
  })

  it("S57: a chosen Commit only is sent as finishWith commit", async () => {
    const { rawPost } = setup()
    await ready()
    type("Second run")
    fireEvent.change(screen.getByTestId("new-session-finish"), { target: { value: "commit" } })
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(rawPost.mock.calls[0][1]).toMatchObject({ finishWith: "commit" })
  })

  it("S30: Run on its own is off by default; switched on, the start carries autonomy autonomous", async () => {
    const { rawPost } = setup()
    await ready()
    const toggle = screen.getByRole("switch", { name: "Run on its own" })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    type("Third run")
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(1))
    expect(rawPost.mock.calls[0][1]).toMatchObject({ autonomy: "autonomous" })
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("finishWith")
  })

  it("D42: against the old API, a default start starts the session", async () => {
    const { rawPost } = setup()
    rawPost.mockImplementation(oldApiStart)
    await ready()
    type("Old server run")
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("new-session-refusal")).toBeNull()
  })

  it("D42: against the old API, Commit only or Run on its own says Update the server to use this option", async () => {
    const { rawPost } = setup()
    rawPost.mockImplementation(oldApiStart)
    await ready()
    type("Old server run")
    fireEvent.change(screen.getByTestId("new-session-finish"), { target: { value: "commit" } })
    fireEvent.click(screen.getByTestId("new-session-start"))
    const refusal = await screen.findByTestId("new-session-refusal")
    expect(refusal.textContent).toContain("Update the server to use this option.")
    expect(openTab).not.toHaveBeenCalled()
    // Back to the default, Run on its own on: the same answer.
    fireEvent.change(screen.getByTestId("new-session-finish"), { target: { value: "pr" } })
    fireEvent.click(screen.getByRole("switch", { name: "Run on its own" }))
    fireEvent.click(screen.getByTestId("new-session-start"))
    await waitFor(() => expect(rawPost).toHaveBeenCalledTimes(2))
    expect(rawPost.mock.calls[1][1]).not.toHaveProperty("finishWith")
    await waitFor(() =>
      expect(screen.getByTestId("new-session-refusal").textContent).toContain(
        "Update the server to use this option.",
      ),
    )
  })

  const refusedWith = (error: { code: string; message: string }) => () =>
    Promise.resolve(json(400, { error }))

  async function refusalAfterStart(): Promise<string> {
    fireEvent.click(screen.getByTestId("new-session-start"))
    const refusal = await screen.findByTestId("new-session-refusal")
    return refusal.textContent ?? ""
  }

  it("D42 (batch-2 F7): another 400 VALIDATION_ERROR while Run on its own is on is the ordinary failure", async () => {
    const { rawPost } = setup()
    rawPost.mockImplementation(
      refusedWith({
        code: "VALIDATION_ERROR",
        message: "prompt: String must contain at most 20000 character(s)",
      }),
    )
    await ready()
    fireEvent.click(screen.getByRole("switch", { name: "Run on its own" }))
    type("Long run")
    const text = await refusalAfterStart()
    expect(text).toContain("That did not work. Try again.")
    expect(text).not.toContain("Update the server")
  })

  it("D42 (batch-2 F7): a 400 naming autonomy when this start did not send it is the ordinary failure", async () => {
    const { rawPost } = setup()
    rawPost.mockImplementation(
      refusedWith({
        code: "VALIDATION_ERROR",
        message: "Unrecognized key(s) in object: 'autonomy'",
      }),
    )
    await ready()
    type("Default run")
    const text = await refusalAfterStart()
    expect(rawPost.mock.calls[0][1]).not.toHaveProperty("autonomy")
    expect(text).toContain("That did not work. Try again.")
    expect(text).not.toContain("Update the server")
  })

  it("D42 (batch-2 F7): a 400 of another code whose message names finishWith is the ordinary failure", async () => {
    const { rawPost } = setup()
    rawPost.mockImplementation(
      refusedWith({ code: "BAD_REQUEST", message: "finishWith commit is not allowed here" }),
    )
    await ready()
    type("Commit run")
    fireEvent.change(screen.getByTestId("new-session-finish"), { target: { value: "commit" } })
    const text = await refusalAfterStart()
    expect(rawPost.mock.calls[0][1]).toMatchObject({ finishWith: "commit" })
    expect(text).toContain("That did not work. Try again.")
    expect(text).not.toContain("Update the server")
  })
})
