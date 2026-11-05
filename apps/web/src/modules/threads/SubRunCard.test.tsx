// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import SubRunCard, { type SubRunMetadata } from "~/modules/threads/SubRunCard"

function makeSubRun(overrides: Partial<SubRunMetadata> = {}): SubRunMetadata {
  return {
    runId: "r-1",
    hiddenThreadId: "t-hidden-1",
    agentType: "ticket-investigator",
    label: "JIRA-1234",
    status: "running",
    summary: null,
    usage: { promptTokens: 8200, completionTokens: 0, creditCost: "0" },
    ...overrides,
  }
}

describe("SubRunCard — collapsed", () => {
  it("renders agentType, label, and status badge", () => {
    const { getByText, getByTestId } = render(() => (
      <SubRunCard subRun={makeSubRun()} expanded={false} onToggle={() => undefined} />
    ))
    expect(getByText("ticket-investigator")).toBeTruthy()
    expect(getByText("JIRA-1234")).toBeTruthy()
    expect(getByTestId("sub-run-status-badge").textContent).toMatch(/running/i)
  })

  it("renders a summary line when summary is non-null", () => {
    const { getByTestId } = render(() => (
      <SubRunCard
        subRun={makeSubRun({ summary: "Refund per ToS §4.2." })}
        expanded={false}
        onToggle={() => undefined}
      />
    ))
    expect(getByTestId("sub-run-summary").textContent).toBe("Refund per ToS §4.2.")
  })

  it("re-renders the status badge when status changes reactively", () => {
    const [status, setStatus] = createSignal<SubRunMetadata["status"]>("running")
    const { getByTestId } = render(() => (
      <SubRunCard
        subRun={makeSubRun({
          get status() {
            return status()
          },
        } as never)}
        expanded={false}
        onToggle={() => undefined}
      />
    ))
    expect(getByTestId("sub-run-status-badge").textContent).toMatch(/running/i)
    setStatus("done")
    expect(getByTestId("sub-run-status-badge").textContent).toMatch(/done/i)
    expect(getByTestId("sub-run-card").getAttribute("data-status")).toBe("done")
  })

  it("shows an Approval pending badge when hasPendingApproval is true", () => {
    const { getByTestId } = render(() => (
      <SubRunCard
        subRun={makeSubRun()}
        expanded={false}
        onToggle={() => undefined}
        hasPendingApproval={true}
      />
    ))
    expect(getByTestId("sub-run-pending-approval")).toBeTruthy()
  })

  it("toggle button calls onToggle on click", () => {
    let called = 0
    const { getByRole } = render(() => (
      <SubRunCard
        subRun={makeSubRun()}
        expanded={false}
        onToggle={() => {
          called++
        }}
      />
    ))
    const btn = getByRole("button")
    btn.click()
    expect(called).toBe(1)
  })
})
