// SPDX-License-Identifier: FSL-1.1-ALv2
// The appSecrets block: set or not (never a value), the webhook address to paste, a write-only
// field that sends the secret once to the kernel's route and clears, and the route's refusal
// shown as it is.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { apiError, createFakeApi, type FakeApi } from "./__fixtures__/fake-api"

const state = vi.hoisted(() => ({ api: null as unknown }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))

import { AppSecretsBlock } from "./AppSecretsBlock"

let api: FakeApi
const PATH = "/connections/stripe/stripe/app-secrets"
const URL_ = "https://x.example/webhooks/org/stripe/events"

function read(set: boolean, previousUntil: string | null = null) {
  return {
    secrets: [
      {
        key: "webhookSigningSecret",
        label: "Webhook signing secret",
        help: "It starts with whsec_.",
        set,
        previousUntil,
      },
    ],
    webhooks: [{ endpoint: "events", url: URL_ }],
  }
}

function mount() {
  return render(() => (
    <AppSecretsBlock app="stripe" block={{ block: "appSecrets", connection: "stripe" }} />
  ))
}

function input(): HTMLInputElement {
  const el = screen.getByTestId("settings-app-secret-input-webhookSigningSecret")
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input")
  return el
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
})

describe("AppSecretsBlock", () => {
  it("shows the webhook address, not set, and a password field", async () => {
    api.on("get", PATH, () => read(false))
    mount()
    expect((await screen.findByTestId("settings-app-secrets-webhook-events")).textContent).toBe(
      URL_,
    )
    expect(
      screen.getByTestId("settings-app-secret-state-webhookSigningSecret").textContent,
    ).toContain("Not set yet.")
    expect(input().type).toBe("password")
    expect(input().value).toBe("")
  })

  it("puts the trimmed value once to the field's route, clears the field and reads again", async () => {
    let set = false
    api.on("get", PATH, () => read(set))
    api.on("put", `${PATH}/webhookSigningSecret`, () => {
      set = true
      return { key: "webhookSigningSecret", set: true, rolled: false, unchanged: false }
    })
    mount()
    await screen.findByTestId("settings-app-secret-input-webhookSigningSecret")
    fireEvent.input(input(), { target: { value: "  whsec_abcdefghijklmnop0123  " } })
    fireEvent.click(screen.getByTestId("settings-app-secret-save-webhookSigningSecret"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        `${PATH}/webhookSigningSecret`,
        { value: "whsec_abcdefghijklmnop0123" },
        { suppressGlobalError: true },
      ),
    )
    await waitFor(() =>
      expect(
        screen.getByTestId("settings-app-secret-state-webhookSigningSecret").textContent,
      ).toContain("Set."),
    )
    expect(input().value).toBe("")
    expect(api.put).toHaveBeenCalledTimes(1)
  })

  it("a set secret offers Replace and says until when the previous one works", async () => {
    api.on("get", PATH, () => read(true, "2026-11-27T11:00:00.000Z"))
    mount()
    const save = await screen.findByTestId("settings-app-secret-save-webhookSigningSecret")
    expect(save.textContent).toBe("Replace")
    expect(
      screen.getByTestId("settings-app-secret-state-webhookSigningSecret").textContent,
    ).toContain("The previous one keeps working until")
  })

  it("shows the route's refusal, which never holds the value, and keeps what was typed", async () => {
    api.on("get", PATH, () => read(false))
    api.on("put", `${PATH}/webhookSigningSecret`, () => {
      throw apiError(400, "invalid_value", "A webhook signing secret starts with whsec_.")
    })
    mount()
    await screen.findByTestId("settings-app-secret-input-webhookSigningSecret")
    fireEvent.input(input(), { target: { value: "rk_live_nope" } })
    fireEvent.click(screen.getByTestId("settings-app-secret-save-webhookSigningSecret"))
    expect(
      (await screen.findByTestId("settings-app-secret-error-webhookSigningSecret")).textContent,
    ).toBe("A webhook signing secret starts with whsec_.")
    expect(input().value).toBe("rk_live_nope")
  })
})
