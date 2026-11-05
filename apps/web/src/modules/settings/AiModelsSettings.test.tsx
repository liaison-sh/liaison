// SPDX-License-Identifier: FSL-1.1-ALv2
// S9: Settings -> AI -> AI models. The admin decides which models the org can
// use and which one Auto runs, sets provider keys, adds OpenRouter models from
// the catalogue and models from its own servers. Every control is checked by
// the request it sends (the S7 admin API), never by its look.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { resetCreditsStore } from "~/modules/agent/credits/credits-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import AiModelsSettings from "~/modules/settings/AiModelsSettings"
import { ApiContext } from "~/modules/shell/ApiContext"

const reasoningAll = { allowedLevels: ["off", "low", "medium", "high"], defaultLevel: "off" }

function adminPayload(over: Record<string, unknown> = {}) {
  return {
    providers: [
      {
        provider: "anthropic",
        label: "Anthropic",
        keySet: true,
        usable: true,
        maskedHint: "3fA",
      },
      { provider: "openai", label: "OpenAI", keySet: false, usable: false },
      { provider: "google", label: "Google", keySet: true, usable: true, maskedHint: "7Qk" },
      { provider: "mistral", label: "Mistral", keySet: false, usable: false },
      {
        provider: "openrouter",
        label: "OpenRouter",
        keySet: true,
        usable: true,
        maskedHint: "a91",
      },
    ],
    servers: [] as Array<{ id: string; name: string; baseURL: string; addedAt: string }>,
    auto: { modelKey: null as string | null, resolvedKey: "gemini-flash-lite-latest" },
    models: [
      {
        key: "gemini-flash-lite-latest",
        provider: "google",
        displayName: "Gemini Flash-Lite",
        enabled: true,
        native: true,
        contextWindow: 1_000_000,
        inputCostPerM: "0.10",
        outputCostPerM: "0.40",
        tools: true,
        reasoning: { allowedLevels: ["low", "medium", "high"], defaultLevel: "low" },
      },
      {
        key: "claude-haiku-4-5",
        provider: "anthropic",
        displayName: "Claude Haiku 4.5",
        enabled: true,
        native: true,
        contextWindow: 200_000,
        inputCostPerM: "1.00",
        outputCostPerM: "5.00",
        tools: true,
        reasoning: reasoningAll,
      },
      {
        key: "gpt-5.4",
        provider: "openai",
        displayName: "GPT-5.4",
        enabled: false,
        native: true,
        contextWindow: 400_000,
        inputCostPerM: "1.25",
        outputCostPerM: "10.00",
        tools: true,
        reasoning: reasoningAll,
      },
    ],
    ...over,
  }
}

const CATALOGUE = [
  {
    upstreamId: "deepseek/deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    contextWindow: 1_000_000,
    inputCostPerM: "0.28",
    outputCostPerM: "1.10",
    tools: true,
    reasoningEfforts: ["low", "high"],
    added: false,
  },
  {
    upstreamId: "qwen/qwen3.5-coder",
    displayName: "Qwen 3.5 Coder",
    contextWindow: 256_000,
    inputCostPerM: "0.20",
    outputCostPerM: "0.90",
    tools: true,
    reasoningEfforts: [],
    added: false,
  },
]

let payload = adminPayload()

function setup(
  handlers: {
    get?: (path: string) => unknown
    post?: (path: string, body: unknown) => unknown
    patch?: (path: string, body: unknown) => unknown
    delete?: (path: string) => unknown
  } = {},
) {
  const api: any = {
    get: vi.fn(async (path: string) => {
      const own = handlers.get?.(path)
      if (own !== undefined) return own
      if (path === "/settings/ai/models") return payload
      if (path.startsWith("/settings/ai/openrouter/catalogue")) return CATALOGUE
      if (path === "/credits/models") return { models: [] }
      return null
    }),
    post: vi.fn(async (path: string, body: unknown) => handlers.post?.(path, body) ?? {}),
    patch: vi.fn(async (path: string, body: unknown) => handlers.patch?.(path, body) ?? {}),
    delete: vi.fn(async (path: string) => handlers.delete?.(path) ?? {}),
    put: vi.fn(),
  }
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <AiModelsSettings />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return api
}

