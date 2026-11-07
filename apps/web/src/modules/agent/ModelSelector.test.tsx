// SPDX-License-Identifier: FSL-1.1-ALv2
import { within as domWithin, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE, SERVED_OPENROUTER_MODEL } from "~/lib/model-groups.fixture"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import ModelSelector from "./ModelSelector"

describe("ModelSelector", () => {
  // The menu lists what GET /credits/models served (S6): every test here is
  // served the native catalogue unless it says otherwise.
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })
  it("renders Auto as static pill when purchased is 0", () => {
    render(() => (
      <ModelSelector
        balance={{ included: "100", purchased: "0", currency: "EUR" }}
        selectedModelId={null}
        onSelect={() => {}}
      />
    ))
    const pill = screen.getByText("Auto")
    expect(pill).toBeInTheDocument()
  })

  it("renders interactive dropdown trigger when purchased > 0", () => {
    render(() => (
      <ModelSelector
        balance={{ included: "100", purchased: "50", currency: "EUR" }}
        selectedModelId={null}
        onSelect={() => {}}
      />
    ))
    // PopupMenu.Trigger (outer) + inner <button> both have role=button
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    // Any of the buttons should contain "Auto"
    expect(buttons.some((b) => b.textContent?.includes("Auto"))).toBe(true)
  })

  it("renders interactive dropdown when purchased is a small positive value (0.01)", () => {
    // Verifies the gating condition === 0, not <= 0
    render(() => (
      <ModelSelector
        balance={{ included: "100", purchased: "0.01", currency: "EUR" }}
        selectedModelId={null}
        onSelect={() => {}}
      />
    ))
    const buttons = screen.getAllByRole("button")
    expect(buttons.some((b) => b.textContent?.includes("Auto"))).toBe(true)
  })

  it("self_hosted unlocks the full menu with NO balance (BYOK, billing is managed-only)", () => {
    // Self-hosted has no credits/tier concept (lib/edition.ts). The full model
    // menu must be available regardless of balance — here balance is null, which
    // in managed mode would render the static Auto pill, but self_hosted overrides.
    BillingStateTestAccess.setMode("self_hosted")
    render(() => <ModelSelector balance={null} selectedModelId={null} onSelect={() => {}} />)
    // Interactive trigger (role=button) present → full menu, not the static span.
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThanOrEqual(1)
  })

  // A NULL BALANCE IS "UNKNOWN", NOT "NO CREDITS". The session credits store
  // starts null and stays null for as long as /credits/balance is slow, parked
  // behind a backoff or answered 429, and treating that as a locked org left a
  // whole conversation with a dead grey word for a model control.
  it("managed with an UNKNOWN balance still names the effective model", () => {
    BillingStateTestAccess.setMode("managed")
    render(() => (
      <ModelSelector
        balance={null}
        selectedModelId={null}
        defaultEntryLabel="Default (Gemini Flash-Lite)"
        onSelect={() => {}}
      />
    ))
    expect(screen.getByTestId("model-selector-label").textContent).toBe(
      "Default (Gemini Flash-Lite)",
    )
    expect(screen.getByTestId("model-selector-label").dataset.locked).toBeUndefined()
  })

  it("managed with an UNKNOWN balance opens the picker with the real model list", async () => {
    BillingStateTestAccess.setMode("managed")
    render(() => <ModelSelector balance={null} selectedModelId={null} onSelect={() => {}} />)
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    expect(domWithin(menu).getByText("Anthropic")).toBeInTheDocument()
  })

  it("managed: each model reads its ≈ N× against Auto, never a price (S18)", async () => {
    BillingStateTestAccess.setMode("managed")
    const managed = {
      ...SERVED_MODELS_FIXTURE,
      models: SERVED_MODELS_FIXTURE.models.map(
        ({ inputCostPerM: _i, outputCostPerM: _o, ...m }, i) => ({
          ...m,
          multiplier: i === 0 ? 1.4 : 3,
        }),
      ),
    }
    setServedModels(parseServedModels(managed))
    render(() => <ModelSelector balance={null} selectedModelId={null} onSelect={() => {}} />)
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    const first = SERVED_MODELS_FIXTURE.models[0].key
    expect(domWithin(menu).getByTestId(`model-multiplier-${first}`).textContent).toBe("≈ 1.4×")
    expect(menu.textContent).toContain("≈ 3×")
    expect(menu.textContent).not.toMatch(/€|EUR|USD|\$/)
  })

  it("self_hosted: no multiplier is shown (the server serves none)", async () => {
    BillingStateTestAccess.setMode("self_hosted")
    render(() => <ModelSelector balance={null} selectedModelId={null} onSelect={() => {}} />)
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    expect(menu.querySelector('[data-testid^="model-multiplier-"]')).toBeNull()
  })

  it("a CONFIRMED empty balance locks the menu and says why, still naming the model", () => {
    BillingStateTestAccess.setMode("managed")
    render(() => (
      <ModelSelector
        balance={{ included: "0", purchased: "0", currency: "EUR", tier: "starter" }}
        selectedModelId={null}
        defaultEntryLabel="Default (Gemini Flash-Lite)"
        onSelect={() => {}}
      />
    ))
    const locked = screen.getByTestId("model-selector-label")
    expect(locked.dataset.locked).toBe("true")
    expect(locked.getAttribute("title")).toBe("Upgrade to change model")
    expect(locked.textContent).toBe("Default (Gemini Flash-Lite)")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
  // P6d-T10: ONE model control, not two. The desktop's own local entry joins
  // this menu as its own section; the five provider groups are not regrouped,
  // they are nested one level under a "Liaison models" header.
  describe("local models section (S14)", () => {
    const UNLOCKED = { included: "100", purchased: "50", currency: "EUR" }

    async function openMenu(): Promise<HTMLElement> {
      const trigger = screen.getByLabelText("Select model")
      trigger.focus()
      fireEvent.keyDown(trigger, { key: "ArrowDown" })
      return await screen.findByRole("menu")
    }

    function renderSelector(onSelect: (id: string | null) => void = () => {}) {
      return render(() => (
        <ModelSelector balance={UNLOCKED} selectedModelId={null} onSelect={onSelect} />
      ))
    }

    afterEach(() => uninstallFakeBridge())

    it("[S14] model selector renders the two section headers on the desktop", async () => {
      installFakeBridge()
      renderSelector()
      const menu = await openMenu()
      expect(menu.querySelectorAll('[data-testid="model-section-local"]').length).toBe(1)
      expect(menu.querySelectorAll('[data-testid="model-section-liaison"]').length).toBe(1)
      expect(screen.getAllByText("Local models")).toHaveLength(1)
      expect(screen.getAllByText("Liaison models")).toHaveLength(1)
      expect(screen.getAllByText("Your Claude Code login")).toHaveLength(1)
    })

    // P6d-FX1 (SK-7). Two things the T10 deviation left behind: a wrapper the
    // browser still rendered, and a control a locked org could now reach.
    it("[S14] a browser's open menu carries no desktop wrapper element at all", async () => {
      uninstallFakeBridge()
      render(() => <ModelSelector balance={UNLOCKED} selectedModelId={null} onSelect={() => {}} />)
      const menu = await openMenu()
      const shell = menu.querySelector("div.w-48") as HTMLElement
      expect(shell).not.toBeNull()
      // Every child of the popup is a provider GROUP. The desktop's own
      // section wrappers are plain divs, and the Liaison one used to render in
      // a browser too (only its attribute was conditional), which is a new
      // element in markup this slice promised not to touch. The T01 baseline
      // cannot see it: it renders the five surfaces CLOSED, and this content
      // is portalled out of the container anyway. The reasoning row is the
      // menu's own (on Auto it shows the level Auto runs at), not a wrapper.
      const strays = Array.from(shell.children).filter(
        (child) =>
          child.getAttribute("role") !== "group" &&
          child.getAttribute("data-testid") !== "reasoning-row",
      )
      expect(strays.map((child) => child.tagName)).toEqual([])
    })

    it("[S14] a locked org on a desktop reaches Auto and nothing else, reasoning included", async () => {
      BillingStateTestAccess.setMode("managed")
      installFakeBridge()
      render(() => (
        <ModelSelector
          balance={{ included: "0", purchased: "0", currency: "EUR", tier: "starter" }}
          selectedModelId="claude-opus-4-6"
          reasoningLevel="off"
          onSelectReasoning={() => {}}
          onSelect={() => {}}
        />
      ))
      const menu = await openMenu()
      const liaison = menu.querySelector('[data-testid="model-section-liaison"]')
      expect(domWithin(liaison as HTMLElement).getByText("Auto")).toBeInTheDocument()
      expect(domWithin(liaison as HTMLElement).queryByText("Anthropic")).toBeNull()
      // The model list was gated; the reasoning control beside it was not, so a
      // locked org could change a level it could never reach before.
      expect(menu.querySelector('[data-testid="reasoning-row"]')).toBeNull()
    })

    it("[S14] an unlocked org still has the reasoning control", async () => {
      installFakeBridge()
      render(() => (
        <ModelSelector
          balance={UNLOCKED}
          selectedModelId="claude-opus-4-6"
          reasoningLevel="off"
          onSelectReasoning={() => {}}
          onSelect={() => {}}
        />
      ))
      const menu = await openMenu()
      expect(menu.querySelector('[data-testid="reasoning-row"]')).not.toBeNull()
    })

    it("[S14] the provider labels still render nested under Liaison models", async () => {
      installFakeBridge()
      renderSelector()
      const menu = await openMenu()
      const liaison = menu.querySelector('[data-testid="model-section-liaison"]')
      expect(liaison).not.toBeNull()
      // Four labels, not five: the Auto group's only entry IS its provider
      // name, so it has never rendered a label, here or in the desktop picker.
      for (const provider of ["Anthropic", "OpenAI", "Google", "Mistral"]) {
        const label = screen.getByText(provider)
        expect(liaison?.contains(label)).toBe(true)
      }
      // "Auto" is also the trigger's own text, so this one is asked of the
      // section and not of the document.
      expect(domWithin(liaison as HTMLElement).getByText("Auto")).toBeInTheDocument()
    })

    it("[S14] selecting either section leaves the agent definition request identical", async () => {
      const requests: string[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${String(input)} ${JSON.stringify(init ?? {})}`)
        return Promise.resolve(new Response("{}", { status: 200 }))
      }) as typeof fetch

      try {
        installFakeBridge()
        renderSelector()
        await openMenu()
        fireEvent.keyDown(
          screen.getByText("Your Claude Code login").closest('[role="menuitem"]') as HTMLElement,
          { key: "Enter" },
        )
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
        const afterLocal = [...requests]

        const reopened = await openMenu()
        expect(reopened).toBeTruthy()
        fireEvent.keyDown(
          screen.getByText("Claude Sonnet 4.6").closest('[role="menuitem"]') as HTMLElement,
          { key: "Enter" },
        )
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

        expect(requests).toEqual(afterLocal)
        expect(requests.join(" ")).not.toContain("asUser")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("[S14] choosing the local entry runs the turns on this machine", async () => {
      const fake = installFakeBridge()
      renderSelector()
      await openMenu()
      fireEvent.keyDown(
        screen.getByText("Your Claude Code login").closest('[role="menuitem"]') as HTMLElement,
        { key: "Enter" },
      )
      await waitFor(() => expect(fake.calls.locations).toEqual(["local"]))
    })

    it("[S14] choosing a Liaison model hands the turns back to Liaison", async () => {
      const fake = installFakeBridge({ runtimeLocation: "local" })
      const picked: Array<string | null> = []
      renderSelector((id) => picked.push(id))
      await openMenu()
      fireEvent.keyDown(
        screen.getByText("Claude Sonnet 4.6").closest('[role="menuitem"]') as HTMLElement,
        { key: "Enter" },
      )
      await waitFor(() => expect(fake.calls.locations).toEqual(["liaison"]))
      expect(picked).toEqual(["claude-sonnet-4-6"])
    })

    it("model selector renders no local section in a browser", async () => {
      uninstallFakeBridge()
      renderSelector()
      const menu = await openMenu()
      expect(menu.querySelector('[data-testid="model-section-local"]')).toBeNull()
      expect(menu.querySelector('[data-testid="model-section-liaison"]')).toBeNull()
      expect(screen.queryByText("Local models")).toBeNull()
      expect(screen.queryByText("Liaison models")).toBeNull()
      expect(screen.queryByText("Your Claude Code login")).toBeNull()
      for (const provider of ["Anthropic", "OpenAI", "Google", "Mistral"]) {
        expect(screen.getByText(provider)).toBeInTheDocument()
      }
    })
  })
})

// S6: the composer menu is the served list. An admin's added OpenRouter model
// shows under its own provider label; a model the server did not send (switched
// off, or keyless) is offered nowhere, whatever the old static list said.
describe("ModelSelector lists exactly the served models (S6)", () => {
  const UNLOCKED = { included: "100", purchased: "50", currency: "EUR" }
  afterEach(() => {
    BillingStateTestAccess.reset()
    setServedModels(null)
  })

  async function openMenu(): Promise<HTMLElement> {
    const trigger = screen.getByLabelText("Select model")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    return await screen.findByRole("menu")
  }

  it("offers a served OpenRouter model and not a model absent from the answer", async () => {
    const haiku = SERVED_MODELS_FIXTURE.models.find((m) => m.key === "claude-haiku-4-5")
    setServedModels(
      parseServedModels({
        autoModelKey: null,
        autoResolvedKey: "claude-haiku-4-5",
        models: [haiku, SERVED_OPENROUTER_MODEL],
      }),
    )
    render(() => <ModelSelector balance={UNLOCKED} selectedModelId={null} onSelect={() => {}} />)
    const menu = await openMenu()
    const items = domWithin(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent)
    expect(items).toEqual(["Auto · Claude Haiku 4.5", "Claude Haiku 4.5", "DeepSeek V4.1 Flash"])
    expect(domWithin(menu).getByText("OpenRouter")).toBeInTheDocument()
    expect(domWithin(menu).queryByText("Claude Opus 4.6")).toBeNull()
    expect(domWithin(menu).queryByText("Google")).toBeNull()
  })

  it("picking the OpenRouter model hands its key to the host", async () => {
    setServedModels(parseServedModels({ models: [SERVED_OPENROUTER_MODEL] }))
    const picked: Array<string | null> = []
    render(() => (
      <ModelSelector balance={UNLOCKED} selectedModelId={null} onSelect={(id) => picked.push(id)} />
    ))
    await openMenu()
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "DeepSeek V4.1 Flash" }), {
      key: "Enter",
    })
    await waitFor(() => expect(picked).toEqual([SERVED_OPENROUTER_MODEL.key]))
  })

  it("the reasoning row offers the served levels of the selected model", async () => {
    setServedModels(parseServedModels({ models: [SERVED_OPENROUTER_MODEL] }))
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId={SERVED_OPENROUTER_MODEL.key}
        reasoningLevel="low"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    const levels = Array.from(menu.querySelectorAll('[data-testid^="reasoning-level-"]')).map(
      (el) => el.getAttribute("data-testid"),
    )
    expect(levels).toEqual(["reasoning-level-low", "reasoning-level-high"])
    expect(screen.getByTestId("model-selector-label").textContent).toBe("DeepSeek V4.1 Flash")
  })

  // THE MENU SHOWS THE LEVEL A TURN RUNS AT (resolveTurnReasoningLevel): a turn
  // whose model Auto picks runs at High whatever level is asked, so on Auto the
  // row shows that level alone, read only, and offers nothing the server ignores.
  function levelsOf(menu: HTMLElement) {
    return Array.from(menu.querySelectorAll('[data-testid^="reasoning-level-"]')).map((el) => ({
      id: el.getAttribute("data-testid"),
      pressed: el.getAttribute("aria-pressed"),
      disabled: (el as HTMLButtonElement).disabled,
    }))
  }

  it("on Auto the row shows High alone, read only, with a note", async () => {
    setServedModels(
      parseServedModels({ ...SERVED_MODELS_FIXTURE, autoResolvedKey: "claude-sonnet-4-6" }),
    )
    const asked: string[] = []
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId={null}
        reasoningLevel="off"
        onSelectReasoning={(l) => asked.push(l)}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    expect(levelsOf(menu)).toEqual([
      { id: "reasoning-level-high", pressed: "true", disabled: true },
    ])
    expect(screen.getByTestId("reasoning-auto-note").textContent).toBe("Set by Auto")
    fireEvent.click(screen.getByTestId("reasoning-level-high"))
    expect(asked).toEqual([])
  })

  it("on Auto the row shows the level the server serves for Auto (a demo box key's Low)", async () => {
    setServedModels(
      parseServedModels({
        ...SERVED_MODELS_FIXTURE,
        autoResolvedKey: "claude-sonnet-4-6",
        autoReasoningLevel: "low",
      }),
    )
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId={null}
        reasoningLevel="high"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    expect(levelsOf(menu)).toEqual([{ id: "reasoning-level-low", pressed: "true", disabled: true }])
    expect(screen.getByTestId("reasoning-auto-note").textContent).toBe("Set by Auto")
  })

  it("a chosen model with no level asked shows the org's default level selected", async () => {
    setServedModels(parseServedModels({ ...SERVED_MODELS_FIXTURE, defaultReasoningLevel: "high" }))
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId="claude-sonnet-4-6"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    const pressed = levelsOf(menu).filter((l) => l.pressed === "true")
    expect(pressed.map((l) => l.id)).toEqual(["reasoning-level-high"])
  })

  it("on Auto a model that cannot reason shows Off", async () => {
    setServedModels(
      parseServedModels({ ...SERVED_MODELS_FIXTURE, autoResolvedKey: "mistral-small-latest" }),
    )
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId={null}
        reasoningLevel="high"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    expect(levelsOf(menu)).toEqual([{ id: "reasoning-level-off", pressed: "true", disabled: true }])
  })

  it("the demo's Auto row, picked, shows its one level selected", async () => {
    // The demo's "Auto (demo)" pin is served with High as its only level.
    const pin = {
      ...SERVED_OPENROUTER_MODEL,
      key: "demo/auto",
      modelId: "demo/auto",
      displayName: "Auto (demo)",
      reasoning: { allowedLevels: ["high"], defaultLevel: "high" },
    }
    setServedModels(parseServedModels({ models: [pin] }))
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId="demo/auto"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    expect(levelsOf(menu)).toEqual([
      { id: "reasoning-level-high", pressed: "true", disabled: false },
    ])
  })

  it("following the agent's own model keeps the row hidden, as before", async () => {
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId={null}
        agentDefaultModelId="claude-opus-4-6"
        reasoningLevel="off"
        onSelectReasoning={() => {}}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    expect(menu.querySelector('[data-testid="reasoning-row"]')).toBeNull()
  })

  it("an explicit pick still offers every level, the stored one selected", async () => {
    const asked: string[] = []
    render(() => (
      <ModelSelector
        balance={UNLOCKED}
        selectedModelId="claude-opus-4-6"
        reasoningLevel="low"
        onSelectReasoning={(l) => asked.push(l)}
        onSelect={() => {}}
      />
    ))
    const menu = await openMenu()
    const levels = levelsOf(menu)
    expect(levels.map((l) => l.id)).toEqual([
      "reasoning-level-off",
      "reasoning-level-low",
      "reasoning-level-medium",
      "reasoning-level-high",
    ])
    expect(levels.filter((l) => l.pressed === "true").map((l) => l.id)).toEqual([
      "reasoning-level-low",
    ])
    expect(screen.queryByTestId("reasoning-auto-note")).toBeNull()
    fireEvent.click(screen.getByTestId("reasoning-level-high"))
    expect(asked).toEqual(["high"])
  })
})
