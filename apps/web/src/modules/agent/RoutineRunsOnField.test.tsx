// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T14 (L26, L27): the routine "Runs on" picker shows only with a node
// (live), says My computer, and on a node sets the folder (or repo, exclusive)
// and model of node runs, saved through PUT /agent/routines/:id/node-placement.
// A cloud agent attached to the viewer's node says it runs there too.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider, useI18n } from "~/modules/i18n/i18n-context"
import { createAttachedNodeName } from "~/modules/nodes/agent-node"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { applyNodeFrame, resetNodesStore } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import RoutineRunsOnField from "./RoutineRunsOnField"
import {
  type RoutineNodePlacement,
  type RoutineRunsOn,
  resetRoutinesStore,
  updateRoutine,
} from "./routines-store"

function node(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "n1",
    name: "Studio Mac",
    enabled: true,
    online: true,
    lastSeenAt: null,
    os: "macos",
    appVersion: "0.1.20",
    deviceId: "d1",
    queue: { queued: 0, running: 0 },
    sharedFolderNames: ["liaison-walk-sample", "notes"],
    models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
    levelPins: [],
    ...over,
  }
}

function fakeApi(nodes: NodeSummary[], attachments: unknown[] = []) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/nodes/me") return { nodes }
      if (path === "/nodes/me/attachments") return attachments
      throw new Error(`unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: Record<string, unknown>) => ({ id: "r1", ...body })),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

function Field(props: { initial?: RoutineRunsOn }) {
  const [runsOn, setRunsOn] = createSignal<RoutineRunsOn>(props.initial ?? "cloud")
  const [placement, setPlacement] = createSignal<RoutineNodePlacement>({
    folder: null,
    repo: null,
    model: null,
  })
  return (
    <>
      <RoutineRunsOnField
        value={runsOn()}
        onChange={setRunsOn}
        testId="routine-runs-on"
        placement={placement()}
        onPlacementChange={setPlacement}
      />
      <output data-testid="placement">{JSON.stringify(placement())}</output>
    </>
  )
}

function show(api: ReturnType<typeof fakeApi>, initial?: RoutineRunsOn) {
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api as never}>
        <Field initial={initial} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

const placementShown = () => JSON.parse(screen.getByTestId("placement").textContent ?? "{}")

afterEach(() => {
  resetNodesStore()
  resetRoutinesStore()
})

describe("the routine Runs on picker (L26)", () => {
  it("without a node the picker is hidden", async () => {
    const api = fakeApi([])
    show(api)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(screen.queryByTestId("routine-runs-on")).toBeNull()
  })

  it("a routine already on a node keeps the picker, so it can move back to the cloud", async () => {
    const api = fakeApi([])
    show(api, "node")
    expect(await screen.findByTestId("routine-runs-on")).toHaveValue("node")
  })

  it("a node appearing live shows it with no reload", async () => {
    const nodes: NodeSummary[] = []
    const api = fakeApi(nodes)
    show(api)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(screen.queryByTestId("routine-runs-on")).toBeNull()
    nodes.push(node())
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "node" })
    expect(await screen.findByTestId("routine-runs-on")).toBeTruthy()
  })

  it("it says My computer", async () => {
    show(fakeApi([node()]))
    const select = await screen.findByTestId("routine-runs-on")
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "Cloud",
      "My computer",
      "My computer, else the cloud",
    ])
    expect(document.body.textContent).not.toMatch(/\bnodes?\b/i)
  })

  it("choosing node shows folder, repo and model, and saving PUTs node-placement", async () => {
    const api = fakeApi([node()])
    show(api)
    const select = await screen.findByTestId("routine-runs-on")
    expect(screen.queryByTestId("routine-runs-on-placement")).toBeNull()
    fireEvent.change(select, { target: { value: "node" } })
    const folder = (await screen.findByTestId("routine-runs-on-folder")) as HTMLSelectElement
    expect([...folder.options].map((o) => o.textContent)).toEqual([
      "The agent's folder",
      "liaison-walk-sample",
      "notes",
    ])
    const model = screen.getByTestId("routine-runs-on-model") as HTMLSelectElement
    expect([...model.options].map((o) => o.textContent)).toEqual(["The agent's model", "Haiku 4.5"])
    expect(screen.getByTestId("routine-runs-on-repo")).toBeTruthy()
    fireEvent.change(folder, { target: { value: "liaison-walk-sample" } })
    fireEvent.change(model, { target: { value: "claude-haiku-4-5" } })
    expect(placementShown()).toEqual({
      folder: "liaison-walk-sample",
      repo: null,
      model: "claude-haiku-4-5",
    })

    // m7: the placement travels with the routine's own save.
    await updateRoutine(api as never, "r1", { nodePlacement: placementShown() })
    expect(api.put).toHaveBeenCalledWith("/agent/routines/r1", {
      nodePlacement: { folder: "liaison-walk-sample", repo: null, model: "claude-haiku-4-5" },
    })
  })

  it("folder and repo are exclusive", async () => {
    show(fakeApi([node()]), "node")
    const folder = (await screen.findByTestId("routine-runs-on-folder")) as HTMLSelectElement
    // The node's shared folders arrive with the nodes read.
    await waitFor(() => expect(folder.options).toHaveLength(3))
    fireEvent.change(folder, { target: { value: "notes" } })
    expect(placementShown()).toMatchObject({ folder: "notes", repo: null })
    fireEvent.input(screen.getByTestId("routine-runs-on-repo"), {
      target: { value: "git@gitlab.com:team/app.git" },
    })
    expect(placementShown()).toMatchObject({ folder: null, repo: "git@gitlab.com:team/app.git" })
    fireEvent.change(screen.getByTestId("routine-runs-on-folder"), { target: { value: "notes" } })
    expect(placementShown()).toMatchObject({ folder: "notes", repo: null })
  })
})

describe("the agent's Runs on line (L26)", () => {
  function Line(props: { agentId: string; api: ReturnType<typeof fakeApi> }) {
    const i18n = useI18n()
    const name = createAttachedNodeName(props.api as never, () => props.agentId)
    return (
      <p data-testid="line">
        {name()
          ? i18n.t("kernel.agents.runsOnLiaisonAndNode", { node: name() ?? "" })
          : i18n.t("kernel.agents.runsOnLiaison")}
      </p>
    )
  }

  function line(api: ReturnType<typeof fakeApi>) {
    render(() => (
      <I18nProvider initialLocale="en">
        <Line agentId="a-1" api={api} />
      </I18nProvider>
    ))
  }

  it("an attached agent's line names the node", async () => {
    line(fakeApi([node()], [{ id: "att-1", agentId: "a-1", nodeId: null }]))
    await waitFor(() =>
      expect(screen.getByTestId("line").textContent).toBe(
        "Runs on: Liaison, and your computer Studio Mac",
      ),
    )
  })

  it("an agent not attached, or a viewer with no node, reads Liaison only", async () => {
    const api = fakeApi([], [{ id: "att-1", agentId: "a-1", nodeId: null }])
    line(api)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/nodes/me"))
    expect(screen.getByTestId("line").textContent).toBe("Runs on: Liaison")
    expect(api.get).not.toHaveBeenCalledWith("/nodes/me/attachments")
  })
})