beforeEach(() => {
  payload = adminPayload()
  resetCreditsStore()
})
afterEach(() => cleanup())

describe("AI models: switching models on and off", () => {
  it("switching a model off sends PATCH with disable, switching one on sends enable", async () => {
    // GPT-5.4 is switched off and its provider runs (a keyless one is not listed).
    payload = adminPayload({
      providers: adminPayload().providers.map((p) =>
        p.provider === "openai" ? { ...p, usable: true } : p,
      ),
    })
    const api = setup()
    const haiku = await screen.findByTestId("ai-model-switch-claude-haiku-4-5")
    expect(haiku.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(haiku)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", {
        disable: ["claude-haiku-4-5"],
      }),
    )
    fireEvent.click(screen.getByTestId("ai-model-switch-gpt-5.4"))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", { enable: ["gpt-5.4"] }),
    )
  })

  it("the model Auto runs cannot be switched off: its switch is disabled", async () => {
    const api = setup()
    const auto = await screen.findByTestId("ai-model-switch-gemini-flash-lite-latest")
    expect(auto).toBeDisabled()
    expect(screen.getByTestId("ai-model-row-gemini-flash-lite-latest")).toHaveTextContent("Auto")
    fireEvent.click(auto)
    expect(api.patch).not.toHaveBeenCalled()
  })

  it("puts a switch back when the server refuses the change", async () => {
    setup({
      patch: () => {
        throw new ApiError("Auto runs this model", 409, "auto_model")
      },
    })
    const haiku = await screen.findByTestId("ai-model-switch-claude-haiku-4-5")
    fireEvent.click(haiku)
    await waitFor(() => expect(haiku.getAttribute("aria-checked")).toBe("true"))
  })

  it("counts the models switched on", async () => {
    setup()
    expect(await screen.findByTestId("ai-models-on-count")).toHaveTextContent("2")
  })
})

describe("AI models: Auto", () => {
  it("choosing a model for Auto sends its key, choosing the default rule sends null", async () => {
    payload = adminPayload({
      auto: { modelKey: "claude-haiku-4-5", resolvedKey: "claude-haiku-4-5" },
    })
    const api = setup()
    const select = (await screen.findByTestId("ai-models-auto-select")) as HTMLSelectElement
    // Only models switched on are offered to Auto.
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "gemini-flash-lite-latest",
      "claude-haiku-4-5",
    ])
    expect(select.value).toBe("claude-haiku-4-5")
    fireEvent.change(select, { target: { value: "gemini-flash-lite-latest" } })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", {
        autoModelKey: "gemini-flash-lite-latest",
      }),
    )
    fireEvent.change(select, { target: { value: "" } })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", { autoModelKey: null }),
    )
  })

  it("says when Auto fell back because its chosen model cannot run", async () => {
    payload = adminPayload({
      auto: { modelKey: "gpt-5.4", resolvedKey: "gemini-flash-lite-latest" },
    })
    setup()
    const note = await screen.findByTestId("ai-models-auto-fallback")
    expect(note).toHaveTextContent("Gemini Flash-Lite")
    expect(note).toHaveTextContent("GPT-5.4")
    // The keyless model chosen for Auto stays listed, flagged as not used.
    expect(screen.getByTestId("ai-model-key-removed-gpt-5.4")).toHaveTextContent(
      "Key removed, not used",
    )
  })
})

