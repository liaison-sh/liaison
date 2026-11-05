// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  entityPreviewRegistry,
  registerEntityPreview,
} from "~/modules/shell/entity-preview/registry"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
}))

vi.mock("~/modules/shell/entity-preview/EntityPreview", () => ({
  default: (props: any) => (
    <span
      data-testid="entity-preview"
      data-app={props.app}
      data-entity-type={props.entityType}
      data-entity-id={props.entityId}
    >
      {props.children}
    </span>
  ),
}))

import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { openTab } from "~/modules/shell/tab-store"
import MessageList from "~/modules/threads/MessageList"
import { loadMessagesIntoStore } from "~/modules/threads/message-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve("{}"),
    }),
  ),
)

function renderMessageList(content: string) {
  loadMessagesIntoStore("thread-mentions", [
    {
      id: "m-1",
      threadId: "thread-mentions",
      authorId: "u1",
      authorName: "Alex",
      authorAvatarUrl: null,
      authorType: "user",
      authorAgentId: null,
      content,
      mentions: null,
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(2024, 0, 1, 12, 0).toISOString(),
    },
  ])

  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={() => true}>
              <div style={{ height: "320px" }}>
                <MessageList threadId="thread-mentions" currentUserId="u1" />
              </div>
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeAll(() => {
  entityPreviewRegistry.clear()
  // Register kernel preview renderers used by these tests. In the real app
  // these are registered at boot (kernel) or via loadManifestApps (manifest apps).
  registerEntityPreview({
    app: "kernel",
    entityType: "contact",
    fetch: async () => ({}),
    render: () => <div />,
  })
  registerEntityPreview({
    app: "kernel",
    entityType: "user",
    fetch: async () => ({}),
    render: () => <div />,
  })
  registerEntityPreview({
    app: "kernel",
    entityType: "thread",
    fetch: async () => ({}),
    render: () => <div />,
  })
  registerEntityPreview({
    app: "kernel",
    entityType: "approval_request",
    fetch: async () => ({}),
    render: () => <div />,
  })
  registerEntityPreview({
    app: "tickets",
    entityType: "ticket",
    fetch: async () => ({}),
    render: () => <div />,
  })
})

describe("MessageList mentions", () => {
  afterEach(() => {
    loadMessagesIntoStore("thread-mentions", [])
    vi.mocked(openTab).mockReset()
    cleanup()
  })

  it("renders thread mentions with # prefix (threads are entities, not people)", () => {
    renderMessageList("See @[Release Plan](thread:t-123)")

    const mention = screen.getByText("#Release Plan")
    // # prefix for thread mentions — @ is reserved for user (person) mentions
    expect(mention).toHaveAttribute("data-mention-ref", "thread:t-123")
    expect(mention).toHaveClass("mention-actionable")
  })

  it("renders entity mentions with # prefix", () => {
    renderMessageList("Review @[Acme Corp](crm:account:acct-7)")

    const mention = screen.getByText("#Acme Corp")
    // # prefix for entity mentions — @ is reserved for user (person) mentions
    expect(mention).toHaveAttribute("data-mention-ref", "crm:account:acct-7")
    expect(mention).toHaveClass("mention-actionable")
  })

  it("opens entity mentions through the tab registry", () => {
    renderMessageList("Review @[Acme Corp](crm:account:acct-7)")

    fireEvent.click(screen.getByText("#Acme Corp"))

    expect(openTab).toHaveBeenCalledWith({
      type: "crm:account",
      entityId: "acct-7",
      label: "Acme Corp",
    })
  })

  // Agent-authored entity tags: the knowledge tools hand the agent a
  // ready-made `@[Title](knowledge:document:<id>)` mentionTag; pasted into a
  // reply it must render as an actionable pill that opens the document tab
  // via the registered ("knowledge","document") entity opener.
  it("opens knowledge document tags via the registered entity opener", async () => {
    const { registerEntityOpener } = await import("~/framework/app-registry")
    registerEntityOpener("knowledge", "document", (_api, id) => ({
      tabType: "knowledge:document",
      entityId: id,
    }))
    renderMessageList("Created @[2025 ASP](knowledge:document:614a53c8) in Finance")

    const pill = screen.getByText("#2025 ASP")
    expect(pill).toHaveAttribute("data-mention-ref", "knowledge:document:614a53c8")
    expect(pill).toHaveClass("mention-actionable")

    fireEvent.click(pill)
    await vi.waitFor(() => {
      expect(openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: "knowledge:document", entityId: "614a53c8" }),
      )
    })
  })

  it("wraps contact mentions with EntityPreview", () => {
    renderMessageList("Email @[Alice](kernel:contact:c1)")

    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "contact")
    expect(preview).toHaveAttribute("data-entity-id", "c1")
    expect(screen.getByText("#Alice")).toHaveAttribute("data-mention-ref", "kernel:contact:c1")
  })

  it("renders user mentions with @ prefix (non-actionable)", () => {
    renderMessageList("Assigned to @[Pat](user:u-2)")

    // @ prefix for user (person) mentions only
    expect(screen.queryByRole("button", { name: /Pat/ })).not.toBeInTheDocument()
    expect(screen.getByText("@Pat")).toBeInTheDocument()
  })

  it("wraps kernel:user mentions in EntityPreview", () => {
    renderMessageList("Cc @[Alice](kernel:user:u1)")
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "user")
    expect(preview).toHaveAttribute("data-entity-id", "u1")
    expect(screen.getByText("@Alice")).toHaveAttribute("data-mention-ref", "kernel:user:u1")
  })

  it("wraps kernel:thread mentions in EntityPreview", () => {
    renderMessageList("See @[Release](kernel:thread:t1)")
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-entity-type", "thread")
    expect(preview).toHaveAttribute("data-entity-id", "t1")
  })

  it("wraps kernel:approval_request mentions in EntityPreview", () => {
    renderMessageList("Review @[Approval](kernel:approval_request:ar1)")
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-entity-type", "approval_request")
    expect(preview).toHaveAttribute("data-entity-id", "ar1")
  })

  it("wraps multiple app:type mentions in their respective EntityPreviews", () => {
    renderMessageList("Cc @[Alice](kernel:user:u1) about @[tk-42](tickets:ticket:t1)")
    const previews = screen.getAllByTestId("entity-preview")
    expect(previews).toHaveLength(2)
    expect(previews[0]).toHaveAttribute("data-entity-type", "user")
    expect(previews[1]).toHaveAttribute("data-entity-type", "ticket")
  })

  it("wraps legacy user refs with kernel user previews", () => {
    renderMessageList("Cc @[Alice](user:u1)")
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "user")
    expect(preview).toHaveAttribute("data-entity-id", "u1")
    expect(screen.getByText("@Alice")).toHaveAttribute("data-mention-ref", "user:u1")
  })

  it("wraps legacy thread refs with kernel thread previews and keeps thread click behavior", () => {
    renderMessageList("See @[Release Plan](thread:t-123)")
    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "thread")
    expect(preview).toHaveAttribute("data-entity-id", "t-123")

    fireEvent.click(screen.getByText("#Release Plan"))
    expect(openTab).toHaveBeenCalledWith({
      type: "thread",
      entityId: "t-123",
      label: "Release Plan",
    })
  })
})
