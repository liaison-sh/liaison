// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Shipments search box, rendered under a <Suspense> the way the shell's tab
// boundary wraps it. Typing a name used to refetch on every keystroke through a
// resource read during render, so the tab's boundary swapped the whole page
// (search box included) for its fallback on each letter. Pinned here: typing
// keeps the same focused input and its value, never suspends the page, sends
// one debounced search, keeps the current list visible while it loads, and
// never lets an older response overwrite a newer one.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface Deferred {
  query: string
  resolve: (value: unknown) => void
}

const searches: Deferred[] = []

const openRecord = vi.hoisted(() => ({ entityType: "", id: (): string | null | undefined => null }))

vi.mock("@liaison/host", () => ({
  currentPath: () => `${window.location.pathname}${window.location.search}`,
  app: {
    trackOpenRecord: (entityType: string, id: () => string | null | undefined) => {
      openRecord.entityType = entityType
      openRecord.id = id
    },
    invokeTool: (name: string, args: { query?: string }) => {
      if (name === "search") {
        return new Promise((resolve) => searches.push({ query: args.query ?? "", resolve }))
      }
      if (name === "get_documents") return Promise.resolve({ documents: [] })
      return Promise.reject(new Error(`no ${name}`))
    },
  },
}))

function row(id: string, title: string) {
  return {
    id,
    title,
    attributes: {
      order_status: "CONFIRMED",
      tracking_status: "IN_TRANSIT",
      carrier: "Carrier",
      declared_value: 10,
      currency: "EUR",
      document_ref: null,
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let suspended = 0
function Fallback() {
  suspended++
  return <div data-testid="tab-suspended" />
}

async function mount() {
  const { Shipments } = await import("./Shipments")
  render(() => (
    <Suspense fallback={<Fallback />}>
      <Shipments />
    </Suspense>
  ))
  await flush()
  expect(searches.map((s) => s.query)).toEqual([""])
  searches[0]?.resolve({ results: [row("s1", "Alice Martin"), row("s2", "Bruno Costa")] })
  await flush()
  await flush()
  expect(screen.getByTestId("boxtal-shipment-row-s1")).toBeTruthy()
  suspended = 0
}

function type(input: HTMLInputElement, value: string) {
  input.value = value
  fireEvent.input(input)
}

beforeEach(() => {
  searches.length = 0
  suspended = 0
  window.history.replaceState({}, "", "/boxtal/shipments")
})
afterEach(() => cleanup())

describe("the record the agent is told is open", () => {
  const stubWidth = (wide: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: wide && query === "(min-width: 640px)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  afterEach(() => vi.unstubAllGlobals())

  it("is the row in the detail pane: the first by default, then the one clicked", async () => {
    stubWidth(true)
    await mount()
    expect(openRecord.entityType).toBe("shipment")
    expect(openRecord.id()).toBe("s1")
    fireEvent.click(screen.getByTestId("boxtal-shipment-row-s2"))
    expect(openRecord.id()).toBe("s2")
  })

  it("is nothing on a phone, where the pane is not on screen", async () => {
    stubWidth(false)
    await mount()
    expect(openRecord.id()).toBeNull()
  })
})

describe("Shipments search box", () => {
  it("typing keeps the input focused and mounted, never suspends, and sends one debounced search", async () => {
    await mount()
    const input = screen.getByTestId("boxtal-shipments-search") as HTMLInputElement
    input.focus()

    for (const value of ["c", "co", "cos", "cost"]) {
      type(input, value)
      await wait(40)
      // Same node, still focused, still holding what was typed.
      expect(screen.getByTestId("boxtal-shipments-search")).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe(value)
    }
    // Nothing is fetched until the typing pauses.
    expect(searches.length).toBe(1)

    await wait(300)
    expect(searches.map((s) => s.query)).toEqual(["", "cost"])

    // While the search runs, the previous list stays on screen and the page
    // never falls back to the tab's suspense boundary.
    expect(screen.getByTestId("boxtal-shipment-row-s1")).toBeTruthy()
    expect(screen.queryByTestId("boxtal-shipments-loading")).toBeNull()
    expect(screen.getByTestId("boxtal-shipments-results").getAttribute("aria-busy")).toBe("true")

    searches[1]?.resolve({ results: [row("s2", "Bruno Costa")] })
    await flush()
    await flush()
    expect(screen.queryByTestId("boxtal-shipment-row-s1")).toBeNull()
    expect(screen.getByTestId("boxtal-shipment-row-s2")).toBeTruthy()
    expect(screen.getByTestId("boxtal-shipments-search")).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(suspended).toBe(0)
    expect(screen.queryByTestId("tab-suspended")).toBeNull()
  })

  it("a slow older response never overwrites a newer one", async () => {
    await mount()
    const input = screen.getByTestId("boxtal-shipments-search") as HTMLInputElement

    type(input, "al")
    await wait(300)
    type(input, "bru")
    await wait(300)
    expect(searches.map((s) => s.query)).toEqual(["", "al", "bru"])

    searches[2]?.resolve({ results: [row("s2", "Bruno Costa")] })
    await flush()
    searches[1]?.resolve({ results: [row("s1", "Alice Martin")] })
    await flush()
    await flush()

    expect(screen.getByTestId("boxtal-shipment-row-s2")).toBeTruthy()
    expect(screen.queryByTestId("boxtal-shipment-row-s1")).toBeNull()
    expect(screen.getByTestId("boxtal-shipments-results").getAttribute("aria-busy")).toBe("false")
    expect(suspended).toBe(0)
  })

  it("typing back to the search on screen sends no request", async () => {
    await mount()
    const input = screen.getByTestId("boxtal-shipments-search") as HTMLInputElement
    type(input, "a")
    await wait(20)
    type(input, "")
    await wait(300)
    type(input, "  ")
    await wait(300)
    expect(searches.length).toBe(1)
  })
})
