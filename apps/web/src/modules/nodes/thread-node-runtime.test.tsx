// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-D T6 (S21, S24, A24): "My node" in the thread runtime picker, on the
// web and in the desktop app, offered only while one of the person's nodes is
// enabled and online, one row per node named by the node, and stored on the server (PUT /api/nodes/threads/:threadId/settings) so the
// web, the phone and the desktop show and use the same runtime. The node chat
// gets the local session's mode picker, without Bypass (A24).
import { within as domWithin, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { createApiClient } from "~/lib/api-client"
import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
  emptyDesktopSessionState,
} from "~/lib/desktop-shell-contract"
import ModelSelector from "~/modules/agent/ModelSelector"
import { attachDesktopBridge, resetDesktopStore } from "~/modules/desktop/desktop-store"
import RuntimeControl from "~/modules/desktop/RuntimeControl"
import { ApiContext } from "~/modules/shell/ApiContext"
import NodeModeMenu from "./NodeModeMenu"
import { applyNodeFrame } from "./nodes-store"
import {
  loadMyNodes,
  loadThreadNodeRuntime,
  ThreadNodeRuntimeTestAccess,
  type ThreadNodeSetting,
} from "./thread-node-runtime"

type Api = ReturnType<typeof createApiClient>

interface FakeApi {
  api: Api
  puts: Array<{ path: string; body: unknown }>
}

function fakeApi(options: {
  nodes?: Array<Record<string, unknown>>
  settings?: ThreadNodeSetting[]
}): FakeApi {
  const puts: FakeApi["puts"] = []
  let settings = options.settings ?? []
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/nodes/me") return { nodes: options.nodes ?? [] }
      if (path.startsWith("/nodes/threads/")) return settings
      throw new Error(`unexpected GET ${path}`)
    }),
    put: vi.fn(async (path: string, body: Record<string, unknown>) => {
      puts.push({ path, body })
      if (body.runsOn === "cloud") {
        settings = settings.filter((s) => s.agentId !== body.agentId)
        return { agentId: body.agentId, runsOn: "cloud" }
      }
      const prior = settings.find((s) => s.agentId === body.agentId)
      const row: ThreadNodeSetting = {
        agentId: body.agentId as string,
        runsOn: body.runsOn as ThreadNodeSetting["runsOn"],
        permissionMode: (body.permissionMode as ThreadNodeSetting["permissionMode"]) ?? "manual",
        nodeId: (body.nodeId as string | undefined) ?? prior?.nodeId ?? null,
        model: body.model !== undefined ? (body.model as string | null) : (prior?.model ?? null),
        ownerUserId: "me",
        mine: true,
        hasSession: false,
        updatedAt: new Date(0).toISOString(),
      }
      settings = [...settings.filter((s) => s.agentId !== row.agentId), row]
      return row
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as Api
  return { api, puts }
}

function withApi(api: Api, children: () => JSX.Element) {
  return () => <ApiContext.Provider value={api}>{children()}</ApiContext.Provider>
}

const STUDIO = {
  id: "node-1",
  name: "Studio Mac",
  enabled: true,
  online: true,
  models: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-opus-4-6", label: "Opus 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
}
const ENABLED = [STUDIO]
const NODE_ROW: ThreadNodeSetting = {
  agentId: "a1",
  runsOn: "node",
  permissionMode: "manual",
  nodeId: "node-1",
  model: null,
  ownerUserId: "me",
  mine: true,
  hasSession: true,
  updatedAt: new Date(0).toISOString(),
}

function installDesktop(runtimeLocation: "local" | "liaison" = "liaison") {
  const location = { current: runtimeLocation as string }
  const bridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: "macos",
    getServerAddress: () => null,
    setPermissionMode: () => {},
    setRuntimeLocation: vi.fn((l: string) => {
      location.current = l
    }),
    getState: () => ({ ...emptyDesktopSessionState(), runtimeLocation }),
    subscribe: () => () => {},
  } as unknown as DesktopBridge
  vi.stubGlobal(DESKTOP_BRIDGE_KEY, bridge)
  attachDesktopBridge()
  return bridge
}

async function openMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", {
    name: "Where the turns of this conversation run",
  })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return await screen.findByRole("menu")
}

function select(menu: HTMLElement, text: string) {
  const row = domWithin(menu).getByText(text).closest('[role="menuitem"]')
  expect(row).not.toBeNull()
  fireEvent.keyDown(row as HTMLElement, { key: "Enter" })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetDesktopStore()
  ThreadNodeRuntimeTestAccess.reset()
})

const TRIGGER = "Where the turns of this conversation run"

