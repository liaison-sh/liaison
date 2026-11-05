// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHEN A TURN RUNS ON THIS MACHINE, the user picks the Claude model it runs
// on. The picker used to offer one entry, "Your Claude Code login", that only
// moved the runtime: the chip kept saying the Liaison model, nothing was
// remembered, and the session always started on the same hard coded model.

import { within as domWithin, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import {
  chooseLocalModel,
  LOCAL_MODEL_STORAGE_PREFIX,
  localModelFor,
  resetDesktopStore,
  resetLocalTurnMessages,
  runMessageAsLocalTurn,
  startLocalSession,
} from "~/modules/desktop/desktop-store"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import ModelSelector from "./ModelSelector"

const UNLOCKED = { included: "100", purchased: "50", currency: "EUR" }
const LOCAL_IDS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"]
const THREAD = "thread-1"

async function openMenu(): Promise<HTMLElement> {
  const trigger = screen.getByLabelText("Select model")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return await screen.findByRole("menu")
}

function renderChip(
  onSelect: (id: string | null) => void = () => {},
  selected: string | null = null,
) {
  return render(() => (
    <ModelSelector
      balance={UNLOCKED}
      selectedModelId={selected}
      defaultEntryLabel="Default (Gemini Pro)"
      onSelect={onSelect}
      threadId={THREAD}
    />
  ))
}

/** Kobalte selects on Enter, not on a synthetic click. */
function pick(name: string): void {
  fireEvent.keyDown(screen.getByRole("menuitem", { name }), { key: "Enter" })
}

const label = () => screen.getByTestId("model-selector-label").textContent

describe("the local models in the picker", () => {
  beforeEach(() => {
    localStorage.clear()
    setServedModels(parseServedModels(SERVED_MODELS_FIXTURE))
  })
  afterEach(() => {
    setServedModels(null)
    uninstallFakeBridge()
    BillingStateTestAccess.reset()
    localStorage.clear()
  })

  it("lists the Claude models under Local models when the shell can run them", async () => {
    installFakeBridge({ runtimeLocation: "local" }, { localModels: LOCAL_IDS })
    renderChip()
    const menu = await openMenu()
    const local = menu.querySelector('[data-testid="model-section-local"]') as HTMLElement
    const entries = domWithin(local)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(entries).toEqual(["Claude Haiku 4.5", "Claude Sonnet 5", "Claude Opus 5.5"])
  })

  it("names the local model on the chip while turns run here, not the Liaison default", () => {
    installFakeBridge({ runtimeLocation: "local" }, { localModels: LOCAL_IDS })
    renderChip()
    expect(label()).toBe("Claude Haiku 4.5")
  })

  it("picking a local model updates the chip, moves the turn here and never touches the Liaison model", async () => {
    const fake = installFakeBridge({ runtimeLocation: "liaison" }, { localModels: LOCAL_IDS })
    const liaisonPicks: Array<string | null> = []
    renderChip((id) => liaisonPicks.push(id))
    expect(label()).toBe("Default (Gemini Pro)")

    await openMenu()
    pick("Claude Sonnet 5")

    await waitFor(() => expect(label()).toBe("Claude Sonnet 5"))
    expect(fake.calls.locations).toEqual(["local"])
    expect(liaisonPicks).toEqual([])
    expect(localStorage.getItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD)).toBe("claude-sonnet-5")
  })

  it("the choice is this conversation's and survives a reload", async () => {
    installFakeBridge({ runtimeLocation: "local" }, { localModels: LOCAL_IDS })
    const first = renderChip()
    await openMenu()
    pick("Claude Opus 5.5")
    await waitFor(() => expect(label()).toBe("Claude Opus 5.5"))
    first.unmount()

    // A RELOAD: the page's memory is gone, the shell comes back local.
    uninstallFakeBridge()
    resetDesktopStore()
    installFakeBridge({ runtimeLocation: "local" }, { localModels: LOCAL_IDS })
    renderChip()
    expect(label()).toBe("Claude Opus 5.5")
    // Another conversation still starts on the default.
    expect(localModelFor("thread-2")).toBe("claude-haiku-4-5")
  })

  it("on Liaison the Liaison models show and apply as before", async () => {
    installFakeBridge({ runtimeLocation: "liaison" }, { localModels: LOCAL_IDS })
    chooseLocalModel(THREAD, "claude-opus-5-5")
    const liaisonPicks: Array<string | null> = []
    renderChip((id) => liaisonPicks.push(id), "gemini-pro-latest")
    expect(label()).toBe("Gemini Pro")

    await openMenu()
    pick("GPT-5.4")
    expect(liaisonPicks).toEqual(["gpt-5.4"])
    // The local choice is a different slot and nothing about it moved.
    expect(localModelFor(THREAD)).toBe("claude-opus-5-5")
  })

  // 2026-10-01: THE LIST IS THE INSTALLED SDK'S. The page kept only the ids it
  // already knew, so a model the shell offered (Fable, Sonnet 5.5) was dropped
  // from the picker before anyone could see it.
  it("offers every model the shell's SDK advertised, one the page never listed included", async () => {
    const discovered = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-fable-5-1[1m]", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ]
    const fake = installFakeBridge(
      { runtimeLocation: "local", localModels: discovered },
      { localModels: discovered.map((model) => model.id) },
    )
    renderChip()
    // The default is the preferred model, under the dated id the SDK gave it.
    expect(label()).toBe("Claude Haiku 4.5")
    const menu = await openMenu()
    const local = menu.querySelector('[data-testid="model-section-local"]') as HTMLElement
    const entries = domWithin(local)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(entries).toEqual(["Claude Opus 5.5", "Claude Fable 5.1", "Claude Haiku 4.5"])

    pick("Claude Fable 5.1")
    await waitFor(() => expect(label()).toBe("Claude Fable 5.1"))
    await startLocalSession(THREAD, "agent-1")
    expect(fake.calls.started).toEqual([
      { threadId: THREAD, agentId: "agent-1", model: "claude-fable-5-1[1m]" },
    ])
  })

  // 2026-10-15: a shell whose sidecar predates the current-models rule says
  // every pinned version its SDK lists (twelve on SDK 0.3.296). The picker
  // offers each family's current model only.
  it("offers only each family's current model when the shell says every pinned version", async () => {
    const said = [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ].map((id) => ({ id, label: id }))
    installFakeBridge(
      { runtimeLocation: "local", localModels: said },
      { localModels: said.map((model) => model.id) },
    )
    renderChip()
    const menu = await openMenu()
    const local = menu.querySelector('[data-testid="model-section-local"]') as HTMLElement
    const entries = domWithin(local)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(entries).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ])
  })

  // Review of #63: a conversation that picked an older version before the
  // offer was narrowed keeps running on it while the shell runs it, and a
  // conversation with no choice runs a current model, never a pinned one.
  it("an open conversation on an older version the shell runs stays on it", () => {
    const said = [
      "claude-opus-5-5",
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
    ].map((id) => ({ id, label: id }))
    installFakeBridge(
      { runtimeLocation: "local", localModels: said },
      { localModels: said.map((model) => model.id) },
    )
    localStorage.setItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD, "claude-opus-4-6")
    expect(localModelFor(THREAD)).toBe("claude-opus-4-6")
    expect(localModelFor("thread-without-choice")).toBe("claude-haiku-5-5")
  })

  // Re-review of #63: a conversation kept on an older version showed the
  // generic local label and no checked entry.
  it("a conversation kept on an older version names it on the chip and checks its entry", async () => {
    const said = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    ]
    installFakeBridge(
      { runtimeLocation: "local", localModels: said },
      { localModels: said.map((model) => model.id) },
    )
    localStorage.setItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD, "claude-opus-4-6")
    renderChip()
    expect(label()).toBe("Claude Opus 4.6")
    const menu = await openMenu()
    const local = menu.querySelector('[data-testid="model-section-local"]') as HTMLElement
    const kept = domWithin(local).getByRole("menuitem", { name: "Claude Opus 4.6" })
    expect(kept.className).toContain("text-accent")
  })

  it("a choice the shell no longer offers is kept, and the default runs meanwhile", () => {
    localStorage.setItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD, "claude-fable-5-1[1m]")
    installFakeBridge({ runtimeLocation: "local" }, { localModels: LOCAL_IDS })
    expect(localModelFor(THREAD)).toBe("claude-haiku-4-5")
    expect(chooseLocalModel(THREAD, "claude-fable-5-1[1m]")).toBe(false)
    expect(localStorage.getItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD)).toBe("claude-fable-5-1[1m]")
  })

  // 2026-10-01: a saved choice the SDK no longer offers fell to the global
  // Haiku default, so a conversation on Sonnet silently ran on Haiku.
  it("a saved choice the SDK dropped runs on its newest offered sibling, else its dated id", () => {
    const discovered = [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ]
    installFakeBridge(
      { runtimeLocation: "local", localModels: discovered },
      { localModels: discovered.map((model) => model.id) },
    )
    localStorage.setItem(LOCAL_MODEL_STORAGE_PREFIX + THREAD, "claude-sonnet-5")
    expect(localModelFor(THREAD)).toBe("claude-sonnet-5-5")
    localStorage.setItem(`${LOCAL_MODEL_STORAGE_PREFIX}thread-2`, "claude-haiku-4-5")
    expect(localModelFor("thread-2")).toBe("claude-haiku-4-5-20251001")
    localStorage.setItem(`${LOCAL_MODEL_STORAGE_PREFIX}thread-3`, "claude-fable-5-1[1m]")
    expect(localModelFor("thread-3")).toBe("claude-haiku-4-5-20251001")
  })

  it("a shell that cannot choose a model keeps its single entry, and the chip says it runs here", () => {
    installFakeBridge({ runtimeLocation: "local" })
    renderChip()
    expect(label()).toBe("Your Claude Code login")
  })
})

