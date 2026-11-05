// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import type { AppConnectionConfig } from "./apps-store"
import { ConnectAppDialog } from "./ConnectAppDialog"

/** Minimal unsigned JWT the auth store can decode, carrying `scopes`. */
function makeAccessToken(scopes: string[]): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  return `${b64({ alg: "none" })}.${b64({
    userId: "u-1",
    orgId: "o-1",
    name: "Admin",
    roles: [],
    scopes,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`
}

const credsConfig: AppConnectionConfig = {
  name: "gitlab",
  type: "credentials",
  credentialFields: [
    { name: "token", label: "Access token", type: "password", required: true },
    { name: "group", label: "Group path", type: "text" },
  ],
  setupGuide: { summary: "How to connect", steps: ["one"], docsUrl: "https://docs.test" },
}

const oauthConfig: AppConnectionConfig = {
  name: "gmail",
  type: "oauth2",
  setupGuide: { summary: "Click connect", docsUrl: "https://docs.test/oauth" },
}

const shopifyConfig: AppConnectionConfig = {
  name: "shop",
  type: "oauth2",
  templateVars: ["shop"],
}

// The OAuth dialog reads client status via api.get and sets the client via
// api.put; credentials/authorize go via api.post. Defaults: client not yet
// configured. Override per test.
function mockApi(
  post: ReturnType<typeof vi.fn>,
  extra?: { get?: ReturnType<typeof vi.fn>; put?: ReturnType<typeof vi.fn> },
): ApiClient {
  return {
    post,
    get: extra?.get ?? vi.fn().mockResolvedValue({ configured: false }),
    put: extra?.put ?? vi.fn().mockResolvedValue({ configured: true, created: true }),
  } as unknown as ApiClient
}

