// SPDX-License-Identifier: FSL-1.1-ALv2
// "This should be a DEFAULT selection, but at any time, in any chat, a user
// should be able to change the model an agent is using." The composer had no
// model control at all, and the agent's own default was a column nothing read.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  COMPACT_MODEL_CHIP_MAX_PX,
  modelNameWithoutProvider,
  modelShortLabel,
  parseServedModels,
  setServedModels,
} from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { syncShellTier } from "~/modules/shell/shell-tier"
import ThreadModelChip from "~/modules/threads/ThreadModelChip"

// Labels come from the served list (GET /credits/models, S6).
beforeAll(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
afterAll(() => setServedModels(null))

const balance = { included: "0", purchased: "10", currency: "EUR", tier: "team" }

/** The phone viewport the screenshot pass used. */
const PHONE_WIDTH_PX = 390

function setTier(tier: "desktop" | "phone") {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches:
        tier === "desktop"
          ? query.includes("min-width: 1024px")
          : query.includes("max-width: 639px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  syncShellTier()
}

function renderChip(props: {
  agentModelId: string | null
  agentDefaultModelId: string | null
  onSelect?: (id: string | null) => void
}) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <ThreadModelChip
        balance={balance}
        availableModelIds={null}
        agentModelId={props.agentModelId}
        agentDefaultModelId={props.agentDefaultModelId}
        onSelect={props.onSelect ?? (() => {})}
      />
    </I18nProvider>
  ))
}

