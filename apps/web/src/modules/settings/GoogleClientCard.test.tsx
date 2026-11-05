// SPDX-License-Identifier: FSL-1.1-ALv2
// The workspace's Google client card (Mail settings page "Gmail & Google
// sign-in", Security > Sign-in methods). Moved from the former Mail Setup page.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifyEntityChange } from "~/framework/entity-changes"
import { GoogleClientCard } from "~/modules/settings/GoogleClientCard"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

function renderCard() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <GoogleClientCard />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("GoogleClientCard", () => {
  let savedGoogleCredentials = false
  let deploymentClient = false
  let reconnectToMove = 0

  beforeEach(() => {
    savedGoogleCredentials = false
    deploymentClient = false
    reconnectToMove = 0
    resetToastStore()
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)

        if (url.includes("/api/settings/integrations/google") && init?.method === "PATCH") {
          savedGoogleCredentials = true
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: {
                  provider: "google",
                  configured: true,
                  configurationSource: "org",
                  clientIdHint: "...ient-id",
                  reconnectToMove,
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          )
        }

        if (url.includes("/api/settings/integrations/google")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: savedGoogleCredentials
                  ? {
                      provider: "google",
                      configured: true,
                      configurationSource: "org",
                      clientIdHint: "...ient-id",
                    }
                  : deploymentClient
                    ? {
                        provider: "google",
                        configured: true,
                        configurationSource: "deployment",
                        clientIdHint: "...-deploy",
                      }
                    : {
                        provider: "google",
                        configured: false,
                        configurationSource: null,
                      },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          )
        }

        return Promise.reject(new Error(`Unhandled fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("a client saved from a card in a conversation shows without a reload", async () => {
    renderCard()
    expect(await screen.findByText("Setup required")).toBeInTheDocument()
    expect(await screen.findByLabelText(/client id/i)).toBeInTheDocument()

    // The card saved the client; the server announces it on the mail:provider frame.
    savedGoogleCredentials = true
    notifyEntityChange({
      key: "mail:provider",
      app: "mail",
      entity: "provider",
      action: "update",
      data: { id: "gmail", integrationConfigured: true },
    })
    await waitFor(() =>
      expect(screen.getByText("Configured for this workspace")).toBeInTheDocument(),
    )
    expect(screen.getByText("...ient-id")).toBeInTheDocument()
    expect(screen.queryByLabelText(/client id/i)).toBeNull()
  })

  it("saves Google credentials", async () => {
    renderCard()

    expect(await screen.findByText("Google credentials")).toBeInTheDocument()

    fireEvent.input(await screen.findByLabelText(/client id/i), {
      target: { value: "123456789-orgtest.apps.googleusercontent.com" },
    })
    fireEvent.input(screen.getByLabelText(/client secret/i), {
      target: { value: "google-client-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save google credentials/i }))

    await waitFor(() => {
      expect(screen.getByText("Configured for this workspace")).toBeInTheDocument()
    })
  })

  it("saving a client while accounts run on another tells the admin a reconnect moves them", async () => {
    reconnectToMove = 3
    renderCard()
    fireEvent.input(await screen.findByLabelText(/client id/i), {
      target: { value: "123456789-orgtest.apps.googleusercontent.com" },
    })
    fireEvent.input(screen.getByLabelText(/client secret/i), {
      target: { value: "google-client-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save google credentials/i }))
    await waitFor(() =>
      expect(toasts().some((t) => t.message.includes("3") && t.message.includes("reconnect"))).toBe(
        true,
      ),
    )
  })

  it("flags a client ID that is not a Google OAuth client id and blocks saving", async () => {
    renderCard()

    expect(await screen.findByText("Google credentials")).toBeInTheDocument()

    fireEvent.input(await screen.findByLabelText(/client id/i), {
      target: { value: "someone@example.com" },
    })
    fireEvent.input(screen.getByLabelText(/client secret/i), {
      target: { value: "google-client-secret" },
    })

    expect(screen.getByTestId("mail-google-client-id-error")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /save google credentials/i })).toBeDisabled()
  })

  it("a deployment client: says so with its id hint, and keeps the override behind a disclosure", async () => {
    deploymentClient = true
    renderCard()

    expect(await screen.findByTestId("mail-google-deployment-client")).toHaveTextContent(
      "Google OAuth client provided by this deployment",
    )
    expect(screen.getByTestId("mail-google-deployment-client")).toHaveTextContent("...-deploy")
    expect(screen.queryByLabelText(/client id/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/client secret/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("mail-google-override-toggle"))
    expect(screen.getByLabelText(/client id/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/client secret/i)).toBeInTheDocument()
  })

  it("the org's own client: shows it with Replace and Remove, the form behind Replace", async () => {
    savedGoogleCredentials = true
    renderCard()

    expect(await screen.findByText("Configured for this workspace")).toBeInTheDocument()
    expect(screen.getByText(/\.\.\.ient-id/)).toBeInTheDocument()
    expect(screen.getByTestId("mail-google-credentials-reset")).toHaveTextContent("Remove")
    expect(screen.queryByLabelText(/client id/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mail-google-replace"))
    expect(screen.getByLabelText(/client id/i)).toBeInTheDocument()
  })

  it("no step numbering in the section headings", async () => {
    renderCard()
    expect(await screen.findByText("Google credentials")).toBeInTheDocument()
    expect(screen.queryByText(/^\d\. /)).not.toBeInTheDocument()
  })

  // A browser's password manager must never fill an OAuth client in: a saved
  // login email landed in the client id field in the field.
  it("the client id and secret inputs refuse login autofill", async () => {
    renderCard()
    const id = (await screen.findByLabelText(/client id/i)) as HTMLInputElement
    const secret = screen.getByLabelText(/client secret/i) as HTMLInputElement
    expect(id.name).toBe("google-oauth-client-id")
    expect(id.getAttribute("autocomplete")).toBe("off")
    expect(secret.name).toBe("google-oauth-client-secret")
    expect(secret.getAttribute("autocomplete")).toBe("new-password")
    for (const input of [id, secret]) {
      expect(input.hasAttribute("data-1p-ignore")).toBe(true)
      expect(input.getAttribute("data-lpignore")).toBe("true")
      expect(`${input.id} ${input.name}`).not.toMatch(/user|email|login/i)
    }
  })
})