describe("the local model reaches the session", () => {
  beforeEach(() => {
    localStorage.clear()
    resetLocalTurnMessages()
  })
  afterEach(() => {
    uninstallFakeBridge()
    localStorage.clear()
  })

  it("a start carries this conversation's local model", async () => {
    const fake = installFakeBridge({}, { localModels: LOCAL_IDS })
    chooseLocalModel(THREAD, "claude-sonnet-5")
    await startLocalSession(THREAD, "agent-1")
    expect(fake.calls.started).toEqual([
      { threadId: THREAD, agentId: "agent-1", model: "claude-sonnet-5" },
    ])
  })

  it("a Liaison model id is never stored as a local choice", () => {
    installFakeBridge({}, { localModels: LOCAL_IDS })
    expect(chooseLocalModel(THREAD, "gemini-pro-latest")).toBe(false)
    expect(chooseLocalModel(THREAD, "claude-opus-4-6")).toBe(false)
    expect(localModelFor(THREAD)).toBe("claude-haiku-4-5")
  })

  it("a shell that predates the choice is not handed a model", async () => {
    const fake = installFakeBridge()
    await startLocalSession(THREAD, "agent-1")
    expect(fake.calls.started[0]).not.toHaveProperty("model")
  })

  it("a pick made while the session runs is applied before the next turn", async () => {
    const fake = installFakeBridge(liveSession(THREAD, "agent-1", { model: "claude-haiku-4-5" }), {
      localModels: LOCAL_IDS,
    })
    chooseLocalModel(THREAD, "claude-opus-5-5")
    runMessageAsLocalTurn({ threadId: THREAD, messageId: "m1", authorKind: "user", text: "hi" })
    await waitFor(() => expect(fake.calls.turns).toEqual(["m1"]))
    expect(fake.calls.started).toEqual([
      { threadId: THREAD, agentId: "agent-1", model: "claude-opus-5-5" },
    ])
  })

  it("a session already on the chosen model is not restarted", async () => {
    const fake = installFakeBridge(liveSession(THREAD, "agent-1", { model: "claude-opus-5-5" }), {
      localModels: LOCAL_IDS,
    })
    chooseLocalModel(THREAD, "claude-opus-5-5")
    runMessageAsLocalTurn({ threadId: THREAD, messageId: "m2", authorKind: "user", text: "hi" })
    await waitFor(() => expect(fake.calls.turns).toEqual(["m2"]))
    expect(fake.calls.started).toEqual([])
  })
})