describe("the composer's per-chat model chip", () => {
  afterEach(cleanup)

  // The dock's chip read "Default (Auto · Google: Gemini 3.1 Flash Lite)": it
  // took a line of its own under the controls and pushed Send down. The chip
  // says "Default"; the model it resolves to is its tooltip and the menu's
  // first entry.
  it("says just Default when the chat pins nothing, the agent's model in its title", () => {
    renderChip({ agentModelId: null, agentDefaultModelId: "claude-opus-4-6" })
    const chip = screen.getByTestId("thread-model-chip")
    expect(chip.getAttribute("data-effective-model")).toBe("claude-opus-4-6")
    const label = screen.getByTestId("model-selector-label")
    expect(label.textContent).toBe("Default")
    expect((label.closest("button") as HTMLElement).title).toBe("Default (Claude Opus 4.6)")
  })

  it("on Auto, says Default and keeps the model Auto runs in the title and the menu", async () => {
    const served = parseServedModels(SERVED_MODELS_FIXTURE)
    const runs = served.models.find((m) => m.key === "gemini-flash-latest")
    if (!runs) throw new Error("fixture lacks gemini-flash-latest")
    setServedModels({ ...served, autoResolvedKey: runs.key })
    try {
      renderChip({ agentModelId: null, agentDefaultModelId: null })
      const label = screen.getByTestId("model-selector-label")
      expect(label.textContent).toBe("Default")
      const full = `Default (Auto · ${runs.displayName})`
      expect((label.closest("button") as HTMLElement).title).toBe(full)
      const trigger = screen.getByLabelText("Select model")
      trigger.focus()
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
      const menu = await screen.findByRole("menu")
      expect(menu.textContent).toContain(full)
    } finally {
      setServedModels(served)
    }
  })

  it("caps a long model name with an ellipsis, the full name in its title", () => {
    renderChip({ agentModelId: "gemini-flash-latest", agentDefaultModelId: null })
    const label = screen.getByTestId("model-selector-label")
    for (const c of ["truncate", "max-w-[16ch]", "min-w-0"]) {
      expect(label.classList.contains(c)).toBe(true)
    }
    expect((label.closest("button") as HTMLElement).title).toBe(label.textContent)
  })

  // The dock's chip read "Google:…": the provider took the whole room and
  // the model's own name never showed. The chip names the model, the
  // provider stays in the title and the menu.
  it('a long "Provider: Model" name shows the model\'s own name, the full one in title and menu', async () => {
    const served = parseServedModels(SERVED_MODELS_FIXTURE)
    const key = "openrouter/google/gemini-3.1-flash-lite"
    const full = "Google: Gemini 3.1 Flash Lite"
    setServedModels(
      parseServedModels({
        ...SERVED_MODELS_FIXTURE,
        models: [
          ...SERVED_MODELS_FIXTURE.models,
          { ...SERVED_MODELS_FIXTURE.models[0], key, modelId: key, displayName: full },
        ],
      }),
    )
    try {
      renderChip({ agentModelId: key, agentDefaultModelId: null })
      const label = screen.getByTestId("model-selector-label")
      expect(label.textContent?.startsWith("Gemini")).toBe(true)
      expect(label.textContent).toBe("Gemini 3.1 Flash Lite")
      expect(label.classList.contains("truncate")).toBe(true)
      expect((label.closest("button") as HTMLElement).title).toBe(full)
      const trigger = screen.getByLabelText("Select model")
      trigger.focus()
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
      const menu = await screen.findByRole("menu")
      expect(menu.textContent).toContain(full)
    } finally {
      setServedModels(served)
    }
  })

  it("can shrink inside the control row (min-w-0 down to the label)", () => {
    renderChip({ agentModelId: "gemini-flash-latest", agentDefaultModelId: null })
    const chip = screen.getByTestId("thread-model-chip")
    expect(chip.classList.contains("min-w-0")).toBe(true)
    const button = screen.getByTestId("model-selector-label").closest("button") as HTMLElement
    expect(button.classList.contains("min-w-0")).toBe(true)
  })

  it("shows the chat's own override once it is set, not the agent's default", () => {
    renderChip({ agentModelId: "gemini-flash-latest", agentDefaultModelId: "claude-opus-4-6" })
    const chip = screen.getByTestId("thread-model-chip")
    expect(chip.getAttribute("data-effective-model")).toBe("gemini-flash-latest")
    expect(screen.getByTestId("model-selector-label").textContent).not.toContain("Default")
  })

  it("picking a model writes the override for this chat", async () => {
    const onSelect = vi.fn()
    renderChip({ agentModelId: null, agentDefaultModelId: "claude-opus-4-6", onSelect })
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    // The first entry is what the chat falls back to, named after the agent.
    expect(menu.textContent).toContain("Default (Claude Opus 4.6)")
    const item = Array.from(menu.querySelectorAll("[role='menuitem']")).find((el) =>
      (el.textContent ?? "").includes("Claude Haiku"),
    ) as HTMLElement
    expect(item).toBeTruthy()
    fireEvent.keyDown(item, { key: "Enter" })
    await waitFor(() => expect(onSelect).toHaveBeenCalled())
    expect(String(onSelect.mock.calls[0][0])).toContain("haiku")
  })
})

describe("modelNameWithoutProvider", () => {
  it('drops a "<Provider>: " prefix and keeps the model\'s name', () => {
    expect(modelNameWithoutProvider("Google: Gemini 3.1 Flash Lite")).toBe("Gemini 3.1 Flash Lite")
    expect(modelNameWithoutProvider("OpenAI: GPT-5.4 Mini")).toBe("GPT-5.4 Mini")
    expect(modelNameWithoutProvider("DeepSeek: DeepSeek V4.1")).toBe("DeepSeek V4.1")
    expect(modelNameWithoutProvider("Mistral AI: Small 4")).toBe("Small 4")
  })

  it("leaves a name with no provider prefix alone", () => {
    expect(modelNameWithoutProvider("Claude Opus 4.6")).toBe("Claude Opus 4.6")
    expect(modelNameWithoutProvider("Default")).toBe("Default")
    expect(modelNameWithoutProvider("Default (Auto · Google: Gemini)")).toBe(
      "Default (Auto · Google: Gemini)",
    )
  })
})

