// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE, SERVED_OPENROUTER_MODEL } from "~/lib/model-groups.fixture"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import AgentMessageMenu from "./AgentMessageMenu"

function renderMenu(hasPurchasedCredits: boolean) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <AgentMessageMenu
        currentModelId={null}
        hasPurchasedCredits={hasPurchasedCredits}
        onSelectModel={() => {}}
      />
    </I18nProvider>
  ))
}

describe("AgentMessageMenu — model-change gate", () => {
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })

  it("self_hosted with NO purchased credits still unlocks the model menu (BYOK, billing is managed-only)", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    renderMenu(false)
    const trigger = screen.getByRole("button")
    await fireEvent.pointerDown(trigger)
    // The "upgrade to change model" copy must NOT show on self-hosted.
    expect(screen.queryByText(/upgrade to change model/i)).not.toBeInTheDocument()
    // A real model entry should be selectable instead.
    expect(await screen.findByText("Auto")).toBeInTheDocument()
  })

  it("managed with purchased credits unlocks the model menu", async () => {
    BillingStateTestAccess.setMode("managed")
    renderMenu(true)
    const trigger = screen.getByRole("button")
    await fireEvent.pointerDown(trigger)
    expect(screen.queryByText(/upgrade to change model/i)).not.toBeInTheDocument()
    expect(await screen.findByText("Auto")).toBeInTheDocument()
  })

  it("managed with NO purchased credits shows the upgrade-to-change-model fallback", async () => {
    BillingStateTestAccess.setMode("managed")
    renderMenu(false)
    const trigger = screen.getByRole("button")
    await fireEvent.pointerDown(trigger)
    expect(await screen.findByText(/upgrade to change model/i)).toBeInTheDocument()
  })

  it("unknown/unloaded billing mode with no purchased credits shows the upgrade fallback (fails closed)", async () => {
    // billingMode() is null before /billing/state resolves — must not
    // accidentally unlock the menu during that window.
    renderMenu(false)
    const trigger = screen.getByRole("button")
    await fireEvent.pointerDown(trigger)
    expect(await screen.findByText(/upgrade to change model/i)).toBeInTheDocument()
  })
})

describe("AgentMessageMenu — provider-key (BYOK) filtering", () => {
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })

  it("hides models whose provider has no registered key (same contract as ModelSelector)", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentMessageMenu
          currentModelId={null}
          hasPurchasedCredits={false}
          onSelectModel={() => {}}
          availableModelIds={new Set(["claude-sonnet-4-6", "claude-haiku-4-5"])}
        />
      </I18nProvider>
    ))
    await fireEvent.pointerDown(screen.getByRole("button"))
    expect(await screen.findByText("Claude Sonnet 4.6")).toBeInTheDocument()
    // No key registered for these providers — they must not be offered.
    expect(screen.queryByText("Gemini Flash-Lite")).not.toBeInTheDocument()
    expect(screen.queryByText("GPT-5.4")).not.toBeInTheDocument()
    expect(screen.queryByText(/mistral/i)).not.toBeInTheDocument()
    // Auto is never provider-keyed.
    expect(screen.getByText("Auto")).toBeInTheDocument()
  })

  it("with no narrower set, offers every served model", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentMessageMenu
          currentModelId={null}
          hasPurchasedCredits={false}
          onSelectModel={() => {}}
          availableModelIds={null}
        />
      </I18nProvider>
    ))
    await fireEvent.pointerDown(screen.getByRole("button"))
    expect(await screen.findByText("Gemini Flash-Lite")).toBeInTheDocument()
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument()
  })
})

describe("AgentMessageMenu — merged manage + model menu (single '...' trigger)", () => {
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })

  it("shows Edit/Delete alongside the model section when the viewer can manage", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentMessageMenu
          currentModelId={null}
          hasPurchasedCredits={false}
          onSelectModel={() => {}}
          canManage
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </I18nProvider>
    ))
    // Exactly ONE trigger button for the whole message menu.
    expect(screen.getAllByRole("button").length).toBe(1)
    await fireEvent.pointerDown(screen.getByRole("button"))
    expect(await screen.findByText("Edit")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    expect(screen.getByText("Auto")).toBeInTheDocument()
  })

  it("renders manage actions only (no model list) when onSelectModel is absent", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentMessageMenu
          currentModelId={null}
          hasPurchasedCredits={false}
          canManage
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </I18nProvider>
    ))
    await fireEvent.pointerDown(screen.getByRole("button"))
    expect(await screen.findByText("Edit")).toBeInTheDocument()
    expect(screen.queryByText("Auto")).not.toBeInTheDocument()
    expect(screen.queryByText(/upgrade to change model/i)).not.toBeInTheDocument()
  })
})

describe("AgentMessageMenu — the served list (S6)", () => {
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })

  it("offers a served OpenRouter model and nothing the server did not send", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    setServedModels(parseServedModels({ models: [SERVED_OPENROUTER_MODEL] }))
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentMessageMenu
          currentModelId={null}
          hasPurchasedCredits={false}
          onSelectModel={() => {}}
        />
      </I18nProvider>
    ))
    await fireEvent.pointerDown(screen.getByRole("button"))
    expect(await screen.findByText("DeepSeek V4.1 Flash")).toBeInTheDocument()
    expect(screen.getByText("OpenRouter")).toBeInTheDocument()
    expect(screen.queryByText("Claude Sonnet 4.6")).not.toBeInTheDocument()
    expect(screen.queryByText("Gemini Flash-Lite")).not.toBeInTheDocument()
  })
})