describe("My node in the runtime picker (S21, S24)", () => {
  it("a browser with no enabled node still shows nothing", async () => {
    const { api } = fakeApi({ nodes: [{ ...STUDIO, enabled: false }] })
    const { container } = render(
      withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />),
    )
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(container.innerHTML).toBe("")
  })

  it("a browser whose only node is offline shows nothing: no node is available", async () => {
    const { api } = fakeApi({ nodes: [{ ...STUDIO, online: false }] })
    const { container } = render(
      withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />),
    )
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(container.innerHTML).toBe("")
  })

  it("the picker appears when a node comes online, with no reload (L27)", async () => {
    const nodes: Array<Record<string, unknown>> = []
    const { api } = fakeApi({ nodes })
    const { container } = render(
      withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />),
    )
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(container.innerHTML).toBe("")
    // The owner enables this computer in another window: the API publishes
    // a `kernel:node` change and the picker appears, with no reload.
    nodes.push(STUDIO)
    applyNodeFrame({ ownerUserId: "me", nodeId: "node-1", change: "node" })
    const menu = await openMenu()
    expect(domWithin(menu).queryByText("Studio Mac")).not.toBeNull()
  })

  it("a browser with a node online offers Liaison and that node by name, never This machine", async () => {
    const { api } = fakeApi({ nodes: ENABLED })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    const menu = await openMenu()
    expect(domWithin(menu).queryByText("Studio Mac")).not.toBeNull()
    expect(domWithin(menu).queryByText("Liaison")).not.toBeNull()
    expect(domWithin(menu).queryByText("This machine")).toBeNull()
    // One sentence for the node mode too (S18).
    const sentence = domWithin(menu).getByText(
      "Works on one of your computers, with your Claude account, even while you are away: it can use that computer's files and scripts, and you approve what it asks from wherever you are.",
    )
    expect(sentence.closest('[role="menuitem"]')?.textContent).toContain("Studio Mac")
  })

  it("two nodes online are two rows, each named, and an offline one is not offered", async () => {
    const { api } = fakeApi({
      nodes: [
        STUDIO,
        { ...STUDIO, id: "node-2", name: "Laptop" },
        { ...STUDIO, id: "node-3", name: "Old tower", online: false },
      ],
    })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    const menu = await openMenu()
    await waitFor(() => expect(domWithin(menu).getAllByTestId("runtime-node-row")).toHaveLength(2))
    expect(domWithin(menu).queryByText("Studio Mac")).not.toBeNull()
    expect(domWithin(menu).queryByText("Laptop")).not.toBeNull()
    expect(domWithin(menu).queryByText(/Old tower/)).toBeNull()
  })

  it("the desktop app without a node offers no node", async () => {
    installDesktop()
    const { api } = fakeApi({ nodes: [] })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    const menu = await openMenu()
    expect(domWithin(menu).queryByText("This machine")).not.toBeNull()
    expect(domWithin(menu).queryAllByTestId("runtime-node-row")).toHaveLength(0)
  })

  it("choosing a node stores it, with that node, and the trigger names it", async () => {
    const bridge = installDesktop("local")
    const { api, puts } = fakeApi({ nodes: ENABLED })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    const menu = await openMenu()
    await waitFor(() => expect(domWithin(menu).queryByText("Studio Mac")).not.toBeNull())
    select(menu, "Studio Mac")
    await waitFor(() =>
      expect(puts).toEqual([
        {
          path: "/nodes/threads/t1/settings",
          body: { agentId: "a1", runsOn: "node", nodeId: "node-1" },
        },
      ]),
    )
    // The desktop's own local session is off: the turns go through the server.
    await waitFor(() => expect(bridge.setRuntimeLocation).toHaveBeenCalledWith("liaison"))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: TRIGGER }).textContent).toContain("Studio Mac"),
    )
  })

  it("a thread stored on the node names it, and Liaison puts it back to the cloud", async () => {
    const { api, puts } = fakeApi({ nodes: ENABLED, settings: [NODE_ROW] })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: TRIGGER }).textContent).toContain("Studio Mac"),
    )
    const menu = await openMenu()
    select(menu, "Liaison")
    await waitFor(() =>
      expect(puts).toEqual([
        { path: "/nodes/threads/t1/settings", body: { agentId: "a1", runsOn: "cloud" } },
      ]),
    )
  })

  it("a thread on a node that went offline still says so, so the way back is visible", async () => {
    const { api } = fakeApi({ nodes: [{ ...STUDIO, online: false }], settings: [NODE_ROW] })
    render(withApi(api, () => <RuntimeControl agentId="a1" agentName="Data" threadId="t1" />))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: TRIGGER }).textContent).toContain(
        "Studio Mac (offline)",
      ),
    )
  })
})

