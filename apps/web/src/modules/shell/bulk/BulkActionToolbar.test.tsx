// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerBulkUiCustomForm,
  registerBulkUiSelection,
  registerManifestAppData,
  resetRegistry,
} from "~/framework/app-registry"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { BulkActionToolbar } from "./BulkActionToolbar"

function setupTicketsManifest() {
  registerManifestAppData("tickets", {
    bulk: {
      assign: {
        label: "Assign…",
        underlyingTool: "assign",
        dispatchMode: "perItem",
        perItemParam: "ticketId",
        sharedFields: ["assignedTo"],
      },
      close: {
        label: "Close tickets…",
        underlyingTool: "close",
        dispatchMode: "perItem",
        perItemParam: "ticketId",
        sharedFields: ["closedReason", "textBody"],
        fieldSpecs: {
          closedReason: { type: "string", enum: ["resolved", "duplicate", "spam", "no_response"] },
          textBody: { type: "string" },
        },
      },
      merge: {
        label: "Merge…",
        underlyingTool: "merge",
        dispatchMode: "aggregate",
        selectionParam: "sourceTicketIds",
        sharedFields: ["targetTicketId"],
        minSelection: 2,
        customForm: "MergeTicketsForm",
      },
      move: {
        label: "Move to inbox…",
        underlyingTool: "ticketsMove",
        dispatchMode: "aggregate",
        selectionParam: "ticketIds",
        sharedFields: ["toInboxId"],
        customForm: "MoveTicketsToInboxForm",
      },
    },
  })
}

function jsonResponse(body: any) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
}

