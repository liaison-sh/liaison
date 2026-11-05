// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The white-page regression: a conversation opened from a surface that is NOT
// Home (the Tickets page's Chats roster, an agent page's Message button, the
// phone ticket list) blanked the document to zero nodes. The dock and the
// Chats sheet are rendered by the Shell, outside MainPanel's per-tab
// boundaries, so the nearest Suspense above them was App's root one, which
// carries no fallback: in Solid that renders NOTHING while suspended, and a
// pending credits read in the composer's model chip (pending for seconds when
// the API answers 429) suspended it on every such open.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource, Suspense } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import { DockSurfaceBoundary } from "~/modules/shell/DockSurfaceBoundary"

/** A child whose render READS a resource that never settles, exactly the way
 *  ThreadView's composer reads the credits balance during render. */
function SuspendingChild() {
  const [value] = createResource(() => new Promise<string>(() => {}))
  return <span data-testid="suspending-child">{value()}</span>
}

function ThrowingChild(): never {
  throw new ApiError("Too many requests", 429, undefined, 30)
}

/** The app root as App.tsx builds it around the shell: a Suspense boundary
 *  with no fallback of its own, with shell chrome beside the dock surface. */
function renderUnderFalliblesRoot(child: () => any) {
  return render(() => (
    <Suspense>
      <div data-testid="shell-chrome">shell</div>
      {child()}
    </Suspense>
  ))
}

describe("DockSurfaceBoundary - the dock never takes the shell down with it", () => {
  afterEach(() => cleanup())

  it("a pending read inside the surface leaves the shell around it rendered", () => {
    renderUnderFalliblesRoot(() => (
      <DockSurfaceBoundary>
        <SuspendingChild />
      </DockSurfaceBoundary>
    ))
    // Without the local boundary the root Suspense swallows BOTH children and
    // the document is empty: this is the white page.
    expect(screen.getByTestId("shell-chrome")).toBeInTheDocument()
    expect(screen.getByTestId("dock-surface-loading")).toBeInTheDocument()
    expect(document.body.textContent).not.toBe("")
  })

  it("a 429 thrown while the surface renders shows a retry, not a blank page", async () => {
    renderUnderFalliblesRoot(() => (
      <DockSurfaceBoundary>
        <ThrowingChild />
      </DockSurfaceBoundary>
    ))
    await waitFor(() => expect(screen.getByTestId("dock-surface-error")).toBeInTheDocument())
    expect(screen.getByTestId("shell-chrome")).toBeInTheDocument()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })
})

describe("ApiError.retryable", () => {
  it("treats 429, 5xx and a network failure as retryable and a 4xx as final", () => {
    expect(new ApiError("Too many requests", 429).retryable).toBe(true)
    expect(new ApiError("Server error", 503).retryable).toBe(true)
    expect(new ApiError("Network error", 0).retryable).toBe(true)
    expect(new ApiError("Not found", 404).retryable).toBe(false)
    expect(new ApiError("Forbidden", 403).retryable).toBe(false)
  })
})
