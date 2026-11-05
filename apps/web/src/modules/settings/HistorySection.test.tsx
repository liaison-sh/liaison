// SPDX-License-Identifier: FSL-1.1-ALv2
// The AI models page's "Conversation history" setting: what it shows and the
// request each change sends.

import type { HistorySettings } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { HistorySection } from "./HistorySection"

const DEFAULTS: HistorySettings = {
  budgetTokens: null,
  defaultBudgetTokens: 256_000,
  minBudgetTokens: 32_000,
  maxBudgetTokens: 2_000_000,
  warmCompaction: true,
}

function setup(initial: HistorySettings, locale: "en" | "fr" = "en") {
  let state = initial
  const get = vi.fn().mockImplementation(async () => state)
  const patch = vi
    .fn()
    .mockImplementation(async (_path: string, body: Partial<HistorySettings>) => {
      state = { ...state, ...body }
      return state
    })
  const api: Partial<ApiClient> = { get, patch }
  render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as ApiClient}>
        <HistorySection />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { patch }
}

const budget = () => screen.getByTestId("ai-models-history-budget") as HTMLInputElement

afterEach(() => cleanup())

describe("Conversation history setting", () => {
  it("shows the default in thousands of tokens, with the label and the trade-off", async () => {
    setup(DEFAULTS)
    await waitFor(() => expect(budget().value).toBe("256"))
    const section = screen.getByTestId("ai-models-history")
    expect(section.textContent).toContain("Summarise conversation history after")
    expect(section.textContent).toContain("less often")
    expect(screen.queryByTestId("ai-models-history-reset")).toBeNull()
  })

  it("saves a new budget in tokens and offers to go back to the default", async () => {
    const { patch } = setup(DEFAULTS)
    await waitFor(() => expect(budget().value).toBe("256"))
    fireEvent.input(budget(), { target: { value: "128" } })
    fireEvent.click(screen.getByTestId("ai-models-history-save"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/history", { budgetTokens: 128_000 }),
    )
    await waitFor(() => expect(screen.getByTestId("ai-models-history-reset")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ai-models-history-reset"))
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/settings/ai/history", { budgetTokens: null }),
    )
  })

  it("refuses a value under the minimum", async () => {
    const { patch } = setup(DEFAULTS)
    await waitFor(() => expect(budget().value).toBe("256"))
    fireEvent.input(budget(), { target: { value: "10" } })
    expect(screen.getByTestId("ai-models-history-invalid")).toBeTruthy()
    expect((screen.getByTestId("ai-models-history-save") as HTMLButtonElement).disabled).toBe(true)
    expect(patch).not.toHaveBeenCalled()
  })

  it("turns warm-cache summaries off", async () => {
    const { patch } = setup(DEFAULTS)
    await waitFor(() => expect(budget().value).toBe("256"))
    fireEvent.click(screen.getByTestId("ai-models-history-warm"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/history", { warmCompaction: false }),
    )
  })

  it("is translated in French", async () => {
    setup(DEFAULTS, "fr")
    await waitFor(() => expect(budget().value).toBe("256"))
    expect(screen.getByTestId("ai-models-history").textContent).toContain(
      "Résumer l'historique des discussions après",
    )
  })
})
