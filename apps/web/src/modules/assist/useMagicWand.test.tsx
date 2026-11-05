// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"

const applyMock = vi.fn()
const fakeTarget = { region: { type: "all" } }
vi.mock("./magic-wand-apply", () => ({
  applyCorrection: (...a: unknown[]) => applyMock(...a),
  readTarget: () => ({ text: "teh cat", format: "text", target: fakeTarget }),
}))
const toastMock = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({ addToast: (...a: unknown[]) => toastMock(...a) }))

import { useMagicWand } from "./useMagicWand"

function harness(api: Partial<ApiClient>, locale: "en" | "fr" = "en") {
  let runFn!: () => Promise<void>
  function Probe() {
    const el = document.createElement("textarea")
    const w = useMagicWand({ getEl: () => el, kind: "text" })
    runFn = w.run
    return null
  }
  render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as ApiClient}>
        <Probe />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return () => runFn()
}

describe("useMagicWand", () => {
  it("POSTs the read target and applies the corrected text", async () => {
    applyMock.mockClear()
    const post = vi.fn().mockResolvedValue({ text: "the cat" })
    const run = harness({ post })
    await run()
    expect(post).toHaveBeenCalledWith("/assist/proofread", { text: "teh cat", format: "text" })
    expect(applyMock).toHaveBeenCalledWith(fakeTarget, "the cat")
  })

  it("toasts on error and does not apply", async () => {
    applyMock.mockClear()
    toastMock.mockClear()
    const post = vi.fn().mockRejectedValue(new Error("boom"))
    const run = harness({ post })
    await run()
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(applyMock).not.toHaveBeenCalled()
  })

  it("says the failure in the UI language", async () => {
    toastMock.mockClear()
    const post = vi.fn().mockRejectedValue(new Error("boom"))
    const run = harness({ post }, "fr")
    await run()
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        message: "Impossible d'améliorer le texte. Veuillez réessayer.",
        type: "error",
      }),
    )
  })
})
