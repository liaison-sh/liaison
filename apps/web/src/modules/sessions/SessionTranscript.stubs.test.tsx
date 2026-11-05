// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S58 (owner D34): a large content the store holds as a stub (a long
// message, an elided output) is read back only while its row is on screen,
// and let go when the row scrolls away. Rows keep their identity throughout.

import type { NodeSessionEvent } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetInView } from "./in-view"
import SessionTranscript from "./SessionTranscript"
import type { NodeSessionRow } from "./session-api"
import { resetSessionStore, setSessionStoreApi } from "./session-store"

const T0 = Date.parse("2026-10-15T10:00:00.000Z")
const SID = "3f2a9c1e-0000-4000-8000-0000000000aa"

type Held = NodeSessionEvent & { clientReceivedAt: number }

function ev(seq: number, type: NodeSessionEvent["type"], payload: Record<string, unknown>): Held {
  const at = new Date(T0 + seq * 1000).toISOString()
  return { seq, at, receivedAt: at, type, payload, clientReceivedAt: T0 + seq * 1000 + 50 }
}

function row(): NodeSessionRow {
  return {
    id: SID,
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Stubs",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-5-5",
    level: "strict",
    status: "done",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 3,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-10-15T10:00:00.000Z",
  }
}

/** A controllable IntersectionObserver: the test says which rows are on screen. */
class FakeObserver {
  static all: FakeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  static show(el: Element, visible: boolean) {
    for (const o of FakeObserver.all) {
      if (!o.targets.has(el)) continue
      o.cb(
        [{ target: el, isIntersecting: visible } as IntersectionObserverEntry],
        o as unknown as IntersectionObserver,
      )
    }
  }
}

const WHOLE = "The whole explanation, every paragraph of it. ".repeat(200)
const PREVIEW = WHOLE.slice(0, 600)
const OUTPUT = "build line\n".repeat(900)

function events(): Held[] {
  return [
    ev(1, "assistant_text", { text: PREVIEW, textElided: { chars: WHOLE.length } }),
    ev(2, "tool_call", { id: "toolu_b", name: "Bash", input: { command: "make" } }),
    ev(3, "tool_result", {
      id: "toolu_b",
      output: "",
      elided: { chars: OUTPUT.length, lines: 900 },
    }),
  ]
}

function api() {
  const get = vi.fn(async (path: string) => {
    const after = Number(new URLSearchParams(path.split("?")[1]).get("after"))
    const full = [
      ev(1, "assistant_text", { text: WHOLE }),
      ev(3, "tool_result", { id: "toolu_b", output: OUTPUT }),
    ]
    return { events: full.filter((e) => e.seq === after + 1), lastSeq: 3 }
  })
  setSessionStoreApi(() => ({ get }) as never)
  return get
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  FakeObserver.all = []
  ;(globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver
  _resetInView()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).IntersectionObserver
  _resetInView()
  resetSessionStore()
})

describe("S58: stubs are read back on screen only", () => {
  it("S58: a long message's stub shows its start off screen; scrolled into view its whole text is read by seq; scrolled away it is let go", async () => {
    const get = api()
    render(() => <SessionTranscript session={row()} events={events()} />)
    const text = screen.getByTestId("text-row")
    expect(text.dataset.elided).toBe("true")
    await flush()
    expect(get).not.toHaveBeenCalled()
    expect(text.textContent).toContain(`${PREVIEW.trim()}…`)
    expect(text.textContent).not.toContain(WHOLE.trim())

    FakeObserver.show(text, true)
    await vi.waitFor(() => expect(text.textContent).toContain(WHOLE.trim()))
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(`/me/node-sessions/${SID}/events?after=0&limit=1&scope=top`)

    FakeObserver.show(text, false)
    await vi.waitFor(() => expect(text.textContent).not.toContain(WHOLE.trim()))
    // The same row element throughout (keyed rows).
    expect(screen.getByTestId("text-row")).toBe(text)
  })

  it("S58: an open row's elided output is read only once the row is on screen", async () => {
    const get = api()
    render(() => <SessionTranscript session={row()} events={events()} />)
    const tool = screen.getByTestId("tool-row")
    fireEvent.click(tool.querySelector("button[aria-expanded]") as HTMLElement)
    await flush()
    expect(get).not.toHaveBeenCalled()
    expect(tool.textContent).not.toContain("build line")
    FakeObserver.show(tool, true)
    await vi.waitFor(() => expect(tool.textContent).toContain("build line"))
    expect(get).toHaveBeenCalledWith(`/me/node-sessions/${SID}/events?after=2&limit=1&scope=top`)
    FakeObserver.show(tool, false)
    await vi.waitFor(() => expect(tool.textContent).not.toContain("build line"))
    expect(tool.dataset.open).toBe("true")
  })

  it.each([
    ["no CSS scroll anchoring, as in WKWebView", false],
    ["the engine's own scroll anchoring, as in Chromium (never twice)", true],
  ])(
    "S58 (batch-5 F4): a long message above the viewport turning whole and back into its stub never moves what the reader sees (%s)",
    async (_engine, anchoring) => {
      api()
      render(() => (
        <div data-testid="scroller" style={{ "overflow-y": "auto" }}>
          <SessionTranscript session={row()} events={events()} />
        </div>
      ))
      const scroller = screen.getByTestId("scroller")
      // Layout, mocked: the viewport starts at 0; the row sits 1,000 px down the
      // content, 1 px of height per 10 characters (or its reserved min-height).
      let scrollTop = 10_000
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v
        },
      })
      scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect
      const text = screen.getByTestId("text-row")
      let laidOut: number | null = null
      text.getBoundingClientRect = () => {
        const height = Math.max(
          Number.parseFloat(text.style.minHeight) || 0,
          (text.textContent ?? "").length / 10,
        )
        // An anchoring engine moves the scroller itself when a row above the viewport changes.
        if (anchoring && laidOut !== null && height !== laidOut) scrollTop += height - laidOut
        laidOut = height
        const top = 1_000 - scrollTop
        return { top, bottom: top + height, height } as DOMRect
      }
      const onScreen = () => text.getBoundingClientRect().bottom
      const before = onScreen()
      const stubHeight = text.getBoundingClientRect().height

      FakeObserver.show(text, true)
      await vi.waitFor(() => expect(text.textContent).toContain(WHOLE.trim()))
      await flush()
      expect(text.getBoundingClientRect().height).toBeGreaterThan(stubHeight * 5)
      expect(onScreen()).toBe(before)

      FakeObserver.show(text, false)
      await vi.waitFor(() => expect(text.textContent).not.toContain(WHOLE.trim()))
      await flush()
      expect(onScreen()).toBe(before)

      FakeObserver.show(text, true)
      await vi.waitFor(() => expect(text.textContent).toContain(WHOLE.trim()))
      await flush()
      expect(onScreen()).toBe(before)
    },
  )
})
