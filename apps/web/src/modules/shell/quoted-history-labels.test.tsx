// SPDX-License-Identifier: FSL-1.1-ALv2
// The presentation-layer QuotedHistory with the shell's real copy (src/ui
// cannot import the i18n module, so the pair is tested here).
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { translatorFor } from "~/modules/i18n/i18n-context"
import { quotedHistoryLabels } from "~/modules/shell/quoted-history-labels"
import { QuotedHistory, type QuotedHistoryProps } from "~/ui/QuotedHistory"

const CHAIN =
  "On Mon, Jan 5, 2026 at 9:00 AM Ana Silva <ana@example.com> wrote:\n> Can you confirm the delivery date for the twelve chairs?"

function renderFold(overrides: Partial<QuotedHistoryProps> = {}) {
  const props: QuotedHistoryProps = {
    quoted: CHAIN,
    mode: "text",
    cacheKey: `k-${Math.random()}`,
    threadMessages: [],
    onJump: () => {},
    renderOriginal: (quoted) => <pre data-testid="raw-tail">{quoted}</pre>,
    labels: quotedHistoryLabels(translatorFor("en")),
    testIdPrefix: "q",
    testIdKey: "m1",
    ...overrides,
  }
  return render(() => <QuotedHistory {...props} />)
}

describe("QuotedHistory", () => {
  it("names a single earlier email in the singular and shows its text when unlinked", () => {
    renderFold()
    expect(screen.getByTestId("q-toggle-m1").textContent).toBe("···1 earlier email")
    fireEvent.click(screen.getByTestId("q-toggle-m1"))
    const row = screen.getByTestId("q-row-m1-0")
    expect(row.textContent).toContain("Ana Silva")
    expect(row.textContent).toContain("twelve chairs")
    expect(screen.queryByTestId("q-jump-m1-0")).toBeNull()
  })

  it("keeps the dots chip and expands to the raw tail when no earlier email is recognised", () => {
    renderFold({ quoted: "> just a quoted line without any attribution at all" })
    const toggle = screen.getByTestId("q-toggle-m1")
    expect(toggle.textContent).toBe("•••")
    expect(toggle.getAttribute("aria-label")).toBe("Show quoted text")
    fireEvent.click(toggle)
    expect(screen.getByTestId("q-body-m1").textContent).toContain("just a quoted line")
    expect(screen.queryByTestId("q-original-m1")).toBeNull()
  })

  it("stays collapsed when the expand step fails", async () => {
    const onExpand = vi.fn(async () => false)
    renderFold({ onExpand })
    fireEvent.click(screen.getByTestId("q-toggle-m1"))
    await waitFor(() => expect(onExpand).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(screen.queryByTestId("q-body-m1")).toBeNull()
    expect(screen.getByTestId("q-toggle-m1")).toBeTruthy()
  })

  it("reads in French", () => {
    renderFold({
      labels: quotedHistoryLabels(translatorFor("fr")),
      threadMessages: [
        { id: "m0", text: "Can you confirm the delivery date for the twelve chairs?" },
      ],
    })
    expect(screen.getByTestId("q-toggle-m1").textContent).toBe(
      "···1 email précédent · 1 déjà dans cette discussion",
    )
    fireEvent.click(screen.getByTestId("q-toggle-m1"))
    expect(screen.getByTestId("q-jump-m1-0").textContent).toBe("Dans la discussion ↑")
    expect(screen.getByTestId("q-original-m1").textContent).toBe("Afficher l'original")
  })
})
