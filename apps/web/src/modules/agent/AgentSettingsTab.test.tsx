// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T38: the Settings tab writes the definition, and archives from the same
// page with the blocker the server sends back.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { knownAgentAvatarColor, resetAgentAvatarColors } from "~/lib/agent-avatar-colors"
import { ApiError } from "~/lib/api-error"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import AgentSettingsTab from "~/modules/agent/AgentSettingsTab"
import { resetCreditsStore } from "~/modules/agent/credits/credits-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"

const AGENT = "11111111-1111-4111-8111-111111111111"
const VIEWER = "99999999-9999-4999-8999-999999999999"
const BLOCKED_COPY = "This agent still owns skills or routines. Reassign them first."

const grants = new Set<string>()
vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: (scope: string) => grants.has(scope),
  userFromToken: () => ({ userId: VIEWER, orgId: "org", scopes: [], roles: [] }),
}))

const openTab = vi.fn()
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: (...args: unknown[]) => openTab(...args),
}))

/** The agent as `GET /agents/:id/settings` answers it for an admin. */
function definition(over: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    handle: "@support",
    displayName: "Support",
    kind: "role",
    ownerUserId: null,
    purpose: "Answers customers.",
    avatarUrl: null,
    systemPrompt: "OLD PROMPT",
    modelPreference: null,
    scopeCeiling: ["kernel:threads:read"],
    state: "active",
    ...over,
  }
}

/** The composed prompt `GET /agents/:id/definition` answers, which is what the
 *  Overview tab prints behind its own Show instructions toggle. */
let composedPrompt = ""

/** What `GET /credits/models` answers: the models this workspace can run. */
let creditModels: string[] = []

/** What `GET /admin/scope-catalog` answers for the capability editor. */
let scopeCatalog: Array<{ scope: string; app: string; description?: string }> = []

