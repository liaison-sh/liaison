// SPDX-License-Identifier: FSL-1.1-ALv2
// Tree block (S14, §R1 P2-7): rename and drag make the tree dirty, one Save
// sends the whole tree in ONE reorder call on the base version, a 409 says
// someone else changed it, depth stays within maxDepth, new nodes travel with
// temp ids, archive keeps history (archived: true).
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { apiError, createFakeApi, type FakeApi } from "./__fixtures__/fake-api"
import { fixtureManifest } from "./__fixtures__/settings-fixture"
import type { SettingsTreeBlock } from "./types"

const state = vi.hoisted(() => ({ api: null as unknown }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))

import { TreeBlock } from "./TreeBlock"

const block = fixtureManifest.settings?.sections
  .flatMap((s) => s.blocks)
  .find((b): b is SettingsTreeBlock => b.block === "tree") as SettingsTreeBlock

let api: FakeApi
const REORDER = "fixture:categories.reorder"

function seed(version = "v1") {
  api.tool("fixture:categories.list", () => ({
    version,
    nodes: [
      { id: "a", parent_id: null, name: "Hardware", sort_order: 0 },
      { id: "a1", parent_id: "a", name: "Pads", sort_order: 0 },
      { id: "b", parent_id: null, name: "Billing", sort_order: 1 },
      { id: "old", parent_id: null, name: "Gone", sort_order: 2, archived_at: "2026-01-01" },
    ],
  }))
}

function renderTree() {
  return render(() => <TreeBlock app="fixture" block={block} blockId="categories-0" />)
}

function rowNames(): string[] {
  return screen.getAllByTestId(/^tree-name-/).map((el) => el.textContent ?? "")
}

function drag(sourceId: string, targetTestId: string) {
  fireEvent.dragStart(screen.getByTestId(`tree-row-${sourceId}`))
  fireEvent.dragOver(screen.getByTestId(targetTestId))
  fireEvent.drop(screen.getByTestId(targetTestId))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  seed()
  api.tool(REORDER, () => ({ version: "v2", ids: {} }))
})

