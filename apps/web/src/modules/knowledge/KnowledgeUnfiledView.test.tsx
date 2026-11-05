// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import KnowledgeUnfiledView from "./KnowledgeUnfiledView"

function renderWith(getImpl: any) {
  const api: any = { get: vi.fn(getImpl), post: vi.fn() }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <KnowledgeUnfiledView />
    </ApiContext.Provider>
  ))
  return api
}

describe("KnowledgeUnfiledView", () => {
  it("renders the list when the API returns rows", async () => {
    renderWith(async () => [{ id: "d1", title: "Loose note" }])
    await waitFor(() => expect(screen.getByTestId("knowledge-unfiled-d1")).toBeInTheDocument())
  })

  it("renders the empty state when there are no orphan docs", async () => {
    renderWith(async () => [])
    await waitFor(() => expect(screen.getByTestId("knowledge-unfiled-empty")).toBeInTheDocument())
  })

  it("surfaces an error explicitly instead of looking like an empty success", async () => {
    renderWith(async () => {
      throw new Error("forbidden")
    })
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-unfiled-error")).toHaveTextContent("forbidden"),
    )
    // The empty state must NOT also render — that's the regression we're guarding against.
    expect(screen.queryByTestId("knowledge-unfiled-empty")).not.toBeInTheDocument()
  })
})
