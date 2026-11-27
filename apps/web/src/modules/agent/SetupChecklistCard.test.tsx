// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
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
  it("reads as a to-do list: a heading with the count, numbered actions to do, done steps ticked and struck", () => {
    render(() => <SetupChecklistCard state={STATE} />)
    expect(screen.getByTestId("setup-checklist-heading").textContent).toContain(
      "Next steps to set up",
    )
    expect(screen.getByTestId("setup-checklist-progress").textContent).toBe("1 of 3 done")
    expect(screen.getByTestId("setup-item-aiKey").getAttribute("data-done")).toBe("true")
    expect(screen.getByTestId("setup-item-apps").getAttribute("data-done")).toBe("false")
    // Open steps are numbered actions with a verb, in order; the done one has no number.
    expect(screen.getByTestId("setup-item-number-apps").textContent).toBe("1.")
    expect(screen.getByTestId("setup-item-number-import").textContent).toBe("2.")
    expect(screen.queryByTestId("setup-item-number-aiKey")).toBeNull()
    expect(screen.getByTestId("setup-item-apps").textContent).toContain("Turn on the apps you need")
    expect(screen.getByTestId("setup-item-import").textContent).toContain("optional")
    expect(screen.getByTestId("setup-item-apps").textContent).not.toContain("optional")
    // Done: muted and struck through behind a named tick.
    expect(screen.getByTestId("setup-item-aiKey").textContent).toContain("Add an AI model key")
    expect(screen.getByTestId("setup-item-aiKey").querySelector(".line-through")).not.toBeNull()
    expect(screen.getAllByRole("img", { name: "Done" })).toHaveLength(1)
    // Nothing that looks like a box to tick: no checkbox, no empty circle.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    expect(screen.queryAllByRole("img", { name: "Not yet" })).toHaveLength(0)
    expect(screen.getByTestId("setup-checklist").textContent).toContain("As of")
    // Without a conversation to post in, no Start buttons.
    expect(screen.queryByTestId("setup-item-start-apps")).toBeNull()
  })

  it("each open step has a Start arrow that hands its action to the conversation", () => {
    const onStart = vi.fn()
    render(() => <SetupChecklistCard state={STATE} onStart={onStart} />)
    expect(screen.queryByTestId("setup-item-start-aiKey")).toBeNull()
    fireEvent.click(screen.getByTestId("setup-item-start-apps"))
    expect(onStart).toHaveBeenCalledWith("Turn on the apps you need")
  })

  it("the team step waits for the company brief and says why, with an invite-now-anyway path", () => {
    const onStart = vi.fn()
    const state: SetupStateView = {
      items: [
        { key: "knowledge", done: false, optional: false },
        { key: "team", done: false, optional: false },
        { key: "mail", done: false, optional: false },
      ],
      next: "knowledge",
    }
    render(() => <SetupChecklistCard state={state} onStart={onStart} />)
    expect(screen.getByTestId("setup-item-number-knowledge").textContent).toBe("1.")
    expect(screen.getByTestId("setup-item-number-team").textContent).toBe("2.")
    expect(screen.getByTestId("setup-item-knowledge").textContent).toContain(
      "Tell your agent about your company",
    )
    expect(screen.getByTestId("setup-item-team-after-brief").textContent).toContain(
      "already knows the company",
    )
    const invite = screen.getByTestId("setup-item-start-team")
    expect(invite.textContent).toContain("Invite now anyway")
    expect(screen.getByTestId("setup-item-start-knowledge").textContent).toContain("Start")
    // Never blocked: the press posts the invite step like any other.
    fireEvent.click(invite)
    expect(onStart).toHaveBeenCalledWith("Invite your team")
  })

  it("once the brief is done, the team step is a plain step again", () => {
    render(() => (
      <SetupChecklistCard
        state={{
          items: [
            { key: "knowledge", done: true, optional: false },
            { key: "team", done: false, optional: false },
          ],
        }}
        onStart={vi.fn()}
      />
    ))
    expect(screen.queryByTestId("setup-item-team-after-brief")).toBeNull()
    expect(screen.getByTestId("setup-item-start-team").textContent).not.toContain("anyway")
  })

  it("speaks French", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupChecklistCard state={STATE} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-item-aiKey").textContent).toContain(
      "Ajouter une clé de modèle d'IA",
    )
    expect(screen.getByTestId("setup-item-import").textContent).toContain("facultatif")
    expect(screen.getByTestId("setup-checklist-progress").textContent).toBe("1 sur 3 faites")
  })

  it("says why the team waits for the brief, in French too", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupChecklistCard
          state={{
            items: [
              { key: "knowledge", done: false, optional: false },
              { key: "team", done: false, optional: false },
            ],
          }}
          onStart={vi.fn()}
        />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-item-knowledge").textContent).toContain(
      "Présentez votre entreprise à votre agent",
    )
    expect(screen.getByTestId("setup-item-team-after-brief").textContent).toContain(
      "connaît déjà l'entreprise",
    )
    expect(screen.getByTestId("setup-item-start-team").textContent).toContain(
      "Inviter maintenant quand même",
    )
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