describe("modelShortLabel", () => {
  // The chip read "GF" beside a send button: two initials are a code, not a
  // model. The short label drops the family word and keeps a NAME.
  it("drops the family word and keeps the variant", () => {
    expect(modelShortLabel("claude-opus-4-6")).toBe("Opus 4.6")
    expect(modelShortLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6")
    expect(modelShortLabel("gemini-flash-lite-latest")).toBe("Flash-Lite")
    expect(modelShortLabel("mistral-small-latest")).toBe("Small 4")
  })

  it("keeps a label whose first word is the model itself", () => {
    expect(modelShortLabel("gpt-5.4")).toBe("GPT-5.4")
    expect(modelShortLabel("gpt-5.4-nano")).toBe("GPT-5.4 Nano")
    expect(modelShortLabel(null)).toBe("Auto")
  })

  // The chip follows the seated agent's default when the conversation sets no
  // override, and it must then read exactly as that model does.
  it("shortens a Default (...) label to the model inside it", () => {
    expect(modelShortLabel("Default (Gemini Flash-Lite)")).toBe(
      modelShortLabel("gemini-flash-lite-latest"),
    )
    expect(modelShortLabel("Default (Claude Opus 4.6)")).toBe(modelShortLabel("claude-opus-4-6"))
  })

  it('names the model, not its provider, for a "Provider: Model" label', () => {
    const served = parseServedModels(SERVED_MODELS_FIXTURE)
    const key = "openrouter/google/gemini-3.1-flash-lite"
    setServedModels(
      parseServedModels({
        ...SERVED_MODELS_FIXTURE,
        models: [
          ...SERVED_MODELS_FIXTURE.models,
          {
            ...SERVED_MODELS_FIXTURE.models[0],
            key,
            modelId: key,
            displayName: "Google: Gemini 3.1 Flash Lite",
          },
        ],
      }),
    )
    try {
      expect(modelShortLabel(key).startsWith("Gemini")).toBe(true)
    } finally {
      setServedModels(served)
    }
  })

  it("is never bare initials", () => {
    for (const id of [null, "claude-opus-4-6", "gemini-flash-lite-latest", "gpt-5.4-nano"]) {
      expect(modelShortLabel(id).length).toBeGreaterThan(2)
    }
  })
})

// F6. On a phone the chip carried the whole label ("Default (Claude Opus
// 4.6)") and took about 320 of the row's 390px: the editor collapsed to
// "Mes...".
describe("the model chip at phone width", () => {
  afterEach(() => {
    cleanup()
    setTier("desktop")
  })

  it("carries the model's short NAME, capped so the control line does not wrap", () => {
    setTier("phone")
    renderChip({ agentModelId: "claude-opus-4-6", agentDefaultModelId: null })

    const label = screen.getByTestId("model-selector-label")
    expect(label.textContent).toBe("Opus 4.6")

    const trigger = label.closest("button") as HTMLElement
    expect(trigger.getAttribute("data-compact")).toBe("true")
    expect(getComputedStyle(trigger).maxWidth).toBe(`${COMPACT_MODEL_CHIP_MAX_PX}px`)

    // The cap is what keeps the chip from pushing send off the control line:
    // the `+` and the send circle need about 80px of a 390px row between them.
    expect(COMPACT_MODEL_CHIP_MAX_PX).toBeLessThanOrEqual(PHONE_WIDTH_PX - 200)
  })

  it("on the default, says Default there too", () => {
    setTier("phone")
    renderChip({ agentModelId: null, agentDefaultModelId: "claude-opus-4-6" })
    expect(screen.getByTestId("model-selector-label").textContent).toBe("Default")
  })

  it("still opens the same selector, where the full names live", async () => {
    setTier("phone")
    const onSelect = vi.fn()
    renderChip({ agentModelId: null, agentDefaultModelId: "claude-opus-4-6", onSelect })

    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("Default (Claude Opus 4.6)")
  })

  it("keeps the full label at desktop width", () => {
    setTier("desktop")
    renderChip({ agentModelId: "gemini-flash-latest", agentDefaultModelId: "claude-opus-4-6" })
    const label = screen.getByTestId("model-selector-label")
    expect(label.textContent).toContain("Gemini Flash")
    expect((label.closest("button") as HTMLElement).getAttribute("data-compact")).toBe("false")
  })
})