function errorResponse(status: number, code: string) {
  return Promise.resolve(
    new Response(JSON.stringify({ error: { code, message: "Too many selected" } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )
}

describe("BulkActionToolbar", () => {
  beforeEach(() => {
    resetRegistry()
    setupTicketsManifest()
    vi.useRealTimers()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("unmounts when selection is empty, mounts on ≥1", async () => {
    const [sel, setSel] = createSignal<string[]>(["a", "b"])
    registerBulkUiSelection("tickets", "inbox", {
      accessor: sel,
      clear: () => setSel([]),
    })
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    setSel([])
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull())
  })

  it("disables action chip when selection < minSelection (merge requires 2)", async () => {
    const [sel] = createSignal<string[]>(["t1"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    const mergeChip = screen.getByTestId("bulk-action-merge") as HTMLButtonElement
    expect(mergeChip.disabled).toBe(true)
  })

  it("submits POST /api/apps/:app/bulk/:action with generated UUID idempotencyKey", async () => {
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 2, succeeded: 2, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-assign"))
    const input = await screen.findByTestId("bulk-field-assignedTo")
    fireEvent.input(input, { target: { value: "user-1" } })
    fireEvent.click(screen.getByTestId("bulk-submit"))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe("/api/apps/tickets/bulk/assign")
    const body = JSON.parse(call[1].body)
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.ids).toEqual(["t1", "t2"])
    expect(body.params).toEqual({ assignedTo: "user-1" })
  })

  it("renders an enum shared-field (closedReason) as a defaulted <select>, not a text input", async () => {
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-close"))

    const reason = (await screen.findByTestId("bulk-field-closedReason")) as HTMLSelectElement
    expect(reason.tagName).toBe("SELECT")
    expect(Array.from(reason.options).map((o) => o.textContent)).toEqual([
      "Resolved",
      "Duplicate",
      "Spam",
      "No response",
    ])
    // Defaulted to the first enum value so a no-touch submit is valid.
    expect(reason.value).toBe("resolved")
    // A non-enum shared-field stays a text input.
    expect((await screen.findByTestId("bulk-field-textBody")).tagName).toBe("INPUT")
  })

  it("submits the chosen enum value for a bulk close", async () => {
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 2, succeeded: 2, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-close"))
    const reason = await screen.findByTestId("bulk-field-closedReason")
    fireEvent.change(reason, { target: { value: "spam" } })
    fireEvent.click(screen.getByTestId("bulk-submit"))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.params.closedReason).toBe("spam")
  })

  it("drops empty shared fields from the payload so optional params use server defaults", async () => {
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 2, succeeded: 2, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-close"))
    const body_ = await screen.findByTestId("bulk-field-textBody")
    fireEvent.input(body_, { target: { value: "" } })
    fireEvent.click(screen.getByTestId("bulk-submit"))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.params).toEqual({ closedReason: "resolved" })
  })

  it("Esc collapses form first, then clears selection", async () => {
    const clear = vi.fn()
    const [sel] = createSignal<string[]>(["a"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear })
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-assign"))
    expect(screen.getByTestId("bulk-form")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("bulk-form")).toBeNull())
    expect(clear).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(clear).toHaveBeenCalled()
  })

  it("warns before submit when selection > 100 and offers Use first 100", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `t${i}`)
    const [sel, setSel] = createSignal<string[]>(ids)
    registerBulkUiSelection("tickets", "inbox", {
      accessor: sel,
      clear: () => {},
      replace: (next) => setSel(next),
    })
    const fetchMock = vi.fn().mockReturnValue(errorResponse(422, "BATCH_TOO_LARGE"))
    vi.stubGlobal("fetch", fetchMock)
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-assign"))
    const input = await screen.findByTestId("bulk-field-assignedTo")
    fireEvent.input(input, { target: { value: "u1" } })
    fireEvent.click(screen.getByTestId("bulk-submit"))
    await waitFor(() => expect(screen.getByTestId("bulk-error")).toBeInTheDocument())
    expect(screen.getByText(/Too many selected/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("bulk-use-first-100"))
    expect(sel()).toHaveLength(100)
  })

  it("renders outcome from numeric succeeded and failed response fields", async () => {
    const [sel] = createSignal<string[]>(["a", "b", "c"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 3, succeeded: 2, failed: 1, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-assign"))
    fireEvent.click(screen.getByTestId("bulk-submit"))
    await screen.findByTestId("bulk-outcome")
    expect(screen.getByTestId("bulk-outcome-succeeded")).toHaveTextContent("2 done")
    expect(screen.getByTestId("bulk-outcome-failed")).toHaveTextContent("1 failed")
  })

  it("renders customForm component when declared", async () => {
    const [sel] = createSignal<string[]>(["a", "b"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    registerBulkUiCustomForm("tickets", "merge", () => (
      <div data-testid="merge-form">Custom merge form</div>
    ))
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-merge"))
    expect(screen.getByTestId("merge-form")).toBeInTheDocument()
  })

  it("move: submits POST /api/apps/tickets/bulk/move dispatching the underlying ticketsMove tool", async () => {
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
    registerBulkUiCustomForm("tickets", "move", (props) => (
      <button
        type="button"
        data-testid="move-form-stub-submit"
        onClick={() => props.onSubmit({ toInboxId: "ibx2" })}
      >
        Move
      </button>
    ))
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 2, succeeded: 2, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-move"))
    fireEvent.click(screen.getByTestId("move-form-stub-submit"))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe("/api/apps/tickets/bulk/move")
    const body = JSON.parse(call[1].body)
    expect(body.ids).toEqual(["t1", "t2"])
    expect(body.params).toEqual({ toInboxId: "ibx2" })
  })

  it("projects setLabels: the custom form replaces the text field and posts the label map", async () => {
    registerManifestAppData("projects", {
      bulk: {
        setLabels: {
          label: "Set labels…",
          underlyingTool: "update",
          dispatchMode: "perItem",
          perItemParam: "taskId",
          sharedFields: ["labels"],
          agentTool: "bulkUpdate",
          customForm: "SetTaskLabelsForm",
        },
      },
    })
    const [sel] = createSignal<string[]>(["t1", "t2"])
    registerBulkUiSelection("projects", "project", { accessor: sel, clear: () => {} })
    registerBulkUiCustomForm("projects", "setLabels", (props) => (
      <button
        type="button"
        data-testid="set-labels-stub-submit"
        onClick={() => props.onSubmit({ labels: { "g-nature": "v-bug", "g-domain": null } })}
      >
        Set
      </button>
    ))
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 2, succeeded: 2, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)

    render(() => <BulkActionToolbar app="projects" viewId="project" />)
    fireEvent.click(screen.getByTestId("bulk-action-setLabels"))
    expect(screen.getByTestId("set-labels-stub-submit")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).toBeNull()
    // The custom form owns submit and cancel: no second Apply that would post
    // `params: {}` and report every task as updated.
    expect(screen.queryByTestId("bulk-submit")).toBeNull()
    expect(screen.queryByTestId("bulk-cancel")).toBeNull()
    fireEvent.click(screen.getByTestId("set-labels-stub-submit"))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe("/api/apps/projects/bulk/setLabels")
    const body = JSON.parse(call[1].body)
    expect(body.ids).toEqual(["t1", "t2"])
    expect(body.params).toEqual({ labels: { "g-nature": "v-bug", "g-domain": null } })
  })

  it("inactive tab: Escape does not clear selection", async () => {
    const clear = vi.fn()
    const [sel] = createSignal<string[]>(["a"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear })
    render(() => (
      <TabVisibilityProvider value={() => false}>
        <BulkActionToolbar app="tickets" viewId="inbox" />
      </TabVisibilityProvider>
    ))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(clear).not.toHaveBeenCalled()
  })

  it("active tab (explicit provider): Escape clears selection when resting", async () => {
    const clear = vi.fn()
    const [sel] = createSignal<string[]>(["a"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear })
    render(() => (
      <TabVisibilityProvider value={() => true}>
        <BulkActionToolbar app="tickets" viewId="inbox" />
      </TabVisibilityProvider>
    ))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it("outcome state auto-dismisses after 3s", async () => {
    vi.useFakeTimers()
    const [sel, setSel] = createSignal<string[]>(["a"])
    registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => setSel([]) })
    const fetchMock = vi
      .fn()
      .mockReturnValue(jsonResponse({ data: { total: 1, succeeded: 1, failed: 0, errors: [] } }))
    vi.stubGlobal("fetch", fetchMock)
    render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
    fireEvent.click(screen.getByTestId("bulk-action-assign"))
    const input = await screen.findByTestId("bulk-field-assignedTo")
    fireEvent.input(input, { target: { value: "u1" } })
    fireEvent.click(screen.getByTestId("bulk-submit"))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull())
  })
  describe("narrow widths: actions overflow into a More menu, nothing wraps", () => {
    const SEVEN = {
      close: "Close tickets…",
      assign: "Assign…",
      setPriority: "Change priority…",
      setAudience: "Set B2B / B2C…",
      setTeam: "Change team…",
      merge: "Merge…",
      move: "Move to inbox…",
    }
    let originalWidth: number
    let originalRect: typeof HTMLElement.prototype.getBoundingClientRect

    beforeEach(() => {
      resetRegistry()
      const bulk: Record<string, unknown> = {}
      for (const [action, label] of Object.entries(SEVEN)) {
        bulk[action] = {
          label,
          underlyingTool: action,
          dispatchMode: "perItem",
          perItemParam: "ticketId",
          sharedFields: ["note"],
        }
      }
      registerManifestAppData("tickets", { bulk } as never)
      originalWidth = window.innerWidth
      originalRect = HTMLElement.prototype.getBoundingClientRect
      // jsdom has no layout: give every text box a width proportional to its
      // label (7px per character plus the chip padding), like a real font.
      HTMLElement.prototype.getBoundingClientRect = function () {
        const width = (this.textContent?.length ?? 0) * 7 + 24
        return {
          width,
          height: 20,
          top: 0,
          left: 0,
          right: width,
          bottom: 20,
          x: 0,
          y: 0,
        } as DOMRect
      }
    })

    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = originalRect
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth })
    })

    function setViewport(width: number) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
      window.dispatchEvent(new Event("resize"))
    }

    it("at phone width shows the leading actions, moves the rest to a More menu, and never wraps a label", async () => {
      const [sel] = createSignal<string[]>(["t1", "t2"])
      registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
      setViewport(400)
      render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)

      const more = await screen.findByTestId("bulk-more-trigger")
      expect(more.getAttribute("aria-haspopup")).toBe("true")
      // The first declared action stays a visible chip; the last does not.
      expect(screen.getByTestId("bulk-action-close")).toBeInTheDocument()
      expect(screen.queryByTestId("bulk-action-move")).toBeNull()
      const visible = Object.keys(SEVEN).filter((a) => screen.queryByTestId(`bulk-action-${a}`))
      expect(visible.length).toBeGreaterThan(0)
      expect(visible.length).toBeLessThan(7)

      // Nothing in the resting row may wrap or shrink, and the bar is capped
      // to the viewport instead of the half viewport a centred fixed box gets.
      const toolbar = screen.getByTestId("bulk-toolbar")
      expect(toolbar.className).toContain("w-max")
      expect(toolbar.className).toContain("max-w-[calc(100vw-2rem)]")
      for (const el of [
        screen.getByTestId("bulk-selection-count"),
        more,
        ...visible.map((a) => screen.getByTestId(`bulk-action-${a}`)),
      ]) {
        expect(el.className).toContain("whitespace-nowrap")
        expect(el.className).toContain("shrink-0")
      }

      // The fitted row really fits: count + chips + More within 400 - gutters.
      const w = (el: Element) => (el.textContent?.length ?? 0) * 7 + 24
      const used =
        w(screen.getByTestId("bulk-selection-count")) +
        visible.reduce((sum, a) => sum + w(screen.getByTestId(`bulk-action-${a}`)), 0) +
        w(more) +
        12 * (visible.length + 1)
      expect(used).toBeLessThanOrEqual(400 - 32 - 34)

      // The overflow is a real menu: keyboard opens it, items are menuitems,
      // and choosing one opens that action's form.
      fireEvent.keyDown(more, { key: "Enter" })
      const item = await screen.findByTestId("bulk-overflow-move")
      expect(item.getAttribute("role")).toBe("menuitem")
      expect(item.textContent).toContain("Move to inbox…")
      fireEvent.keyDown(item, { key: "Enter" })
      await screen.findByTestId("bulk-form")
    })

    it("at desktop width shows every action inline with no More menu", async () => {
      const [sel] = createSignal<string[]>(["t1", "t2"])
      registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
      setViewport(1440)
      render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
      for (const a of Object.keys(SEVEN)) {
        expect(await screen.findByTestId(`bulk-action-${a}`)).toBeInTheDocument()
      }
      expect(screen.queryByTestId("bulk-more-trigger")).toBeNull()
    })

    it("widening the viewport brings overflowed actions back inline", async () => {
      const [sel] = createSignal<string[]>(["t1", "t2"])
      registerBulkUiSelection("tickets", "inbox", { accessor: sel, clear: () => {} })
      setViewport(400)
      render(() => <BulkActionToolbar app="tickets" viewId="inbox" />)
      await screen.findByTestId("bulk-more-trigger")
      setViewport(1440)
      await waitFor(() => expect(screen.queryByTestId("bulk-more-trigger")).toBeNull())
      expect(screen.getByTestId("bulk-action-move")).toBeInTheDocument()
    })
  })
})
