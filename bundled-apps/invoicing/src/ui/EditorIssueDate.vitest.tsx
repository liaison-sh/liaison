// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issue date of a new document, rendered: what a person picks in the field is what the create
// tool receives, and a field left on its default sends no date, so the server dates the document.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  app: {
    createResource,
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      if (tool === "settings_issuer_profile_list") {
        return {
          items: [
            {
              id: "iss-1",
              legal_name: "Issuer",
              country: "FR",
              is_default: true,
              today: "2026-11-06",
            },
          ],
        }
      }
      if (tool.endsWith("_create_and_issue"))
        return { status: "completed", document_id: "d-1", number: "QUO-2026-0001" }
      return { status: "ok" }
    },
  },
}))

const { Editor, defaultDraft } = await import("./Editor")

function quote() {
  const base = defaultDraft("quote")
  const service = "Service"
  return {
    ...base,
    issuer_profile_id: "iss-1",
    due_at: "2026-12-31",
    counterparty_name: "Buyer",
    counterparty_email: "buyer@example.com",
    counterparty_country: "FR",
    counterparty_address: "1 rue de Test, 75011 Paris",
    lines: base.lines.map((line) => ({ ...line, description: service, unit_price_minor: "10000" })),
  }
}

const created = () => calls.find((c) => c.tool === "quote_create_and_issue")

describe("the editor's issue date on a new quote", () => {
  beforeEach(() => {
    calls.length = 0
  })
  afterEach(cleanup)

  it("a date the person picked reaches the create tool", async () => {
    render(() => <Editor initial={quote() as never} />)
    await waitFor(() =>
      expect(calls.some((c) => c.tool === "settings_issuer_profile_list")).toBe(true),
    )
    fireEvent.input(screen.getByTestId("editor-field-issued-at"), {
      target: { value: "2026-10-30" },
    })
    fireEvent.click(await screen.findByTestId("editor-button-issue"))
    await waitFor(() => expect(created()).toBeDefined())
    expect(created()?.params.issued_at).toBe("2026-10-30")
  })

  it("a field left on its default sends no date", async () => {
    render(() => <Editor initial={quote() as never} />)
    await waitFor(() =>
      expect(calls.some((c) => c.tool === "settings_issuer_profile_list")).toBe(true),
    )
    fireEvent.click(await screen.findByTestId("editor-button-issue"))
    await waitFor(() => expect(created()).toBeDefined())
    expect(created()?.params).not.toHaveProperty("issued_at")
  })
})
