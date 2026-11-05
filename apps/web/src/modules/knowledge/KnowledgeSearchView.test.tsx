// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import KnowledgeSearchView from "./KnowledgeSearchView"
import {
  resetKnowledgeStore,
  setKnowledgeSearchLoading,
  setKnowledgeSourceStatuses,
} from "./knowledge-store"

const SOURCE_STATES = [
  "complete",
  "partial",
  "error",
  "rate-limited",
  "unauthorized",
  "loading",
  "skipped",
  "pending",
] as const

afterEach(() => {
  resetKnowledgeStore()
  vi.useRealTimers()
})

describe("KnowledgeSearchView", () => {
  it("debounces keystrokes to a single search call (IF-3)", async () => {
    vi.useFakeTimers()
    const post = vi.fn().mockResolvedValue({ hits: [], sourceStatuses: [], final: true })
    const api = { post, get: vi.fn() } as never
    render(() => <KnowledgeSearchView api={api} />)
    const input = screen.getByTestId("knowledge-search-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "a" } })
    fireEvent.input(input, { target: { value: "ab" } })
    fireEvent.input(input, { target: { value: "abc" } })
    vi.advanceTimersByTime(100)
    expect(post).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  })

  it("renders calm semantic tokens, not raw text-emerald/amber/rose (IF-2)", () => {
    setKnowledgeSourceStatuses([
      { source: "knowledge", state: "complete", retryable: false },
      { source: "google-drive", state: "partial", retryable: true },
      { source: "x", state: "error", retryable: false },
    ])
    const api = { post: vi.fn(), get: vi.fn() } as never
    render(() => <KnowledgeSearchView api={api} />)
    expect(document.querySelector(".text-emerald-600")).toBeNull()
    expect(document.querySelector(".text-amber-600")).toBeNull()
    expect(document.querySelector(".text-rose-600")).toBeNull()
  })

  it("shows loading indicator while searchLoading=true (IF-4)", async () => {
    const api = { post: vi.fn(), get: vi.fn() } as never
    render(() => <KnowledgeSearchView api={api} />)
    setKnowledgeSearchLoading(true)
    expect(await screen.findByTestId("knowledge-search-loading")).toBeInTheDocument()
  })

  it("shows retry button when retryable=true (IF-4)", async () => {
    setKnowledgeSourceStatuses([
      { source: "google-drive", state: "rate-limited", retryable: true, message: "soon" },
    ])
    const api = { post: vi.fn(), get: vi.fn() } as never
    render(() => <KnowledgeSearchView api={api} />)
    const btn = await screen.findByTestId("knowledge-source-retry-google-drive")
    expect(btn).toBeInTheDocument()
  })

  it("renders all 8 documented source states without crashing (MT-4)", () => {
    setKnowledgeSourceStatuses(
      SOURCE_STATES.map((state) => ({ source: state, state: state as never, retryable: false })),
    )
    const api = { post: vi.fn(), get: vi.fn() } as never
    render(() => <KnowledgeSearchView api={api} />)
    for (const state of SOURCE_STATES) {
      expect(screen.getByTestId(`knowledge-source-status-${state}`)).toBeInTheDocument()
    }
  })
})
