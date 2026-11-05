// SPDX-License-Identifier: FSL-1.1-ALv2
// S7: the AI models page's "Voice dictation" setting, checked by what it lists
// and the request each choice sends.

import type { TranscriptionSettings } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { VoiceDictationSection } from "./VoiceDictationSection"

const TWO: TranscriptionSettings = {
  available: [
    {
      key: "or:whisper",
      label: "Whisper large v3",
      provider: "OpenRouter",
      pricePerMinuteUsd: 0.006,
    },
    { key: "or:voxtral", label: "Voxtral mini", provider: "OpenRouter", pricePerMinuteUsd: 0.001 },
  ],
  current: null,
  default: "or:voxtral",
}

function setup(read: () => TranscriptionSettings, locale: "en" | "fr" = "en") {
  const get = vi.fn().mockImplementation(async () => read())
  const patch = vi
    .fn()
    .mockImplementation(async (_path: string, body: { modelKey: string | null }) => ({
      ...read(),
      current: body.modelKey,
    }))
  const api: Partial<ApiClient> = { get, patch }
  const [version, setVersion] = createSignal(0)
  render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as ApiClient}>
        <VoiceDictationSection version={version()} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { get, patch, bump: () => setVersion((v) => v + 1) }
}

const option = (key: string) => {
  const row = screen.getAllByTestId("ai-models-voice-option").find((r) => r.dataset.key === key)
  if (!row) throw new Error(`no option ${key}`)
  return row
}
const radio = (key: string) => {
  const input = option(key).querySelector("input")
  if (!input) throw new Error("no radio")
  return input
}

afterEach(() => cleanup())

describe("Voice dictation setting", () => {
  it("lists the available models with their price per minute; the default is badged and chosen", async () => {
    setup(() => TWO)
    await waitFor(() => expect(screen.getAllByTestId("ai-models-voice-option")).toHaveLength(2))
    expect(option("or:whisper").textContent).toContain("$0.006 per minute")
    expect(option("or:voxtral").textContent).toContain("Default")
    expect(screen.getAllByTestId("ai-models-voice-default")).toHaveLength(1)
    expect(radio("or:voxtral").checked).toBe(true)
    expect(radio("or:whisper").checked).toBe(false)
  })

  it("choosing a model pins it; choosing the default again follows the default (null)", async () => {
    const { patch } = setup(() => TWO)
    await waitFor(() => expect(screen.getAllByTestId("ai-models-voice-option")).toHaveLength(2))
    fireEvent.click(radio("or:whisper"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/transcription", { modelKey: "or:whisper" }),
    )
    await waitFor(() => expect(radio("or:whisper").checked).toBe(true))
    fireEvent.click(radio("or:voxtral"))
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/settings/ai/transcription", { modelKey: null }),
    )
  })

  it("with no capable key, says which key enables dictation (in French too)", async () => {
    setup(() => ({ available: [], current: null, default: null }), "fr")
    const empty = await screen.findByTestId("ai-models-voice-empty")
    expect(empty.textContent).toContain("Ajoutez une clé OpenRouter ou Google AI")
    expect(screen.getByText("Dictée vocale")).toBeInTheDocument()
  })

  it("reads the list again when the page's keys change", async () => {
    let state: TranscriptionSettings = { available: [], current: null, default: null }
    const { get, bump } = setup(() => state)
    await screen.findByTestId("ai-models-voice-empty")
    state = TWO
    bump()
    await waitFor(() => expect(screen.getAllByTestId("ai-models-voice-option")).toHaveLength(2))
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe("voice dictation on a managed cell (S18)", () => {
  it("shows credits per minute, never a price", async () => {
    setup(() => ({
      available: [
        {
          key: "or:whisper",
          label: "Whisper large v3",
          provider: "OpenRouter",
          creditsPerMinute: 0.0062,
        },
        {
          key: "or:voxtral",
          label: "Voxtral mini",
          provider: "OpenRouter",
          creditsPerMinute: 0.002,
        },
      ],
      current: null,
      default: "or:voxtral",
    }))
    await waitFor(() => expect(screen.getAllByTestId("ai-models-voice-option")).toHaveLength(2))
    expect(option("or:whisper").textContent).toContain("0.0062")
    expect(option("or:whisper").textContent).toMatch(/credits/)
    expect(option("or:whisper").textContent).not.toMatch(/\$|USD|€/)
  })
})