describe("TreeBlock", () => {
  it("lists live nodes in order and hides archived ones", async () => {
    renderTree()
    await screen.findByTestId("tree-row-a")
    expect(rowNames()).toEqual(["Hardware", "Pads", "Billing"])
    expect(screen.queryByTestId("tree-dirty-bar")).toBeNull()
  })

  it("rename and drag mark it dirty, then ONE reorder call saves the whole tree", async () => {
    renderTree()
    fireEvent.click(await screen.findByTestId("tree-name-b"))
    const input = screen.getByTestId("tree-rename-input")
    fireEvent.input(input, { target: { value: "Invoices" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("tree-dirty-count").textContent).toContain("1")

    drag("b", "tree-drop-before-a")
    expect(rowNames()).toEqual(["Invoices", "Hardware", "Pads"])
    expect(screen.getByTestId("tree-dirty-count").textContent).toContain("2")

    fireEvent.click(screen.getByTestId("tree-save"))
    await waitFor(() =>
      expect(api.toolCalls().filter((c) => c.toolName === REORDER)).toHaveLength(1),
    )
    const call = api.toolCalls().find((c) => c.toolName === REORDER)
    expect(call?.params).toEqual({
      baseVersion: "v1",
      nodes: [
        { id: "b", parentId: null, name: "Invoices", sortOrder: 0 },
        { id: "a", parentId: null, name: "Hardware", sortOrder: 1 },
        { id: "a1", parentId: "a", name: "Pads", sortOrder: 0 },
      ],
    })
    await waitFor(() => expect(screen.queryByTestId("tree-dirty-bar")).toBeNull())
  })

  it("a 409 says someone else changed it and offers a reload", async () => {
    api.tool(REORDER, () => {
      throw apiError(409, "version_conflict", "stale")
    })
    renderTree()
    await screen.findByTestId("tree-row-a")
    drag("b", "tree-drop-before-a")
    fireEvent.click(screen.getByTestId("tree-save"))
    const conflict = await screen.findByTestId("tree-conflict")
    expect(conflict.textContent).toContain("Changed by someone else")
    seed("v9")
    fireEvent.click(screen.getByTestId("tree-reload"))
    await waitFor(() => expect(rowNames()).toEqual(["Hardware", "Pads", "Billing"]))
    expect(screen.queryByTestId("tree-conflict")).toBeNull()
  })

  it("refuses a drop that would go deeper than maxDepth", async () => {
    renderTree()
    await screen.findByTestId("tree-row-a")
    // "Hardware" has a child: under "Billing" its child would sit at depth 3.
    drag("a", "tree-row-b")
    expect(rowNames()).toEqual(["Hardware", "Pads", "Billing"])
    expect(screen.queryByTestId("tree-dirty-bar")).toBeNull()
    // A leaf may nest under a root.
    drag("b", "tree-row-a")
    expect(rowNames()).toEqual(["Hardware", "Pads", "Billing"])
    expect(screen.getByTestId("tree-row-b").getAttribute("data-depth")).toBe("2")
  })

  it("never lets a node drop into its own subtree", async () => {
    renderTree()
    await screen.findByTestId("tree-row-a")
    drag("a", "tree-drop-before-a1")
    expect(screen.queryByTestId("tree-dirty-bar")).toBeNull()
  })

  it("a new node travels with a temp id", async () => {
    renderTree()
    await screen.findByTestId("tree-row-a")
    fireEvent.click(screen.getByTestId("tree-add-root"))
    const input = screen.getByTestId("tree-rename-input")
    fireEvent.input(input, { target: { value: "Returns" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.click(screen.getByTestId("tree-save"))
    await waitFor(() => expect(api.toolCalls().some((c) => c.toolName === REORDER)).toBe(true))
    const params = api.toolCalls().find((c) => c.toolName === REORDER)?.params as {
      nodes: Array<Record<string, unknown>>
    }
    expect(params.nodes).toContainEqual({
      tempId: "new-1",
      parentId: null,
      name: "Returns",
      sortOrder: 2,
    })
  })

  it("archive from the row menu keeps the node (archived: true) with its subtree", async () => {
    renderTree()
    const trigger = await screen.findByTestId("tree-menu-a")
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const item = await screen.findByTestId("tree-archive-a")
    fireEvent.keyDown(item, { key: "Enter" })
    await waitFor(() => expect(rowNames()).toEqual(["Billing"]))
    fireEvent.click(screen.getByTestId("tree-save"))
    await waitFor(() => expect(api.toolCalls().some((c) => c.toolName === REORDER)).toBe(true))
    const params = api.toolCalls().find((c) => c.toolName === REORDER)?.params as {
      nodes: Array<Record<string, unknown>>
    }
    expect(params.nodes).toContainEqual({
      id: "a",
      parentId: null,
      name: "Hardware",
      sortOrder: 0,
      archived: true,
    })
    expect(params.nodes).toContainEqual({
      id: "a1",
      parentId: "a",
      name: "Pads",
      sortOrder: 0,
      archived: true,
    })
  })

  it("Discard restores the saved tree", async () => {
    renderTree()
    await screen.findByTestId("tree-row-a")
    drag("b", "tree-drop-before-a")
    fireEvent.click(screen.getByTestId("tree-discard"))
    expect(rowNames()).toEqual(["Hardware", "Pads", "Billing"])
    expect(screen.queryByTestId("tree-dirty-bar")).toBeNull()
  })

  it("collapses a node with children", async () => {
    renderTree()
    const toggle = await screen.findByTestId("tree-toggle-a")
    fireEvent.click(toggle)
    expect(rowNames()).toEqual(["Hardware", "Billing"])
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(within(screen.getByTestId("tree-row-a")).getByText("Hardware")).toBeTruthy()
  })
})