describe("the model picker on a node (My node)", () => {
  async function renderPicker(
    settings: ThreadNodeSetting[],
    agentDefault = "gemini-3-pro",
    compactLabel: string | null = null,
  ) {
    const fake = fakeApi({ nodes: ENABLED, settings })
    await loadMyNodes(fake.api)
    await loadThreadNodeRuntime(fake.api, "t1")
    const onSelect = vi.fn()
    render(
      withApi(fake.api, () => (
        <ModelSelector
          balance={null}
          selectedModelId={null}
          defaultEntryLabel="Default (Gemini 3 Pro)"
          agentDefaultModelId={agentDefault}
          onSelect={onSelect}
          threadId="t1"
          compactLabel={compactLabel}
        />
      )),
    )
    return { ...fake, onSelect }
  }

  async function openModels(): Promise<HTMLElement> {
    const trigger = await screen.findByRole("button", { name: "Select model" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    return await screen.findByRole("menu")
  }

  it("lists the node's current Claude models under its name, and no Liaison model", async () => {
    await renderPicker([NODE_ROW])
    // A Gemini preference says nothing about the node: its default (Haiku) runs.
    expect(screen.getByTestId("model-selector-label").textContent).toBe("Default (Haiku 4.5)")
    const menu = await openModels()
    expect(domWithin(menu).queryByText("Models on Studio Mac")).not.toBeNull()
    expect(domWithin(menu).queryByText("Opus 5.5")).not.toBeNull()
    expect(domWithin(menu).queryByText("Haiku 4.5")).not.toBeNull()
    // Only each family's current model is offered.
    expect(domWithin(menu).queryByText("Opus 4.6")).toBeNull()
    expect(domWithin(menu).queryByTestId("model-section-liaison")).toBeNull()
    expect(domWithin(menu).queryByText(/Gemini/)).toBeNull()
  })

  it("a runtime stored before it named its node still names the owner's only node", async () => {
    await renderPicker([{ ...NODE_ROW, nodeId: null }])
    const menu = await openModels()
    expect(domWithin(menu).queryByText("Models on Studio Mac")).not.toBeNull()
    expect(domWithin(menu).queryByText("Local models")).toBeNull()
  })

  it("on a phone the chip names the node's model, never the cloud model's short name", async () => {
    await renderPicker([{ ...NODE_ROW, model: "claude-opus-5-5" }], "gemini-3-pro", "Flash")
    expect(screen.getByTestId("model-selector-label").textContent).toBe("Opus 5.5")
  })

  it("an agent preferring a Claude model the node offers defaults to it", async () => {
    await renderPicker([NODE_ROW], "claude-opus-5-5")
    expect(screen.getByTestId("model-selector-label").textContent).toBe("Default (Opus 5.5)")
  })

  it("picking a node model stores it on the conversation's node runtime", async () => {
    const { puts, onSelect } = await renderPicker([NODE_ROW])
    const menu = await openModels()
    select(menu, "Opus 5.5")
    await waitFor(() =>
      expect(puts).toEqual([
        {
          path: "/nodes/threads/t1/settings",
          body: { agentId: "a1", runsOn: "node", model: "claude-opus-5-5" },
        },
      ]),
    )
    // Not a Liaison model change.
    expect(onSelect).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId("model-selector-label").textContent).toBe("Opus 5.5"),
    )
  })

  it("off the node, the picker is the Liaison one as before", async () => {
    await renderPicker([])
    expect(screen.getByTestId("model-selector-label").textContent).toBe("Default (Gemini 3 Pro)")
    const menu = await openModels()
    expect(domWithin(menu).queryByTestId("model-section-node")).toBeNull()
    expect(domWithin(menu).queryByText("Models on Studio Mac")).toBeNull()
  })
})

describe("the node chat's mode picker (S24, A24)", () => {
  it("renders nothing when this thread does not run on the viewer's node", async () => {
    const { api } = fakeApi({ nodes: ENABLED, settings: [] })
    const { container } = render(withApi(api, () => <NodeModeMenu threadId="t1" />))
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("offers auto, manual, edit and plan, never bypass, and stores the choice", async () => {
    const { api, puts } = fakeApi({ nodes: ENABLED, settings: [NODE_ROW] })
    render(withApi(api, () => <NodeModeMenu threadId="t1" />))
    const trigger = await screen.findByRole("button", { name: "Permission mode on your computer" })
    expect(trigger.textContent).toContain("Manual")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    for (const label of ["Auto", "Manual", "Edit automatically", "Plan"]) {
      expect(domWithin(menu).queryByText(label)).not.toBeNull()
    }
    expect(domWithin(menu).queryByText("Bypass permissions")).toBeNull()
    select(menu, "Plan")
    await waitFor(() =>
      expect(puts).toEqual([
        {
          path: "/nodes/threads/t1/settings",
          body: { agentId: "a1", runsOn: "node", permissionMode: "plan" },
        },
      ]),
    )
    await waitFor(() => expect(trigger.textContent).toContain("Plan"))
  })
})