function setup(over: Record<string, unknown> = {}, agentId = AGENT, runsOn?: "liaison" | "local") {
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/settings")) return { data: definition(over) }
      if (path.endsWith("/definition")) return { data: { systemPrompt: composedPrompt } }
      if (path.endsWith("/scope-catalog")) return { data: scopeCatalog }
      if (path.endsWith("/credits/models"))
        return {
          autoModelKey: null,
          autoResolvedKey: null,
          models: SERVED_MODELS_FIXTURE.models.filter((m) => creditModels.includes(m.key)),
        }
      return { data: [] }
    }),
    post: vi.fn(async () => ({ data: definition() })),
    patch: vi.fn(async () => ({ data: definition({ displayName: "Support Desk" }) })),
    put: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentSettingsTab agentId={agentId} runsOn={runsOn} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentSettingsTab (P4c-T38)", () => {
  beforeEach(() => {
    grants.clear()
    grants.add("kernel:agents:admin")
    composedPrompt = ""
    scopeCatalog = []
    creditModels = []
    resetCreditsStore()
    resetAgentDirectory()
    openTab.mockClear()
  })
  afterEach(() => cleanup())

  // The Overview showed a CHARTER and offered Show instructions on it, while
  // Settings, which the Overview's own copy points at as the place they change,
  // drew an empty box: one tab read the agent row's own prompt, the other read
  // the COMPOSED one. Settings names both now, so the two agree.
  // Walk N4: an agent set to Claude Haiku 4.5 answered on Gemini Flash-Lite,
  // the one model that workspace can run. The picker offers only what runs.
  it("offers only the models this workspace can run, and marks a saved one it cannot", async () => {
    creditModels = ["gemini-flash-lite-latest"]
    setup({ modelPreference: "claude-haiku-4-5" })
    const select = (await screen.findByTestId("agent-settings-model")) as HTMLSelectElement
    await waitFor(() =>
      expect([...select.options].map((o) => o.value)).toEqual([
        "",
        "gemini-flash-lite-latest",
        "claude-haiku-4-5",
      ]),
    )
    const haiku = [...select.options].find(
      (o) => o.value === "claude-haiku-4-5",
    ) as HTMLOptionElement
    expect(haiku.disabled).toBe(true)
    expect(haiku.textContent).toContain("not available in this workspace")
  })

  it("shows the composed charter when the agent's own instructions are empty", async () => {
    composedPrompt = "You are Support.\n\n## Charter\nAnswer in the workspace voice."
    setup({ systemPrompt: "" })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-instructions") as HTMLTextAreaElement).value).toBe(
        "",
      ),
    )
    const toggle = await screen.findByTestId("agent-settings-toggle-composed")
    expect(toggle).toHaveTextContent("Show instructions")
    fireEvent.click(toggle)
    expect(screen.getByTestId("agent-settings-composed").textContent).toContain(
      "Answer in the workspace voice.",
    )
    expect(screen.getByTestId("agent-settings-toggle-composed")).toHaveTextContent(
      "Hide instructions",
    )
  })

  it("offers nothing composed when the workspace adds nothing to the agent's own prompt", async () => {
    composedPrompt = ""
    setup({ systemPrompt: "OLD PROMPT" })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-instructions") as HTMLTextAreaElement).value).toBe(
        "OLD PROMPT",
      ),
    )
    expect(screen.queryByTestId("agent-settings-toggle-composed")).toBeNull()
  })

  it("the Settings tab saves the definition and shows the archive blocker copy on 409", async () => {
    const api = setup()
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-name") as HTMLInputElement).value).toBe("Support"),
    )
    // The form is loaded from the editor's own read, prompt and ceiling
    // included: the page read carries neither.
    expect(api.get).toHaveBeenCalledWith(`/agents/${AGENT}/settings`)
    expect((screen.getByTestId("agent-settings-instructions") as HTMLTextAreaElement).value).toBe(
      "OLD PROMPT",
    )

    fireEvent.input(screen.getByTestId("agent-settings-name"), {
      target: { value: "Support Desk" },
    })
    fireEvent.input(screen.getByTestId("agent-settings-purpose"), {
      target: { value: "Answers shipping questions." },
    })
    fireEvent.input(screen.getByTestId("agent-settings-instructions"), {
      target: { value: "NEW PROMPT" },
    })
    fireEvent.click(screen.getByTestId("agent-settings-save"))

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    expect(api.patch).toHaveBeenCalledWith(`/agents/${AGENT}`, {
      displayName: "Support Desk",
      avatarUrl: null,
      systemPrompt: "NEW PROMPT",
      purpose: "Answers shipping questions.",
      modelPreference: null,
      scopeCeiling: ["kernel:threads:read"],
    })
    await waitFor(() => expect(screen.getByTestId("agent-settings-saved")).toBeInTheDocument())

    // ARCHIVE LIVES ON THIS TAB, and the blocker the server answers with is
    // shown word for word, from the same surface that offers the reassign.
    api.post.mockImplementation(async () => {
      throw new ApiError(BLOCKED_COPY, 409, "archive_blocked", undefined, {
        blocked: true,
        routines: [{ id: "r1", name: "Weekly digest" }],
        skills: [],
      })
    })
    fireEvent.click(screen.getByTestId("agent-archive"))
    await waitFor(() => expect(screen.getByTestId("agent-archive-blocked")).toBeInTheDocument())
    expect(screen.getByTestId("agent-archive-blocked").textContent).toBe(BLOCKED_COPY)
    expect(screen.getByText("Weekly digest")).toBeInTheDocument()
  })

  it("an owner edits three fields and is never shown a scope", async () => {
    grants.clear()
    const api = setup({ kind: "personal", ownerUserId: VIEWER, scopeCeiling: [] })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-name") as HTMLInputElement).value).toBe("Support"),
    )
    expect(screen.queryByTestId("agent-settings-purpose")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-settings-model")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-settings-capabilities")).not.toBeInTheDocument()
    // Archiving is an administrator's, so the row is absent for an owner.
    expect(screen.queryByTestId("agent-archive")).not.toBeInTheDocument()

    fireEvent.input(screen.getByTestId("agent-settings-name"), { target: { value: "My Liaison" } })
    fireEvent.click(screen.getByTestId("agent-settings-save"))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    // The three an owner may write, and nothing the server would refuse.
    expect(api.patch).toHaveBeenCalledWith(`/agents/${AGENT}`, {
      displayName: "My Liaison",
      avatarUrl: null,
      systemPrompt: "OLD PROMPT",
    })
  })

  it("create mode posts a new role agent and opens its page", async () => {
    const api = setup({}, "new")
    // Nothing is read for an agent that does not exist yet.
    expect(api.get).not.toHaveBeenCalledWith("/agents/new/settings")
    fireEvent.input(screen.getByTestId("agent-settings-name"), {
      target: { value: "Shipping Desk" },
    })
    // The handle is derived from the name until somebody edits it.
    expect((screen.getByTestId("agent-settings-handle") as HTMLInputElement).value).toBe(
      "@shipping-desk",
    )
    fireEvent.click(screen.getByTestId("agent-settings-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith("/agents", {
      handle: "@shipping-desk",
      displayName: "Shipping Desk",
      purpose: null,
      avatarUrl: null,
      systemPrompt: "",
      modelPreference: null,
      scopeCeiling: [],
    })
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1))
    expect(openTab).toHaveBeenCalledWith({
      type: "agents:agent",
      entityId: AGENT,
      label: "Support",
      routePath: `/agents/${AGENT}/settings`,
    })
  })

  // "Can't see the definition": every field the tab edits has to be ON the tab,
  // not behind a control the viewer has to find first. The handle in particular
  // used to sit inside a collapsed Advanced block.
  it("the whole definition is on the tab, with nothing behind a fold", async () => {
    setup({}, AGENT, "local")
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-name") as HTMLInputElement).value).toBe("Support"),
    )

    const form = screen.getByTestId("agent-settings-form")
    expect(form).toBeInTheDocument()
    for (const field of [
      "agent-settings-name",
      "agent-settings-handle",
      "agent-settings-purpose",
      "agent-settings-instructions",
      "agent-settings-model",
      "agent-settings-capabilities",
      "agent-settings-runtime",
    ]) {
      expect(form.querySelector(`[data-testid="${field}"]`), field).not.toBeNull()
    }
    // The handle carries the value, and it is not the Advanced block's any more.
    expect((screen.getByTestId("agent-settings-handle") as HTMLInputElement).value).toBe("@support")
    expect(screen.getByTestId("agent-settings-handle").closest("details")).toBeNull()
    // Where the agent runs is part of what a person reads here.
    expect(screen.getByTestId("agent-settings-runtime").textContent).toBe("Runs on: this computer")
  })

  it("an owner who is not an admin still reads the definition inline", async () => {
    grants.clear()
    setup({ kind: "personal", ownerUserId: VIEWER })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-name") as HTMLInputElement).value).toBe("Support"),
    )
    const form = screen.getByTestId("agent-settings-form")
    expect(form.querySelector('[data-testid="agent-settings-name"]')).not.toBeNull()
    expect(form.querySelector('[data-testid="agent-settings-instructions"]')).not.toBeNull()
    // No scope vocabulary reaches an owner's form: that rule is unchanged.
    expect(screen.queryByTestId("agent-settings-capabilities")).toBeNull()
  })

  // Charter agent.md, "A scope name on screen": the capability editor labelled
  // every checkbox with the grant id (`kernel:agent:memory`) and put the
  // description underneath it. The label is the words now; the id is a title
  // an admin can hover, never the visible label.
  it("the capability editor labels each permission in words, not by its id", async () => {
    scopeCatalog = [
      {
        scope: "kernel:agent:memory",
        app: "kernel",
        description: "Read and write the agent's memory files",
      },
      { scope: "projects:tasks:write", app: "projects" },
    ]
    setup()
    const grid = await waitFor(() => screen.getByTestId("agent-settings-capabilities"))
    const described = await waitFor(() =>
      screen.getByTestId("agent-ceiling-add-scope-kernel:agent:memory"),
    )
    expect(described.textContent).toContain("Read and write the agent's memory files")
    expect(described.textContent).not.toContain("kernel:agent:memory")
    expect(described.getAttribute("title")).toBe("Permission id: kernel:agent:memory")

    // A grant the catalog carries no description for still reads as a phrase.
    const derived = screen.getByTestId("agent-ceiling-add-scope-projects:tasks:write")
    expect(derived.textContent).toBe("Projects: edit tasks")
    expect(grid.textContent).not.toContain("projects:tasks:write")

    // The app GROUP header carried the slug beside the name in its own span,
    // so the editor read "Workspace KERNEL". The span is gone, not restyled:
    // uppercase is CSS, and a text assertion on it proves nothing.
    expect(screen.queryByTestId("agent-ceiling-permission-app-slug-kernel")).toBeNull()
    expect(screen.queryByTestId("agent-ceiling-permission-app-slug-projects")).toBeNull()
    const visible = grid.textContent ?? ""
    expect(visible).toContain("Workspace")
    expect(visible).toContain("Projects")
    expect(visible).not.toContain("kernel")
    // The slug survives as a hover on the app name, for the admin who wants it.
    const header = screen.getByTestId("agent-ceiling-permission-app-header-kernel")
    expect(header.querySelector("[title]")?.getAttribute("title")).toBe("kernel")
  })

  // The search box searched the identifiers, which are exactly what the rows
  // no longer show: typing the words on screen matched nothing.
  it("the capability search matches the words the rows show", async () => {
    scopeCatalog = [
      { scope: "projects:tasks:write", app: "projects" },
      { scope: "kernel:users:read", app: "kernel", description: "Read user list" },
    ]
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-ceiling-scope-input")).toBeInTheDocument())
    fireEvent.input(screen.getByTestId("agent-ceiling-scope-input"), {
      target: { value: "edit tasks" },
    })
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-ceiling-add-scope-projects:tasks:write"),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("agent-ceiling-add-scope-kernel:users:read")).toBeNull()
  })
})

