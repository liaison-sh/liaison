// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { bootstrapKernelApps } from "~/framework/bootstrap"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import KnowledgeLinkedSourceView from "./KnowledgeLinkedSourceView"
import { resetKnowledgeStore } from "./knowledge-store"

beforeAll(() => bootstrapKernelApps())

afterEach(() => {
  resetKnowledgeStore()
  resetTabStore()
})

describe("KnowledgeLinkedSourceView", () => {
  it("renders title, source badge, open-original link, and link metadata (BS-3)", async () => {
    const api = {
      get: vi.fn(async () => ({
        id: "lnk1",
        title: "Doc",
        source: "google-drive",
        url: "https://x",
        reviewStatus: "verified",
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeLinkedSourceView entityId="lnk1" />
      </ApiContext.Provider>
    ))
    expect(await screen.findByTestId("knowledge-linked-title")).toHaveTextContent("Doc")
    expect(screen.getByTestId("knowledge-linked-open-original")).toHaveAttribute(
      "href",
      "https://x",
    )
    expect(screen.getByTestId("knowledge-linked-source-badge")).toHaveTextContent("google-drive")
  })

  it("updates tab label once title resolves", async () => {
    const api = {
      get: vi.fn(async () => ({ id: "lnk1", title: "Q3 Plan", source: "drive" })),
    }
    openTab({ type: "knowledge:source_link", entityId: "lnk1", label: "Source" })
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeLinkedSourceView entityId="lnk1" />
      </ApiContext.Provider>
    ))
    await waitFor(() => {
      const tab = tabStore.tabs.find((t) => t.entityId === "lnk1")
      expect(tab?.label).toBe("Q3 Plan")
    })
  })

  it("does NOT render the link for a javascript: URL", async () => {
    const api = {
      get: vi.fn(async () => ({
        id: "lnk1",
        title: "Doc",
        source: "drive",
        url: "javascript:alert(document.cookie)",
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeLinkedSourceView entityId="lnk1" />
      </ApiContext.Provider>
    ))
    expect(await screen.findByTestId("knowledge-linked-title")).toHaveTextContent("Doc")
    expect(screen.queryByTestId("knowledge-linked-open-original")).toBeNull()
  })

  it("does NOT render the link for a data: URL", async () => {
    const api = {
      get: vi.fn(async () => ({
        id: "lnk1",
        title: "Doc",
        source: "drive",
        url: "data:text/html,<script>alert(1)</script>",
      })),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <KnowledgeLinkedSourceView entityId="lnk1" />
      </ApiContext.Provider>
    ))
    expect(await screen.findByTestId("knowledge-linked-title")).toHaveTextContent("Doc")
    expect(screen.queryByTestId("knowledge-linked-open-original")).toBeNull()
  })
})