describe("AI models: default reasoning level", () => {
  it("shows the stored level, sends the chosen one, and null for the built-in default", async () => {
    payload = adminPayload({ defaultReasoningLevel: "high" })
    const api = setup()
    const select = (await screen.findByTestId("ai-models-reasoning-select")) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(["", "off", "low", "medium", "high"])
    expect([...select.options].map((o) => o.textContent)).toContain("High")
    expect(select.value).toBe("high")
    fireEvent.change(select, { target: { value: "medium" } })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", {
        defaultReasoningLevel: "medium",
      }),
    )
    fireEvent.change(select, { target: { value: "" } })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/settings/ai/models", {
        defaultReasoningLevel: null,
      }),
    )
  })

  it("reads an unset level as the built-in default", async () => {
    setup()
    const select = (await screen.findByTestId("ai-models-reasoning-select")) as HTMLSelectElement
    expect(select.value).toBe("")
  })
})

describe("AI models: the OpenRouter catalogue", () => {
  it("lists the catalogue with tool calling only by default, and the search filters it", async () => {
    const api = setup()
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    await screen.findByTestId("catalogue-row-deepseek/deepseek-v4.1-flash")
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("toolsOnly=true"))
    expect(screen.getByTestId("catalogue-row-qwen/qwen3.5-coder")).toBeInTheDocument()

    fireEvent.input(screen.getByTestId("catalogue-search"), { target: { value: "qwen" } })
    await waitFor(() =>
      expect(screen.queryByTestId("catalogue-row-deepseek/deepseek-v4.1-flash")).toBeNull(),
    )
    expect(screen.getByTestId("catalogue-row-qwen/qwen3.5-coder")).toBeInTheDocument()
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining("q=qwen")))
  })

  it("unticking tool calling only asks for every model", async () => {
    const api = setup()
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    const toolsOnly = (await screen.findByTestId("catalogue-tools-only")) as HTMLInputElement
    expect(toolsOnly.checked).toBe(true)
    fireEvent.click(toolsOnly)
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining("toolsOnly=false")),
    )
  })

  it("switching a catalogue model on posts it, then reloads the models", async () => {
    const api = setup()
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    fireEvent.click(await screen.findByTestId("catalogue-add-deepseek/deepseek-v4.1-flash"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/openrouter/models", {
        upstreamId: "deepseek/deepseek-v4.1-flash",
      }),
    )
    await waitFor(() =>
      expect(
        api.get.mock.calls.filter(([p]: [string]) => p === "/settings/ai/models"),
      ).toHaveLength(2),
    )
  })

  it("shows the provider's reason when the test call fails", async () => {
    setup({
      post: (path) => {
        if (path === "/settings/ai/openrouter/models")
          throw new ApiError("No provider meets your data policy", 422)
        return undefined
      },
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    fireEvent.click(await screen.findByTestId("catalogue-add-deepseek/deepseek-v4.1-flash"))
    expect(await screen.findByTestId("catalogue-error")).toHaveTextContent(
      "No provider meets your data policy",
    )
  })

  it("a model with no fixed price is listed but its add button is off, with the reason", async () => {
    const api = setup({
      get: (path) =>
        path.startsWith("/settings/ai/openrouter/catalogue")
          ? [
              ...CATALOGUE,
              {
                upstreamId: "acme/auto-router",
                displayName: "Acme Auto Router",
                contextWindow: 128_000,
                inputCostPerM: null,
                outputCostPerM: null,
                tools: true,
                reasoningEfforts: [],
                added: false,
                addable: false,
                notAddableReason: "This model has no fixed price, so it cannot be added.",
              },
            ]
          : undefined,
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    const row = await screen.findByTestId("catalogue-row-acme/auto-router")
    const button = within(row).getByTestId("catalogue-add-acme/auto-router") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(row).toHaveTextContent(/no fixed price/i)
    fireEvent.click(button)
    expect(api.post).not.toHaveBeenCalled()
    const other = screen.getByTestId("catalogue-add-qwen/qwen3.5-coder") as HTMLButtonElement
    expect(other.disabled).toBe(false)
  })

  it("asks for an OpenRouter key when none is set", async () => {
    setup({
      get: (path) => {
        if (path.startsWith("/settings/ai/openrouter/catalogue"))
          throw new ApiError("OpenRouter key required", 412)
        return undefined
      },
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-catalogue"))
    expect(await screen.findByTestId("catalogue-needs-key")).toBeInTheDocument()
  })
})

describe("AI models: your own server", () => {
  it("Test and add creates the server, adds the model and shows the test result", async () => {
    const api = setup({
      post: (path, body) => {
        if (path === "/settings/ai/servers")
          return { id: "ab12cd34", name: "gpu-box.internal", baseURL: (body as any).baseURL }
        if (path === "/settings/ai/servers/ab12cd34/models")
          return { key: "custom/ab12cd34/qwen3.5-32b", tools: true }
        return undefined
      },
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-server"))
    fireEvent.input(screen.getByTestId("server-address"), {
      target: { value: "http://gpu-box.internal:8000/v1" },
    })
    fireEvent.input(screen.getByTestId("server-key"), { target: { value: "sk-local" } })
    fireEvent.input(screen.getByTestId("server-model"), { target: { value: "qwen3.5-32b" } })
    fireEvent.click(screen.getByTestId("server-test"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/servers", {
        name: "gpu-box.internal",
        baseURL: "http://gpu-box.internal:8000/v1",
        apiKey: "sk-local",
      }),
    )
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/servers/ab12cd34/models", {
        name: "qwen3.5-32b",
      }),
    )
    const result = await screen.findByTestId("server-result")
    expect(result.dataset.outcome).toBe("tools")
    expect(result).toHaveTextContent("tool call returned correctly")
  })

  it("reuses a server already set up at the same address", async () => {
    payload = adminPayload({
      servers: [
        {
          id: "ab12cd34",
          name: "GPU box",
          baseURL: "http://gpu-box.internal:8000/v1",
          addedAt: "",
        },
      ],
    })
    const api = setup({
      post: (path) =>
        path === "/settings/ai/servers/ab12cd34/models"
          ? { key: "custom/ab12cd34/llama", tools: false }
          : undefined,
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-server"))
    fireEvent.input(screen.getByTestId("server-address"), {
      target: { value: "http://gpu-box.internal:8000/v1" },
    })
    fireEvent.input(screen.getByTestId("server-model"), { target: { value: "llama" } })
    fireEvent.click(screen.getByTestId("server-test"))
    const result = await screen.findByTestId("server-result")
    expect(result.dataset.outcome).toBe("no-tools")
    expect(api.post).not.toHaveBeenCalledWith("/settings/ai/servers", expect.anything())
  })

  it("shows the server's failure in plain words", async () => {
    setup({
      post: (path) => {
        if (path === "/settings/ai/servers") return { id: "ab12cd34", name: "x", baseURL: "x" }
        if (path === "/settings/ai/servers/ab12cd34/models")
          throw new ApiError("This address is on a private network", 422)
        return undefined
      },
    })
    fireEvent.click(await screen.findByTestId("ai-models-open-server"))
    fireEvent.input(screen.getByTestId("server-address"), {
      target: { value: "http://10.0.0.2:8000/v1" },
    })
    fireEvent.input(screen.getByTestId("server-model"), { target: { value: "m" } })
    fireEvent.click(screen.getByTestId("server-test"))
    const result = await screen.findByTestId("server-result")
    expect(result.dataset.outcome).toBe("error")
    expect(result).toHaveTextContent("This address is on a private network")
  })
})

describe("AI models: provider keys", () => {
  it("sets a key inline", async () => {
    const api = setup()
    const card = await screen.findByTestId("provider-card-openai")
    expect(card).toHaveTextContent("OpenAI: add an API key to use 1 model")
    fireEvent.click(within(card).getByTestId("provider-configure-openai"))
    fireEvent.input(within(card).getByTestId("provider-key-input-openai"), {
      target: { value: "sk-test" },
    })
    fireEvent.click(within(card).getByTestId("provider-key-save-openai"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/keys", {
        provider: "openai",
        apiKey: "sk-test",
      }),
    )
  })

  it("removes a key after an inline confirmation", async () => {
    const api = setup()
    const card = await screen.findByTestId("provider-card-anthropic")
    expect(card).toHaveTextContent("Connected (3fA)")
    fireEvent.click(within(card).getByTestId("provider-remove-anthropic"))
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByTestId("provider-remove-confirm-anthropic"))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/settings/ai/keys/anthropic"))
  })

  it("re-checks a key that is set", async () => {
    const api = setup()
    const card = await screen.findByTestId("provider-card-google")
    fireEvent.click(within(card).getByTestId("provider-recheck-google"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/keys/google/validate", {}),
    )
  })

  it("a provider running on the deployment's key reads so, offers an org key, and its models can be Auto", async () => {
    payload = adminPayload({
      providers: adminPayload().providers.map((p) =>
        p.provider === "openai" ? { ...p, usable: true } : p,
      ),
      models: adminPayload().models.map((m) => (m.key === "gpt-5.4" ? { ...m, enabled: true } : m)),
    })
    const api = setup()
    const card = await screen.findByTestId("provider-card-openai")
    expect(card).toHaveTextContent("Deployment key")
    expect(card).not.toHaveTextContent("Not connected")
    fireEvent.click(within(card).getByTestId("provider-configure-openai"))
    fireEvent.input(within(card).getByTestId("provider-key-input-openai"), {
      target: { value: "sk-org" },
    })
    fireEvent.click(within(card).getByTestId("provider-key-save-openai"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/keys", {
        provider: "openai",
        apiKey: "sk-org",
      }),
    )

    const select = (await screen.findByTestId("ai-models-auto-select")) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toContain("gpt-5.4")
    expect(screen.getByTestId("ai-model-row-gpt-5.4")).not.toHaveTextContent(/no key/i)
  })

  it("offers an OpenRouter key tile", async () => {
    setup()
    expect(await screen.findByTestId("provider-card-openrouter")).toHaveTextContent("OpenRouter")
  })
})

// S1 (D18): the table lists the models the org can run. A keyless provider's
// native models fold into one row per provider that takes the key; an added
// model or the Auto pick whose provider lost its key stays, flagged.
describe("AI models: key filter", () => {
  const nativeModel = (key: string, provider: string, displayName: string) => ({
    key,
    provider,
    displayName,
    enabled: true,
    native: true,
    contextWindow: 200_000,
    inputCostPerM: "1.00",
    outputCostPerM: "5.00",
    tools: true,
    reasoning: reasoningAll,
  })
  const deepseek = {
    ...nativeModel("openrouter/deepseek/deepseek-v4.1-flash", "openrouter", "DeepSeek V4.1 Flash"),
    native: false,
  }
  const providers = (usable: Record<string, boolean>) =>
    adminPayload().providers.map((p) => ({
      ...p,
      keySet: usable[p.provider] ?? false,
      usable: usable[p.provider] ?? false,
    }))
  const onlyOpenRouter = () =>
    adminPayload({
      providers: providers({ openrouter: true }),
      auto: { modelKey: null, resolvedKey: deepseek.key },
      models: [
        nativeModel("claude-haiku-4-5", "anthropic", "Claude Haiku 4.5"),
        nativeModel("claude-sonnet-4-6", "anthropic", "Claude Sonnet 4.6"),
        nativeModel("gemini-flash-lite-latest", "google", "Gemini Flash-Lite"),
        deepseek,
      ],
    })

  it("with only an OpenRouter key, lists only what runs and one locked row per keyless provider", async () => {
    payload = onlyOpenRouter()
    setup()
    expect(await screen.findByTestId(`ai-model-row-${deepseek.key}`)).toBeInTheDocument()
    expect(screen.queryByTestId("ai-model-row-claude-haiku-4-5")).not.toBeInTheDocument()
    expect(screen.queryByTestId("ai-model-row-claude-sonnet-4-6")).not.toBeInTheDocument()
    expect(screen.queryByTestId("ai-model-row-gemini-flash-lite-latest")).not.toBeInTheDocument()
    expect(screen.getByTestId("provider-locked-anthropic")).toHaveTextContent(
      "Anthropic: add an API key to use 2 models",
    )
    expect(screen.getByTestId("provider-locked-google")).toHaveTextContent(
      "Google: add an API key to use 1 model",
    )
    expect(screen.getByTestId("provider-locked-openai")).toHaveTextContent("OpenAI: add an API key")
    expect(screen.getByTestId("provider-locked-mistral")).toHaveTextContent(
      "Mistral: add an API key",
    )
    expect(screen.queryByTestId("provider-locked-openrouter")).not.toBeInTheDocument()
    // Only visible rows count.
    expect(screen.getByTestId("ai-models-on-count")).toHaveTextContent("1")
  })

  it("a locked row takes the key, and the provider's models join the table after the reload", async () => {
    payload = onlyOpenRouter()
    const api = setup()
    const row = await screen.findByTestId("provider-card-anthropic")
    expect(within(row).queryByTestId("provider-key-input-anthropic")).not.toBeInTheDocument()
    fireEvent.click(within(row).getByTestId("provider-configure-anthropic"))
    const keyInput = within(row).getByTestId("provider-key-input-anthropic")
    // A password manager must not offer a saved login for an API key.
    expect(keyInput).toHaveAttribute("autocomplete", "new-password")
    expect(keyInput).toHaveAttribute("name", "provider-api-key-anthropic")
    expect(keyInput).toHaveAttribute("data-1p-ignore")
    expect(keyInput).toHaveAttribute("data-lpignore", "true")
    fireEvent.input(keyInput, {
      target: { value: "sk-ant" },
    })
    payload = { ...onlyOpenRouter(), providers: providers({ openrouter: true, anthropic: true }) }
    fireEvent.click(within(row).getByTestId("provider-key-save-anthropic"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/settings/ai/keys", {
        provider: "anthropic",
        apiKey: "sk-ant",
      }),
    )
    expect(await screen.findByTestId("ai-model-row-claude-haiku-4-5")).toBeInTheDocument()
    expect(screen.getByTestId("ai-model-row-claude-sonnet-4-6")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-locked-anthropic")).not.toBeInTheDocument()
  })

  it("an added model whose provider lost its key stays listed, flagged", async () => {
    payload = adminPayload({
      providers: providers({ google: true }),
      models: [nativeModel("gemini-flash-lite-latest", "google", "Gemini Flash-Lite"), deepseek],
    })
    setup()
    expect(await screen.findByTestId(`ai-model-key-removed-${deepseek.key}`)).toHaveTextContent(
      "Key removed, not used",
    )
    expect(screen.getByTestId("provider-locked-openrouter")).toHaveTextContent(
      "OpenRouter: add an API key",
    )
    expect(
      screen.queryByTestId("ai-model-key-removed-gemini-flash-lite-latest"),
    ).not.toBeInTheDocument()
  })

  it("OpenRouter without a key and without models still offers its key field", async () => {
    payload = adminPayload({
      providers: providers({ google: true }),
      models: [nativeModel("gemini-flash-lite-latest", "google", "Gemini Flash-Lite")],
    })
    setup()
    fireEvent.click(await screen.findByTestId("provider-configure-openrouter"))
    expect(screen.getByTestId("provider-key-input-openrouter")).toBeInTheDocument()
  })
})

describe("AI models: voice dictation", () => {
  it("shows the Voice dictation section and reads it again after a key is saved", async () => {
    const api = setup({
      get: (path) =>
        path === "/settings/ai/transcription"
          ? { available: [], current: null, default: null }
          : undefined,
    })
    expect(await screen.findByTestId("ai-models-voice-empty")).toBeInTheDocument()
    const reads = () =>
      api.get.mock.calls.filter(([p]: [string]) => p === "/settings/ai/transcription").length
    expect(reads()).toBe(1)
    fireEvent.click(await screen.findByTestId("provider-configure-openai"))
    fireEvent.input(await screen.findByTestId("provider-key-input-openai"), {
      target: { value: "sk-test" },
    })
    fireEvent.click(screen.getByTestId("provider-key-save-openai"))
    await waitFor(() => expect(reads()).toBe(2))
  })
})
