// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T12 (L30, S25): an attached agent's daily caps are editable. Saving
// PATCHes the attachment and says Saved; a value outside the server's bounds
// cannot be saved.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { NodeAttachmentSummary } from "~/modules/nodes/node-api"
import { ApiContext } from "~/modules/shell/ApiContext"
import { NodeCapsEditor } from "./NodeCapsEditor"

const ATTACHMENT: NodeAttachmentSummary = {
  id: "att-1",
  agentId: "a-1",
  agentName: "Personal agent",
  allowedRequesters: [],
  maxJobsPerDay: 10,
  maxTokensPerDay: 2_000_000,
}

function show(patch = vi.fn(async (_p: string, b: object) => ({ ...ATTACHMENT, ...b }))) {
  const onSaved = vi.fn()
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch, delete: vi.fn() } as never
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <NodeCapsEditor attachment={ATTACHMENT} onSaved={onSaved} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { patch, onSaved }
}

describe("NodeCapsEditor", () => {
  it("editing a cap PATCHes it and shows Saved", async () => {
    const { patch, onSaved } = show()
    const save = screen.getByTestId("node-caps-save-att-1") as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("node-caps-jobs-att-1"), { target: { value: "25" } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0]).toEqual([
      "/nodes/attachments/att-1",
      { maxJobsPerDay: 25, maxTokensPerDay: 2_000_000 },
    ])
    expect(await screen.findByTestId("node-caps-saved-att-1")).toBeTruthy()
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ maxJobsPerDay: 25 }))
  })

  it("a cap outside the bounds cannot be saved", () => {
    const { patch } = show()
    fireEvent.input(screen.getByTestId("node-caps-tokens-att-1"), { target: { value: "10" } })
    const save = screen.getByTestId("node-caps-save-att-1") as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("node-caps-tokens-att-1"), { target: { value: "5000" } })
    fireEvent.input(screen.getByTestId("node-caps-jobs-att-1"), { target: { value: "0" } })
    expect(save.disabled).toBe(true)
    expect(patch).not.toHaveBeenCalled()
  })

  it("the labels say what the caps are for", () => {
    show()
    const caps = screen.getByTestId("node-caps-att-1").textContent ?? ""
    expect(caps).toContain("Sessions a day others may start")
    expect(caps).toContain("Tokens a day for others' sessions")
  })
})
