// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import AgentTurnBlock from "./AgentTurnBlock"

describe("AgentTurnBlock", () => {
  describe("the person's message the turn answers (data-turn-id)", () => {
    it("a live turn an approval handed back marks its answer and tool rows with the ask", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[{ toolCallId: "tc1", toolName: "web_search", status: "completed" }]}
          content="Here are the sources."
          turnId="result-row"
          askId="ask-1"
        />
      ))
      expect(screen.getByTestId("agent-answer").dataset.turnId).toBe("ask-1")
      const row = container.querySelector('[data-testid="tool-call-row"]') as HTMLElement
      expect(row.dataset.turnId).toBe("ask-1")
    })

    it("a saved turn reads the ask off its metadata, else its turn", () => {
      render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content="Answer."
          metadata={{ turnId: "result-row", askId: "ask-1" }}
        />
      ))
      expect(screen.getByTestId("agent-answer").dataset.turnId).toBe("ask-1")
    })

    it("an ordinary turn keeps its own turn id", () => {
      render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="Answer." turnId="ask-2" />
      ))
      expect(screen.getByTestId("agent-answer").dataset.turnId).toBe("ask-2")
    })
  })

  describe("expanded mode", () => {
    it("renders all tool calls inline", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[
            { toolCallId: "tc1", toolName: "search_threads", status: "completed" },
            { toolCallId: "tc2", toolName: "get_thread", status: "completed" },
          ]}
          content="Found the thread."
        />
      ))
      expect(screen.getByText("Search Threads")).toBeInTheDocument()
      expect(screen.getByText("Get Thread")).toBeInTheDocument()
      // streaming-markdown splits text across DOM nodes — check textContent instead
      expect(container.textContent).toContain("Found the thread.")
    })

    it("shows streaming cursor when isStreaming", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content="Hello"
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      expect(container.textContent).toContain("▋")
    })

    it("shows Generating... when streaming with all tools completed but no text yet", () => {
      render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[{ toolCallId: "tc1", toolName: "search_threads", status: "completed" }]}
          content=""
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      expect(screen.getByText("Generating...")).toBeInTheDocument()
    })

    it("shows Generating... immediately after send, before any tool/reasoning/text arrives", () => {
      render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content=""
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      expect(screen.getByText("Generating...")).toBeInTheDocument()
    })

    it("hides Generating... while a tool call is still running", () => {
      render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[{ toolCallId: "tc1", toolName: "search_threads", status: "running" }]}
          content=""
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      expect(screen.queryByText("Generating...")).not.toBeInTheDocument()
    })

    it("renders content that arrives after mount while streaming", async () => {
      const [content, setContent] = createSignal("")
      const view = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content={content()}
          isStreaming={true}
          isLastMessage={true}
        />
      ))

      setContent("Streaming hello")

      await screen.findByText("▋")
      expect(view.container.textContent).toContain("Streaming hell")
    })

    // A Discuss reply streamed in reading "[Client Feedback]" with the brackets
    // on screen: the finished turn is drawn by marked, which knows the mention
    // grammar, but a turn still arriving is drawn by streaming-markdown, which
    // has only the CommonMark link rule and mangled the same reference.
    it("renders a mention reference as a reference, with no raw syntax left over", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content="I have read @[Client Feedback](mail:conversation:c1) and replied."
        />
      ))
      const anchor = container.querySelector("a[href='mail:conversation:c1']") as HTMLElement
      expect(anchor).toBeTruthy()
      expect(anchor.textContent).toBe("Client Feedback")
      expect(container.textContent?.trim()).toBe("I have read Client Feedback and replied.")
    })

    it("absorbs brackets an agent wrapped around the reference", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content="I have read [@[Client Feedback](mail:conversation:c1)] and replied."
        />
      ))
      const anchor = container.querySelector("a[href='mail:conversation:c1']") as HTMLElement
      expect(anchor.textContent).toBe("Client Feedback")
      expect(container.textContent?.trim()).toBe("I have read Client Feedback and replied.")
    })

    it("does not commit a half arrived reference as text", async () => {
      const [content, setContent] = createSignal("")
      const view = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content={content()}
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      setContent("I have read @[Client Fee")
      await Promise.resolve()
      expect(view.container.textContent).not.toContain("@[Client Fee")
      setContent("I have read @[Client Feedback](mail:conversation:c1) and replied.")
      await Promise.resolve()
      expect(view.container.querySelector("a[href='mail:conversation:c1']")?.textContent).toBe(
        "Client Feedback",
      )
      expect(view.container.textContent).not.toContain("@[")
    })
  })

  describe("interleaved timeline", () => {
    const toolCalls = [
      { toolCallId: "tc1", toolName: "search_threads", status: "completed" as const },
      { toolCallId: "tc2", toolName: "get_thread", status: "completed" as const },
    ]

    it("renders tool calls between the reasoning segments they were invoked from", () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={toolCalls}
          content="Done."
          timeline={[
            { kind: "reasoning", text: "First I look for the thread." },
            { kind: "tool", toolCallId: "tc1" },
            { kind: "reasoning", text: "Now I open it." },
            { kind: "tool", toolCallId: "tc2" },
          ]}
        />
      ))

      // Two distinct thinking affordances (one per reasoning segment), with a tool
      // call anchored between them — not both tools dumped after all thinking.
      const thoughts = container.querySelectorAll('[data-testid="thinking-block"]')
      expect(thoughts.length).toBe(2)

      const order = Array.from(
        container.querySelectorAll('[data-testid="thinking-block"], [data-testid="tool-call-row"]'),
      ).map((el) =>
        el.getAttribute("data-testid") === "tool-call-row"
          ? el.getAttribute("data-tool-name")
          : "thought",
      )
      expect(order).toEqual(["thought", "search_threads", "thought", "get_thread"])
    })

    it("falls back to flat layout when no timeline is present", () => {
      render(() => <AgentTurnBlock mode="expanded" toolCalls={toolCalls} content="Done." />)
      // Both tools still render (grouping unaffected); order is source order.
      expect(screen.getByText("Search Threads")).toBeInTheDocument()
      expect(screen.getByText("Get Thread")).toBeInTheDocument()
    })
  })

  describe("link href sanitization", () => {
    it("strips javascript: href from markdown links", async () => {
      const { container } = render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="[click me](javascript:alert(1))" />
      ))
      await screen.findByText("click me")
      const anchor = container.querySelector("a")
      expect(anchor?.getAttribute("href")).not.toContain("javascript:")
    })

    it("strips data: href from markdown links", async () => {
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content="[bad](data:text/html,<script>alert(1)</script>)"
        />
      ))
      await screen.findByText("bad")
      const anchor = container.querySelector("a")
      expect(anchor?.getAttribute("href")).not.toContain("data:")
    })

    it("preserves https: href in markdown links", async () => {
      const { container } = render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="[safe](https://example.com)" />
      ))
      await screen.findByText("safe")
      const anchor = container.querySelector("a")
      expect(anchor?.getAttribute("href")).toBe("https://example.com")
    })

    it("adds rel=noopener noreferrer to external https links", async () => {
      const { container } = render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="[external](https://example.com)" />
      ))
      await screen.findByText("external")
      const anchor = container.querySelector("a")
      expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer")
      expect(anchor?.getAttribute("target")).toBe("_blank")
    })

    it("strips vbscript: href from markdown links", async () => {
      const { container } = render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="[xss](vbscript:msgbox(1))" />
      ))
      await screen.findByText("xss")
      const anchor = container.querySelector("a")
      expect(anchor?.getAttribute("href")).not.toContain("vbscript:")
    })
  })

  describe("collapsed mode", () => {
    it("renders Liaison header and tool summary", () => {
      render(() => (
        <AgentTurnBlock
          mode="collapsed"
          toolCalls={[
            { toolCallId: "tc1", toolName: "search_threads", status: "completed" },
            { toolCallId: "tc2", toolName: "get_thread", status: "completed" },
          ]}
          content="Found the thread."
        />
      ))
      expect(screen.getByText(/Liaison/)).toBeInTheDocument()
      expect(screen.getByText(/Used 2 tools/)).toBeInTheDocument()
      expect(screen.getByText("Found the thread.")).toBeInTheDocument()
    })

    it("hides tool summary when no tool calls", () => {
      render(() => <AgentTurnBlock mode="collapsed" toolCalls={[]} content="Just text response." />)
      expect(screen.getByText(/Liaison/)).toBeInTheDocument()
      expect(screen.getByText("Just text response.")).toBeInTheDocument()
      expect(screen.queryByText(/Used/)).not.toBeInTheDocument()
    })

    it("expands tool list on click", async () => {
      render(() => (
        <AgentTurnBlock
          mode="collapsed"
          toolCalls={[{ toolCallId: "tc1", toolName: "search_threads", status: "completed" }]}
          content="Result text."
        />
      ))
      const trigger = screen.getByText(/Used 1 tool/)
      await fireEvent.click(trigger)
      expect(screen.getByText("Search Threads")).toBeInTheDocument()
    })
  })
  // P6d-T11: a local turn is a turn. Its tool calls render as the agent's own
  // activity, through the same row component, with no pane and no second
  // scroll region anywhere.
  describe("local turn activity", () => {
    afterEach(() => uninstallFakeBridge())

    // P6d-FX1 (SK-3): the guard was `isDesktop() && isStreaming`, which never
    // asked WHICH conversation the live session belongs to.
    it("another conversation's local tool rows never render in this turn", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_01",
              toolName: "Read",
              summary: "src/secrets.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
        }),
      )
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content=""
          isStreaming={true}
          isLastMessage={true}
          threadId="t2"
        />
      ))
      expect(container.querySelectorAll('[data-testid="tool-call-row"]').length).toBe(0)
    })

    it("a turn in no conversation at all renders no local rows", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_01",
              toolName: "Read",
              summary: "src/secrets.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
        }),
      )
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content=""
          isStreaming={true}
          isLastMessage={true}
        />
      ))
      expect(container.querySelectorAll('[data-testid="tool-call-row"]').length).toBe(0)
    })

    it("agent turn block renders local tool rows through the same row component", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_01",
              toolName: "Read",
              summary: "src/main.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
        }),
      )
      const cloud = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[{ toolCallId: "tc1", toolName: "search_threads", status: "running" }]}
          content=""
          isStreaming={true}
          isLastMessage={true}
          threadId="t1"
        />
      ))
      const rows = cloud.container.querySelectorAll('[data-testid="tool-call-row"]')
      expect(rows.length).toBe(2)
      expect(Array.from(rows).map((row) => row.getAttribute("data-tool-name"))).toEqual([
        "search_threads",
        "Read",
      ])
      expect(screen.getByText("Read")).toBeInTheDocument()
    })

    it("a running local tool keeps the generating dots away", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_01",
              toolName: "Bash",
              summary: "bun run build",
              status: "running",
              startedAt: 1_000,
            },
          ],
        }),
      )
      render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[]}
          content=""
          isStreaming={true}
          isLastMessage={true}
          threadId="t1"
        />
      ))
      expect(screen.queryByText("Generating...")).toBeNull()
    })

    it("a settled turn shows no local rows, even while the session is live", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_01",
              toolName: "Read",
              summary: "src/main.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
        }),
      )
      const { container } = render(() => (
        <AgentTurnBlock mode="expanded" toolCalls={[]} content="All done." threadId="t1" />
      ))
      expect(container.querySelectorAll('[data-testid="tool-call-row"]').length).toBe(0)
    })

    it("agent turn block renders no local rows in a browser", () => {
      uninstallFakeBridge()
      const { container } = render(() => (
        <AgentTurnBlock
          mode="expanded"
          toolCalls={[{ toolCallId: "tc1", toolName: "search_threads", status: "running" }]}
          content=""
          isStreaming={true}
          isLastMessage={true}
          threadId="t1"
        />
      ))
      expect(container.querySelectorAll('[data-testid="tool-call-row"]').length).toBe(1)
    })
  })
})