// The Picture field was a bare text box for `avatarUrl`: no upload control, no
// preview, and nothing on screen to tell a reader it wanted a URL. It is an
// avatar control now, over the same raw-image upload path a person's own
// profile picture uses.
describe("AgentSettingsTab: the Picture field is an avatar control", () => {
  beforeEach(() => {
    grants.clear()
    grants.add("kernel:agents:admin")
    composedPrompt = ""
    resetAgentDirectory()
    openTab.mockClear()
  })
  afterEach(() => cleanup())

  it("draws a preview and a Choose picture button, and no raw URL text box", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-preview")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-settings-avatar-choose")).toHaveTextContent("Choose picture")
    expect(screen.getByTestId("agent-settings-avatar-file")).toHaveAttribute("type", "file")
    // The old bare text input is gone.
    expect(screen.queryByTestId("agent-settings-avatar")).toBeNull()
  })

  it("shows the stored picture in the preview, with a Remove control", async () => {
    setup({ avatarUrl: "/api/avatars/abcdefghijklmnop" })
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-image")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-settings-avatar-image")).toHaveAttribute(
      "src",
      "/api/avatars/abcdefghijklmnop",
    )
    expect(screen.getByTestId("agent-settings-avatar-remove")).toBeInTheDocument()
  })

  it("uploads the chosen file to the agent's own avatar route", async () => {
    const api = setup()
    api.post = vi.fn(async () => ({
      data: definition({ avatarUrl: "/api/avatars/qrstuvwxyz012345" }),
    }))
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-file")).toBeInTheDocument(),
    )
    const file = new File([new Uint8Array([1, 2, 3])], "face.png", { type: "image/png" })
    const input = screen.getByTestId("agent-settings-avatar-file") as HTMLInputElement
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/agents/${AGENT}/avatar`, file))
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-image")).toHaveAttribute(
        "src",
        "/api/avatars/qrstuvwxyz012345",
      ),
    )
  })

  it("refuses an oversized file in words, without calling the route", async () => {
    const api = setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-file")).toBeInTheDocument(),
    )
    const big = new File([new Uint8Array(1)], "big.png", { type: "image/png" })
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 })
    const input = screen.getByTestId("agent-settings-avatar-file") as HTMLInputElement
    Object.defineProperty(input, "files", { value: [big], configurable: true })
    fireEvent.change(input)
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-avatar-error")).toHaveTextContent("5 MB"),
    )
    expect(api.post).not.toHaveBeenCalled()
  })
})

// The demo org's four agents wore two colours between them: the slot was a hash
// of the id. It is stored now, the server hands each new agent its org's
// least-used one, and the Color field here lets a person pick another.
describe("AgentSettingsTab: the Color field", () => {
  beforeEach(() => {
    grants.clear()
    grants.add("kernel:agents:admin")
    composedPrompt = ""
    resetAgentDirectory()
    resetAgentAvatarColors()
    openTab.mockClear()
  })
  afterEach(() => cleanup())

  it("checks the stored colour and saves a picked one at once, repainting the preview", async () => {
    const api = setup({ avatarColor: 2 })
    api.patch.mockImplementation(async () => ({ data: definition({ avatarColor: 5 }) }))
    const stored = (await screen.findByTestId("agent-settings-color-2")) as HTMLInputElement
    await waitFor(() => expect(stored.checked).toBe(true))
    expect(screen.getByTestId("agent-settings-avatar-preview").getAttribute("style")).toContain(
      "--agent-avatar-2-bg",
    )
    // Every slot is a named radio: one Tab stop, arrow keys move the pick.
    const radios = screen
      .getByTestId("agent-settings-color")
      .querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.length).toBe(8)
    expect(radios[5]?.getAttribute("aria-label")).toBe("Teal")

    fireEvent.click(screen.getByTestId("agent-settings-color-5"))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    expect(api.patch).toHaveBeenCalledWith(`/agents/${AGENT}`, { avatarColor: 5 })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-color-5") as HTMLInputElement).checked).toBe(true),
    )
    expect(screen.getByTestId("agent-settings-avatar-preview").getAttribute("style")).toContain(
      "--agent-avatar-5-bg",
    )
    // Every other disc of this agent reads the same slot.
    expect(knownAgentAvatarColor(AGENT)).toBe(5)
  })

  it("puts the stored colour back and says so when the save fails", async () => {
    const api = setup({ avatarColor: 1 })
    api.patch.mockImplementation(async () => {
      throw new ApiError("nope", 500)
    })
    await waitFor(() =>
      expect((screen.getByTestId("agent-settings-color-1") as HTMLInputElement).checked).toBe(true),
    )
    fireEvent.click(screen.getByTestId("agent-settings-color-6"))
    await waitFor(() =>
      expect(screen.getByTestId("agent-settings-color-error")).toBeInTheDocument(),
    )
    expect((screen.getByTestId("agent-settings-color-1") as HTMLInputElement).checked).toBe(true)
    expect(knownAgentAvatarColor(AGENT)).toBe(1)
  })

  it("an owner may pick their own agent's colour", async () => {
    grants.clear()
    const api = setup({ kind: "personal", ownerUserId: VIEWER, scopeCeiling: [], avatarColor: 0 })
    fireEvent.click(await screen.findByTestId("agent-settings-color-3"))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/agents/${AGENT}`, { avatarColor: 3 }),
    )
  })
})
