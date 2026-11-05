// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"
import { MagicWandButton } from "./MagicWandButton"

vi.mock("./magic-wand-apply", () => ({
  applyCorrection: vi.fn(),
  readTarget: () => ({ text: "teh", format: "text" }),
}))

function renderBtn(post: ReturnType<typeof vi.fn>) {
  const el = document.createElement("textarea")
  return render(() => (
    <ApiContext.Provider value={{ post } as unknown as ApiClient}>
      <MagicWandButton getEl={() => el} kind="text" />
    </ApiContext.Provider>
  ))
}

describe("MagicWandButton", () => {
  it("renders an accessible button", () => {
    renderBtn(vi.fn().mockResolvedValue({ text: "the" }))
    expect(screen.getByTestId("magic-wand")).toBeInTheDocument()
  })

  it("calls the proofread endpoint on click", async () => {
    const post = vi.fn().mockResolvedValue({ text: "the" })
    renderBtn(post)
    fireEvent.click(screen.getByTestId("magic-wand"))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/assist/proofread", expect.anything()))
  })

  it("is disabled while running", async () => {
    let resolve!: (v: { text: string }) => void
    const post = vi.fn(() => new Promise((r) => (resolve = r)))
    renderBtn(post)
    const btn = screen.getByTestId("magic-wand")
    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    resolve({ text: "the" })
    await waitFor(() => expect(btn).not.toBeDisabled())
  })
})