describe("ConnectAppDialog", () => {
  let hrefSet: string | undefined

  beforeEach(() => {
    hrefSet = undefined
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get href() {
          return hrefSet ?? ""
        },
        set href(v: string) {
          hrefSet = v
        },
      },
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it("renders one input per credentialField with the right input type", () => {
    render(() => (
      <ConnectAppDialog
        api={mockApi(vi.fn())}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
      />
    ))
    const token = screen.getByTestId("connect-field-token") as HTMLInputElement
    const group = screen.getByTestId("connect-field-group") as HTMLInputElement
    expect(token.type).toBe("password")
    expect(group.type).toBe("text")
  })

  it("submits the exact credentials payload with matching field keys", async () => {
    const post = vi.fn().mockResolvedValue({ id: "acc-1" })
    const onSuccess = vi.fn()
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
        onSuccess={onSuccess}
      />
    ))
    fireEvent.input(screen.getByTestId("connect-field-token"), {
      target: { value: "glpat-abc" },
    })
    fireEvent.input(screen.getByTestId("connect-field-group"), {
      target: { value: "my-group" },
    })
    fireEvent.click(screen.getByTestId("connect-submit"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post).toHaveBeenCalledTimes(1)
    const [path, body] = post.mock.calls[0]
    expect(path).toBe("/connections/gitlab/gitlab/credentials")
    expect(body).toMatchObject({
      mode: "personal",
      credentials: { token: "glpat-abc", group: "my-group" },
    })
    expect(onSuccess).toHaveBeenCalled()
  })

  // The admin default used to be captured into a signal at MOUNT. A dialog that
  // opens before the session is restored (deep link, hard refresh) then froze
  // "not admin" and silently posted mode:"personal" -- an admin believing they
  // configured the ORG connection got a personal one, and background jobs kept
  // using the old org credential (prod GitLab, 2026-08-02). The default is now
  // derived at submit time.
  it("uses the org default once the session resolves after the dialog mounted", async () => {
    clearAuth() // mount with NO session — the race this regressed on
    const post = vi.fn().mockResolvedValue({ id: "acc-1" })
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
      />
    ))
    // Session arrives AFTER mount, carrying the org-connect admin scope.
    setTokens(makeAccessToken(["gitlab:accounts:admin"]))
    fireEvent.input(screen.getByTestId("connect-field-token"), { target: { value: "glpat-late" } })
    fireEvent.input(screen.getByTestId("connect-field-group"), { target: { value: "fabrikam" } })
    fireEvent.click(screen.getByTestId("connect-submit"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post.mock.calls[0]?.[1]).toMatchObject({ mode: "org" })
  })

  it("an explicit Personal click still wins over the admin default", async () => {
    clearAuth()
    setTokens(makeAccessToken(["gitlab:accounts:admin"]))
    const post = vi.fn().mockResolvedValue({ id: "acc-1" })
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("connect-mode-personal"))
    fireEvent.input(screen.getByTestId("connect-field-token"), { target: { value: "glpat-x" } })
    fireEvent.input(screen.getByTestId("connect-field-group"), { target: { value: "fabrikam" } })
    fireEvent.click(screen.getByTestId("connect-submit"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post.mock.calls[0]?.[1]).toMatchObject({ mode: "personal" })
  })

  it("oauth2: sets the entered client, then authorizes and redirects", async () => {
    const post = vi.fn().mockResolvedValue({ redirectUrl: "https://provider.test/authorize?x=1" })
    const put = vi.fn().mockResolvedValue({ configured: true, created: true })
    // The host answers its caller just before the page leaves for the provider.
    let hrefWhenRedirectAnnounced: string | undefined = "not called"
    render(() => (
      <ConnectAppDialog
        api={mockApi(post, { put })}
        appName="gmail"
        connectionName="gmail"
        connConfig={oauthConfig}
        onClose={() => {}}
        onRedirect={() => {
          hrefWhenRedirectAnnounced = hrefSet
        }}
      />
    ))
    fireEvent.input(screen.getByTestId("oauth-client-id"), { target: { value: "cid" } })
    fireEvent.input(screen.getByTestId("oauth-client-secret"), { target: { value: "csecret" } })
    fireEvent.click(screen.getByTestId("connect-oauth"))
    await vi.waitFor(() => expect(hrefSet).toBe("https://provider.test/authorize?x=1"))
    // The client was provisioned first (via api.put), then the flow authorized.
    expect(put).toHaveBeenCalledWith("/connections/gmail/gmail/oauth-client", {
      clientId: "cid",
      clientSecret: "csecret",
    })
    expect(post.mock.calls[0][0]).toBe("/connections/gmail/gmail/authorize")
    expect(hrefSet).toBe("https://provider.test/authorize?x=1")
    expect(hrefWhenRedirectAnnounced).toBeUndefined()
  })

  it("oauth2: errors (no authorize) when no client is configured and none entered", async () => {
    const post = vi.fn()
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gmail"
        connectionName="gmail"
        connConfig={oauthConfig}
        onClose={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("connect-oauth"))
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByTestId("connect-error").textContent).toMatch(/client id|client secret/i)
  })

  it("oauth2: renders template-var inputs (shop) and includes them in the authorize body", async () => {
    const post = vi.fn().mockResolvedValue({ redirectUrl: "https://x/authorize" })
    // Client already configured -> no client fields required, connect directly.
    const get = vi.fn().mockResolvedValue({ configured: true, clientId: "cid" })
    render(() => (
      <ConnectAppDialog
        api={mockApi(post, { get })}
        appName="shopify"
        connectionName="shop"
        connConfig={shopifyConfig}
        onClose={() => {}}
      />
    ))
    // Wait for the client-status load to mark it configured.
    await screen.findByTestId("oauth-client-configured")
    fireEvent.input(screen.getByTestId("oauth-var-shop"), { target: { value: "my-store" } })
    fireEvent.click(screen.getByTestId("connect-oauth"))
    await Promise.resolve()
    await Promise.resolve()
    const [path, body] = post.mock.calls[0]
    expect(path).toBe("/connections/shopify/shop/authorize")
    expect(body).toMatchObject({ shop: "my-store" })
  })

  // An app that resolves its own client (the org's shared Google client, else
  // the deployment's): a client typed here would be ignored at sign-in, so the
  // dialog never asks for one.
  describe("oauth2 with a client the app resolves itself", () => {
    const renderWith = (status: Record<string, unknown>, post = vi.fn()) => {
      const put = vi.fn()
      render(() => (
        <ConnectAppDialog
          api={mockApi(post, { get: vi.fn().mockResolvedValue(status), put })}
          appName="tickets"
          connectionName="gmail"
          connConfig={oauthConfig}
          onClose={() => {}}
        />
      ))
      return { post, put }
    }

    it.each([
      ["the deployment", "deployment"],
      ["the org's setting", "org"],
    ])(
      "a client from %s: no client fields, Connect signs in without setting one",
      async (_label, source) => {
        const post = vi.fn().mockResolvedValue({ redirectUrl: "https://provider.test/authorize" })
        const { put } = renderWith(
          { configured: true, source, clientIdHint: "...-deploy", appManaged: true },
          post,
        )
        expect(await screen.findByTestId("oauth-client-app-managed")).toHaveTextContent(
          "...-deploy",
        )
        expect(screen.queryByTestId("oauth-client-id")).not.toBeInTheDocument()
        expect(screen.queryByTestId("oauth-client-secret")).not.toBeInTheDocument()
        fireEvent.click(screen.getByTestId("connect-oauth"))
        await vi.waitFor(() => expect(hrefSet).toBe("https://provider.test/authorize"))
        expect(put).not.toHaveBeenCalled()
        expect(post.mock.calls[0]?.[0]).toBe("/connections/tickets/gmail/authorize")
      },
    )

    it("a refusal shows its reason, no client fields, and Connect is disabled", async () => {
      renderWith({
        configured: false,
        reason: "Gmail is not enabled for this org",
        appManaged: true,
      })
      expect(await screen.findByTestId("oauth-client-unavailable")).toHaveTextContent(
        "Gmail is not enabled for this org",
      )
      expect(screen.queryByTestId("oauth-client-id")).not.toBeInTheDocument()
      expect(screen.getByTestId("connect-oauth")).toBeDisabled()
    })
  })

  // A browser's password manager must never fill a credential in.
  describe("credential inputs refuse login autofill", () => {
    const expectNoAutofill = (input: HTMLInputElement, name: string, autocomplete: string) => {
      expect(input.name).toBe(name)
      expect(input.getAttribute("autocomplete")).toBe(autocomplete)
      expect(input.hasAttribute("data-1p-ignore")).toBe(true)
      expect(input.getAttribute("data-lpignore")).toBe("true")
      expect(`${input.id} ${input.name}`).not.toMatch(/user|email|login/i)
    }

    it("on the OAuth client fields", async () => {
      render(() => (
        <ConnectAppDialog
          api={mockApi(vi.fn())}
          appName="gmail"
          connectionName="gmail"
          connConfig={oauthConfig}
          onClose={() => {}}
        />
      ))
      expectNoAutofill(
        screen.getByTestId("oauth-client-id") as HTMLInputElement,
        "oauth-client-id",
        "off",
      )
      expectNoAutofill(
        screen.getByTestId("oauth-client-secret") as HTMLInputElement,
        "oauth-client-secret",
        "new-password",
      )
    })

    it("on every declared credential field, a password one as a new password", () => {
      render(() => (
        <ConnectAppDialog
          api={mockApi(vi.fn())}
          appName="gitlab"
          connectionName="gitlab"
          connConfig={credsConfig}
          onClose={() => {}}
        />
      ))
      expectNoAutofill(
        screen.getByTestId("connect-field-token") as HTMLInputElement,
        "connection-token",
        "new-password",
      )
      expectNoAutofill(
        screen.getByTestId("connect-field-group") as HTMLInputElement,
        "connection-group",
        "off",
      )
    })

    it("on the optional display name, a plain text field", () => {
      render(() => (
        <ConnectAppDialog
          api={mockApi(vi.fn())}
          appName="gitlab"
          connectionName="gitlab"
          connConfig={credsConfig}
          onClose={() => {}}
        />
      ))
      const input = screen.getByTestId("connect-display-name") as HTMLInputElement
      expect(input.type).toBe("text")
      expectNoAutofill(input, "connection-display-name", "off")
    })

    it("on the OAuth template vars", async () => {
      render(() => (
        <ConnectAppDialog
          api={mockApi(vi.fn())}
          appName="shop"
          connectionName="shop"
          connConfig={shopifyConfig}
          onClose={() => {}}
        />
      ))
      expectNoAutofill(
        (await screen.findByTestId("oauth-var-shop")) as HTMLInputElement,
        "oauth-var-shop",
        "off",
      )
    })
  })

  it("shows an error and does not submit when a required field is empty", async () => {
    const post = vi.fn()
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
      />
    ))
    // Leave the required `token` empty; fill only the optional `group`.
    fireEvent.input(screen.getByTestId("connect-field-group"), {
      target: { value: "my-group" },
    })
    fireEvent.click(screen.getByTestId("connect-submit"))
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByTestId("connect-error").textContent).toMatch(/access token|required/i)
  })

  it("surfaces a server error inline", async () => {
    const post = vi.fn().mockRejectedValue(new Error("Connection refused by provider"))
    render(() => (
      <ConnectAppDialog
        api={mockApi(post)}
        appName="gitlab"
        connectionName="gitlab"
        connConfig={credsConfig}
        onClose={() => {}}
      />
    ))
    fireEvent.input(screen.getByTestId("connect-field-token"), {
      target: { value: "glpat-abc" },
    })
    fireEvent.input(screen.getByTestId("connect-field-group"), {
      target: { value: "my-group" },
    })
    fireEvent.click(screen.getByTestId("connect-submit"))
    await Promise.resolve()
    await Promise.resolve()
    expect(await screen.findByTestId("connect-error")).toHaveTextContent(
      /Connection refused by provider/,
    )
  })
})
