// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { Suspense } from "solid-js"
import { describe, expect, it, vi } from "vitest"
import SkillApprovalView from "./SkillApprovalView"

type SkillRow = {
  id: string
  name: string
  description: string
  body: string
  source: string
  requiredScopes: string[]
}

function mockApi(skills: SkillRow[]) {
  return {
    get: vi.fn(async () => skills),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  } as never
}

describe("SkillApprovalView", () => {
  it("create: shows name, visibility, description and the full body", () => {
    render(() => (
      <SkillApprovalView
        api={mockApi([])}
        kind="create"
        payload={{
          name: "greeting-skill",
          description: "Says hello",
          visibility: "org",
          body: "# Say Hello\nline two",
        }}
      />
    ))
    expect(screen.getByTestId("skill-approval-name")).toHaveTextContent("greeting-skill")
    expect(screen.getByText("Org-shared")).toBeInTheDocument()
    expect(screen.getByText("Says hello")).toBeInTheDocument()
    const body = screen.getByTestId("skill-approval-body")
    expect(body).toHaveTextContent("# Say Hello")
    expect(body).toHaveTextContent("line two")
  })

  it("update: diffs the new body against the fetched current skill", async () => {
    const api = mockApi([
      {
        id: "s1",
        name: "voice",
        description: "d",
        body: "a\nOLD\nc",
        source: "org",
        requiredScopes: [],
      },
    ])
    render(() => (
      <SkillApprovalView api={api} kind="update" payload={{ id: "s1", body: "a\nNEW\nc" }} />
    ))
    await waitFor(() => expect(screen.getByTestId("skill-approval-diff")).toBeInTheDocument())
    const diff = screen.getByTestId("skill-approval-diff")
    expect(diff).toHaveTextContent("OLD")
    expect(diff).toHaveTextContent("NEW")
    expect(screen.getByTestId("skill-approval-added")).toHaveTextContent("+1")
    expect(screen.getByTestId("skill-approval-removed")).toHaveTextContent("-1")
  })

  it("update: renders a name change as before -> after", async () => {
    const api = mockApi([
      {
        id: "s1",
        name: "old-name",
        description: "d",
        body: "same",
        source: "org",
        requiredScopes: [],
      },
    ])
    render(() => (
      <SkillApprovalView
        api={api}
        kind="update"
        payload={{ id: "s1", name: "new-name", body: "same" }}
      />
    ))
    // Wait for the current skill to load so the "before" (old-name) resolves;
    // before that, only the proposed name shows.
    await waitFor(() =>
      expect(screen.getByTestId("skill-approval-change-name")).toHaveTextContent("old-name"),
    )
    expect(screen.getByTestId("skill-approval-change-name")).toHaveTextContent("new-name")
  })

  it("update: proposal identical to the deployed skill shows the no-op notice, not a +0 -0 diff", async () => {
    const api = mockApi([
      {
        id: "s1",
        name: "voice",
        description: "d",
        body: "a\nb\nc",
        source: "org",
        requiredScopes: [],
      },
    ])
    render(() => (
      <SkillApprovalView
        api={api}
        kind="update"
        payload={{ id: "s1", name: "voice", description: "d", body: "a\nb\nc", requiredScopes: [] }}
      />
    ))
    await waitFor(() => expect(screen.getByTestId("skill-approval-noop")).toBeInTheDocument())
    expect(screen.getByTestId("skill-approval-noop")).toHaveTextContent(
      "identical to the deployed skill",
    )
    expect(screen.queryByTestId("skill-approval-diff")).not.toBeInTheDocument()
  })

  it("update: never suspends an ancestor Suspense boundary while the current skill loads", async () => {
    // The approval card renders inside the app shell; if this component reads
    // the pending resource unguarded, the app-root Suspense fallback flashes
    // the whole window. The outer fallback here must never appear.
    let resolveFetch: (rows: SkillRow[]) => void = () => {}
    const api = {
      get: vi.fn(() => new Promise<SkillRow[]>((r) => (resolveFetch = r))),
    } as never
    render(() => (
      <Suspense fallback={<div data-testid="outer-suspense-fallback" />}>
        <SkillApprovalView api={api} kind="update" payload={{ id: "s1", body: "a\nNEW\nc" }} />
      </Suspense>
    ))
    // While pending: component's own loading hint shows, outer fallback does not.
    expect(screen.queryByTestId("outer-suspense-fallback")).not.toBeInTheDocument()
    expect(screen.getByTestId("skill-approval-update")).toBeInTheDocument()
    resolveFetch([
      {
        id: "s1",
        name: "voice",
        description: "d",
        body: "a\nOLD\nc",
        source: "org",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-approval-diff")).toBeInTheDocument())
    expect(screen.queryByTestId("outer-suspense-fallback")).not.toBeInTheDocument()
    expect(screen.getByTestId("skill-approval-diff")).toHaveTextContent("NEW")
  })

  it("update: current version unavailable -> new body renders as all-added", async () => {
    const api = mockApi([]) // no matching skill row
    render(() => (
      <SkillApprovalView api={api} kind="update" payload={{ id: "missing", body: "x\ny" }} />
    ))
    await waitFor(() => expect(screen.getByTestId("skill-approval-diff")).toBeInTheDocument())
    expect(screen.getByTestId("skill-approval-added")).toHaveTextContent("+2")
    expect(screen.getByTestId("skill-approval-removed")).toHaveTextContent("-0")
  })
})
