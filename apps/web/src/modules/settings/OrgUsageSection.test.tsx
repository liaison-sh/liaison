// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings → Organization → Usage and limits (S4.7 and its charter): four
// read-only rows, each unlimited / under / at-or-over its limit, no edit
// control, and no alarm colour (one neutral emphasis at the limit).
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import OrgUsageSection from "~/modules/settings/OrgUsageSection"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const USAGE = {
  seats: { used: 3, limit: null },
  mailboxes: { used: 4, limit: 10 },
  storageGb: { used: 12.5, limit: 10 },
  jobsThisHour: { used: 7, limit: 7 },
}

function renderWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith("/org/usage") ? jsonResp(body, status) : jsonResp({}),
  )
  vi.stubGlobal("fetch", fetchMock)
  window.history.pushState({}, "", "/settings/admin/org")
  const { container } = render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <OrgUsageSection />
          </ApiProvider>
        )}
      />
    </Router>
  ))
  return { fetchMock, container }
}

afterEach(() => vi.unstubAllGlobals())

describe("OrgUsageSection", () => {
  it("shows the four caps: unlimited, under, and at or over the limit", async () => {
    renderWith({ data: USAGE })
    const seats = await screen.findByTestId("org-usage-seats")
    expect(seats.dataset.state).toBe("unlimited")
    expect(screen.getByTestId("org-usage-seats-value").textContent).toContain("unlimited")
    expect(screen.queryByTestId("org-usage-seats-reached")).toBeNull()

    expect(screen.getByTestId("org-usage-mailboxes").dataset.state).toBe("under")
    expect(screen.getByTestId("org-usage-mailboxes-value").textContent).toBe("4 of 10")
    expect(screen.queryByTestId("org-usage-mailboxes-reached")).toBeNull()

    // Over the limit (a cap set below usage) and exactly at it read the same.
    expect(screen.getByTestId("org-usage-storage").dataset.state).toBe("at-limit")
    expect(screen.getByTestId("org-usage-storage-value").textContent).toBe("12.5 GB of 10 GB")
    expect(screen.getByTestId("org-usage-storage-reached")).toBeInTheDocument()
    expect(screen.getByTestId("org-usage-jobs").dataset.state).toBe("at-limit")
    expect(screen.getByTestId("org-usage-jobs-reached")).toBeInTheDocument()
  })

  const ESTIMATE = {
    usedGb: 12.4,
    limitGb: 10,
    measuredAt: "2026-11-07T02:40:00.000Z",
    partial: false,
    overCap: true,
  }

  it("the nightly storage estimate is a row of its own, labelled as an estimate", async () => {
    renderWith({ data: { ...USAGE, storageEstimate: ESTIMATE } })
    const row = await screen.findByTestId("org-usage-storage-estimate")
    expect(row.textContent).toContain("(estimate)")
    expect(row.textContent).toContain("never blocks")
    expect(row.dataset.state).toBe("over")
    expect(screen.getByTestId("org-usage-storage-estimate-value").textContent).toBe(
      "About 12.4 GB of 10 GB",
    )
    expect(screen.getByTestId("org-usage-storage-estimate-over")).toBeInTheDocument()
    expect(screen.getByTestId("org-usage-storage-estimate-measured").textContent).toContain(
      "Measured",
    )
  })

  it("under the plan, without a cap, with a part unmeasured: says so; none before a measure", async () => {
    renderWith({
      data: {
        ...USAGE,
        storageEstimate: { ...ESTIMATE, limitGb: null, overCap: false, partial: true },
      },
    })
    const row = await screen.findByTestId("org-usage-storage-estimate")
    expect(row.dataset.state).toBe("under")
    expect(screen.getByTestId("org-usage-storage-estimate-value").textContent).toBe("About 12.4 GB")
    expect(screen.queryByTestId("org-usage-storage-estimate-over")).toBeNull()
    expect(screen.getByTestId("org-usage-storage-estimate-measured").textContent).toContain(
      "could not be read",
    )
    cleanup()
    renderWith({ data: { ...USAGE, storageEstimate: null } })
    await screen.findByTestId("org-usage-list")
    expect(screen.queryByTestId("org-usage-storage-estimate")).toBeNull()
  })

  it("on a managed workspace the line points at the plan, not at whoever runs the server", async () => {
    BillingStateTestAccess.setMode("managed")
    try {
      renderWith({ data: USAGE })
      await screen.findByTestId("org-usage-list")
      const help = screen.getByTestId("org-usage-help").textContent ?? ""
      expect(help).toContain("Your plan sets these limits")
      // A plan does not limit mailboxes, so the row is not there at all.
      expect(screen.queryByTestId("org-usage-mailboxes")).toBeNull()
      expect(screen.getByTestId("org-usage-storage")).toBeInTheDocument()
      expect(help).not.toContain("whoever runs the server")
    } finally {
      BillingStateTestAccess.reset()
    }
  })

  it("is read only and calm: no control, no alarm colour, one line on who sets limits", async () => {
    const { container } = renderWith({ data: USAGE })
    await screen.findByTestId("org-usage-list")
    expect(screen.getByTestId("org-usage-help").textContent).toContain("whoever runs the server")
    expect(container.querySelectorAll("input, button, select, textarea")).toHaveLength(0)
    expect(container.innerHTML).not.toMatch(
      /\b(text|bg|border)-(red|orange|danger|error|warning|amber)/,
    )
    // The emphasis at the limit is weight, not colour.
    expect(screen.getByTestId("org-usage-jobs-value").className).toContain("font-medium")
    expect(screen.getByTestId("org-usage-mailboxes-value").className).not.toContain("font-medium")
  })

  it("says so when the usage cannot be loaded", async () => {
    renderWith({ error: { message: "nope", code: "FORBIDDEN" } }, 403)
    expect(await screen.findByTestId("org-usage-load-failed")).toBeInTheDocument()
  })
})
