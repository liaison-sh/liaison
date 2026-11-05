// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SetupChecklistCard, type SetupStateView, setupStateResult } from "./SetupChecklistCard"

const STATE: SetupStateView = {
  items: [
    { key: "aiKey", done: true, optional: false, detail: "a model key is usable" },
    { key: "apps", done: false, optional: false, detail: "0 apps enabled" },
    { key: "import", done: false, optional: true, detail: "0 imports finished" },
  ],
  next: "apps",
  asOf: "2026-10-26T10:00:00.000Z",
}

describe("SetupChecklistCard", () => {
  it("draws each item done or not from the data alone, optional ones marked", () => {
    render(() => <SetupChecklistCard state={STATE} />)
    expect(screen.getByTestId("setup-item-aiKey").getAttribute("data-done")).toBe("true")
    expect(screen.getByTestId("setup-item-apps").getAttribute("data-done")).toBe("false")
    expect(screen.getByTestId("setup-item-import").textContent).toContain("optional")
    expect(screen.getByTestId("setup-item-apps").textContent).not.toContain("optional")
    expect(screen.getByTestId("setup-item-aiKey").textContent).toContain("AI model key")
    expect(screen.getByTestId("setup-checklist").textContent).toContain("As of")
    // The tick and the circle are named images, not bare decoration.
    expect(screen.getAllByRole("img", { name: "Done" })).toHaveLength(1)
    expect(screen.getAllByRole("img", { name: "Not yet" })).toHaveLength(2)
  })

  it("speaks French", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupChecklistCard state={STATE} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-item-aiKey").textContent).toContain("Clé de modèle d'IA")
    expect(screen.getByTestId("setup-item-import").textContent).toContain("facultatif")
  })
})

describe("setupStateResult", () => {
  const call = (over: Record<string, unknown>) => ({
    toolCallId: "tc",
    toolName: "kernel__setup_state",
    status: "completed" as const,
    result: { ...STATE, canConfigure: true },
    ...over,
  })

  it("reads the state off a finished setup_state call", () => {
    expect(setupStateResult(call({}))?.next).toBe("apps")
  })

  it("ignores another tool, a failed call and a result without items", () => {
    expect(setupStateResult(call({ toolName: "kernel__config_export" }))).toBeNull()
    expect(setupStateResult(call({ status: "error" }))).toBeNull()
    expect(setupStateResult(call({ result: { error: "nope" } }))).toBeNull()
  })
})

describe("ToolCallRow draws the checklist under a setup_state call", () => {
  it("only for a finished setup_state call", async () => {
    const { default: ToolCallRow } = await import("./ToolCallRow")
    const { unmount } = render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc-1",
          toolName: "kernel__setup_state",
          status: "completed",
          result: { ...STATE, canConfigure: true },
        }}
      />
    ))
    expect(screen.getByTestId("setup-checklist")).toBeTruthy()
    unmount()
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc-2",
          toolName: "kernel__setup_state",
          status: "error",
          result: { error: "failed" },
        }}
      />
    ))
    expect(screen.queryByTestId("setup-checklist")).toBeNull()
  })
})
