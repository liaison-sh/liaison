// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stepped add flow (S25, prototype S-MCPADD): the probe decides the sign-in
// step, the connection is created only when the person signs in or connects,
// and what a failure leaves behind is deliberate (see McpAddFlow.tsx).
import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpAddFlow, slugFrom, suggestedName } from "~/modules/mcp-manager/McpAddFlow"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import type { McpConnection } from "~/modules/mcp-manager/types"

type Call = { method: string; url: string; body: unknown }
type Reply = { status?: number; data?: unknown; error?: { message: string; code?: string } }
type Route = [method: string, needle: string, reply: Reply | (() => Reply)]

/** A fetch stub: first matching route answers; every call is recorded. */
function serve(routes: Route[]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    const raw = init?.body
    calls.push({ method, url, body: typeof raw === "string" ? JSON.parse(raw) : undefined })
    for (const [m, needle, r] of routes) {
      if (m === method && url.includes(needle)) {
        const reply = typeof r === "function" ? r() : r
        const status = reply.status ?? 200
        const payload = reply.error ? { error: reply.error } : { data: reply.data }
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
    }
    return new Response(JSON.stringify({ error: { message: "mock miss", code: "mock_miss" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  })
  return calls
}

const CALLBACK = "https://liaison.example.org/api/apps/mcp-manager/oauth/callback"

function probeReply(over: Record<string, unknown>): Reply {
  return {
    data: {
      mode: "dcr",
      callbackUrl: CALLBACK,
      resource: "https://mcp.docs.example/mcp",
      scopes: [],
      requiresClientSecret: false,
      issuer: "https://auth.docs.example",
      ...over,
    },
  }
}

const created = (id: string): Reply => ({ data: { id, slug: "docs", displayName: "Docs" } })

const creates = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/apps/mcp-manager/connections"))
const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE")

async function enterUrl(url: string): Promise<void> {
  fireEvent.input(await screen.findByTestId("mcp-add-url"), { target: { value: url } })
  fireEvent.click(screen.getByTestId("mcp-add-check"))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("names from the server URL", () => {
  it("suggests the service's name from its host and a valid handle from it", () => {
    expect(suggestedName("https://mcp.docs.example/mcp")).toBe("Docs")
    expect(suggestedName("https://tools.resonant-audio.example/mcp")).toBe("Resonant-audio")
    expect(suggestedName("http://127.0.0.1:4000/mcp")).toBe("127.0.0.1")
    expect(slugFrom("Docs")).toBe("docs")
    expect(slugFrom("Docs", 1)).toBe("docs-2")
    expect(slugFrom("Ünïcode Wiki!")).toBe("unicode-wiki")
    expect(slugFrom("")).toBe("mcp-server")
    expect(slugFrom("x".repeat(40), 3)).toHaveLength(32)
    expect(slugFrom("x".repeat(40), 3)).toMatch(/^[a-z0-9-]{1,32}$/)
  })
})

describe("McpAddFlow", () => {
  it("automatic registration: no client fields; sign in opens the provider, the return shows the tools", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    let signedIn = false
    const done = vi.fn()
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "dcr" })],
      [
        "POST",
        "/connections/c-1/oauth/start",
        { data: { authorizationUrl: "https://auth.docs.example/authorize?x=1" } },
      ],
      [
        "POST",
        "/connections/c-1/test",
        { data: { ok: true, toolCount: 2, tools: [{ name: "search" }, { name: "create_page" }] } },
      ],
      ["PUT", "/connections/c-1/policy", { data: { ok: true } }],
      ["GET", "/connections/c-1/policy", { data: [] }],
      ["PATCH", "/connections/c-1", { data: { ok: true } }],
      [
        "GET",
        "/apps/mcp-manager/connections",
        () => ({ data: [{ id: "c-1", status: signedIn ? "connected" : "oauth_pending" }] }),
      ],
      ["POST", "/apps/mcp-manager/connections", created("c-1")],
    ])
    renderInApp(() => <McpAddFlow onDone={(c: McpConnection) => done(c.id)} />)
    expect(screen.getByTestId("mcp-add-step-1").getAttribute("aria-current")).toBe("step")
    await enterUrl("https://mcp.docs.example/mcp")

    expect(await screen.findByTestId("mcp-add-mode-dcr")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-add-step-2").getAttribute("aria-current")).toBe("step")
    expect(screen.queryByTestId("mcp-add-client-id")).toBeNull()
    expect(screen.queryByTestId("mcp-add-callback-url")).toBeNull()
    expect((screen.getByTestId("mcp-add-name") as HTMLInputElement).value).toBe("Docs")
    // The probe saved nothing.
    expect(creates(calls)).toHaveLength(0)

    fireEvent.click(screen.getByTestId("mcp-add-signin"))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://auth.docs.example/authorize?x=1",
        "_blank",
        "noopener,noreferrer",
      ),
    )
    expect(creates(calls)[0]?.body).toMatchObject({
      slug: "docs",
      displayName: "Docs",
      transport: "http",
      httpUrl: "https://mcp.docs.example/mcp",
      ownershipScope: "org",
      authFlavor: "oauth_dcr",
    })
    expect(await screen.findByTestId("mcp-add-waiting")).toBeInTheDocument()

    // "I've signed in" before the other tab finished: still waiting, nothing tested.
    fireEvent.click(screen.getByTestId("mcp-add-signed-in"))
    expect(await screen.findByTestId("mcp-add-still-waiting")).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes("/test"))).toBe(false)

    // The sign-in finishes in the other tab; coming back to this one moves on.
    signedIn = true
    window.dispatchEvent(new Event("focus"))
    expect(await screen.findByTestId("mcp-add-tools")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-add-step-3").getAttribute("aria-current")).toBe("step")
    // The tools review opens by itself once the sign-in is back.
    expect(await screen.findByTestId("mcp-tools-review")).toBeInTheDocument()
    expect(screen.getByTestId("mcp-tool-row-search")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("mcp-tool-policy-create_page-deny"))
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        toolName: "create_page",
        overrideDecision: "deny",
      }),
    )
    fireEvent.click(screen.getByTestId("mcp-tools-review-done"))
    await waitFor(() => expect(done).toHaveBeenCalledWith("c-1"))
    expect(deletes(calls)).toHaveLength(0)
  })

  it("a pre-registered client: shows the exact redirect URL to copy and asks for the client id and secret", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const calls = serve([
      [
        "POST",
        "/apps/mcp-manager/probe",
        probeReply({ mode: "preregistered", requiresClientSecret: true }),
      ],
      [
        "POST",
        "/connections/c-2/oauth/start",
        { data: { authorizationUrl: "https://auth.crm.example/oauth" } },
      ],
      ["GET", "/apps/mcp-manager/connections", { data: [] }],
      ["POST", "/apps/mcp-manager/connections", created("c-2")],
    ])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://mcp.crm.example")
    const field = (await screen.findByTestId("mcp-add-callback-url")) as HTMLInputElement
    expect(field.value).toBe(CALLBACK)
    fireEvent.click(screen.getByTestId("mcp-add-callback-url-copy"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CALLBACK))

    const signIn = screen.getByTestId("mcp-add-signin")
    expect(signIn).toBeDisabled()
    fireEvent.input(screen.getByTestId("mcp-add-client-id"), { target: { value: "client-123" } })
    expect(signIn).toBeDisabled()
    fireEvent.input(screen.getByTestId("mcp-add-client-secret"), { target: { value: "s3cret" } })
    expect(signIn).not.toBeDisabled()
    fireEvent.click(signIn)
    await screen.findByTestId("mcp-add-waiting")
    expect(creates(calls)[0]?.body).toMatchObject({
      authFlavor: "oauth_static",
      oauthClientId: "client-123",
      oauthClientSecret: "s3cret",
      httpUrl: "https://mcp.crm.example",
    })
  })

  it("without a clipboard the redirect URL is selected and the person is told to copy it", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined })
    serve([["POST", "/apps/mcp-manager/probe", probeReply({ mode: "preregistered" })]])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://mcp.crm.example")
    const field = (await screen.findByTestId("mcp-add-callback-url")) as HTMLInputElement
    fireEvent.click(screen.getByTestId("mcp-add-callback-url-copy"))
    expect(await screen.findByTestId("mcp-add-callback-url-manual")).toBeInTheDocument()
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(CALLBACK.length)
  })

  it("a probe refusal shows the server's message and saves nothing", async () => {
    const calls = serve([
      [
        "POST",
        "/apps/mcp-manager/probe",
        {
          status: 422,
          error: {
            code: "resource_mismatch",
            message:
              "The server says its address is https://mcp.crm.example. Use https://mcp.crm.example",
          },
        },
      ],
    ])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://eu1.mcp.crm.example")
    expect(await screen.findByTestId("mcp-add-error")).toHaveTextContent(
      "Use https://mcp.crm.example",
    )
    expect(screen.getByTestId("mcp-add-step-1").getAttribute("aria-current")).toBe("step")
    expect(creates(calls)).toHaveLength(0)
  })

  it("a token server: token and custom headers are saved; a failed first test deletes the connection", async () => {
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "bearer" })],
      [
        "POST",
        "/connections/c-3/test",
        { data: { ok: false, error: { message: "401 Unauthorized", code: "dial_failed" } } },
      ],
      ["DELETE", "/connections/c-3", { data: { ok: true } }],
      ["POST", "/apps/mcp-manager/connections", created("c-3")],
    ])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://tools.parts.example/mcp")
    await screen.findByTestId("mcp-add-mode-bearer")
    expect(screen.getByTestId("mcp-add-connect")).toBeDisabled()
    fireEvent.input(screen.getByTestId("mcp-add-token"), { target: { value: "tok-1" } })
    fireEvent.click(screen.getByTestId("mcp-header-add"))
    fireEvent.input(await screen.findByTestId("mcp-header-name-0"), {
      target: { value: "X-Workspace" },
    })
    fireEvent.input(screen.getByTestId("mcp-header-value-0"), { target: { value: "acme" } })
    fireEvent.click(screen.getByTestId("mcp-add-connect"))
    expect(await screen.findByTestId("mcp-add-error")).toHaveTextContent("401 Unauthorized")
    expect(creates(calls)[0]?.body).toMatchObject({
      authFlavor: "bearer",
      bearerToken: "tok-1",
      customHeaders: { "X-Workspace": "acme" },
    })
    await waitFor(() =>
      expect(deletes(calls).map((c) => c.url)).toEqual([
        expect.stringMatching(/\/connections\/c-3$/),
      ]),
    )
    // Still on the sign-in step, to fix the token and try again.
    expect(screen.getByTestId("mcp-add-step-2").getAttribute("aria-current")).toBe("step")
  })

  it("an open server connects at once; a used handle takes the next free one", async () => {
    let attempts = 0
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "none" })],
      [
        "POST",
        "/connections/c-4/test",
        { data: { ok: true, toolCount: 1, tools: [{ name: "echo" }] } },
      ],
      ["GET", "/connections/c-4/policy", { data: [] }],
      [
        "POST",
        "/apps/mcp-manager/connections",
        () =>
          attempts++ === 0
            ? { status: 409, error: { message: "slug taken", code: "slug_conflict" } }
            : created("c-4"),
      ],
    ])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://mcp.docs.example/mcp")
    await screen.findByTestId("mcp-add-mode-none")
    expect(screen.queryByTestId("mcp-add-token")).toBeNull()
    fireEvent.click(screen.getByTestId("mcp-add-connect"))
    expect(await screen.findByTestId("mcp-tool-row-echo")).toBeInTheDocument()
    expect(creates(calls).map((c) => (c.body as { slug: string }).slug)).toEqual(["docs", "docs-2"])
    expect(creates(calls)[1]?.body).not.toHaveProperty("customHeaders")
  })

  it("a sign-in that cannot start deletes the connection it had just saved", async () => {
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "dcr" })],
      [
        "POST",
        "/connections/c-5/oauth/start",
        { status: 502, error: { message: "Registration refused", code: "registration_failed" } },
      ],
      ["DELETE", "/connections/c-5", { data: { ok: true } }],
      ["POST", "/apps/mcp-manager/connections", created("c-5")],
    ])
    renderInApp(() => <McpAddFlow />)
    await enterUrl("https://mcp.docs.example/mcp")
    fireEvent.click(await screen.findByTestId("mcp-add-signin"))
    expect(await screen.findByTestId("mcp-add-error")).toHaveTextContent("Registration refused")
    await waitFor(() => expect(deletes(calls)).toHaveLength(1))
  })

  it("cancelling while the sign-in tab is open deletes the never-signed-in connection", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null)
    const cancelled = vi.fn()
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "dcr" })],
      [
        "POST",
        "/connections/c-6/oauth/start",
        { data: { authorizationUrl: "https://auth.docs.example/a" } },
      ],
      ["DELETE", "/connections/c-6", { data: { ok: true } }],
      ["GET", "/apps/mcp-manager/connections", { data: [] }],
      ["POST", "/apps/mcp-manager/connections", created("c-6")],
    ])
    renderInApp(() => <McpAddFlow onCancel={cancelled} />)
    await enterUrl("https://mcp.docs.example/mcp")
    fireEvent.click(await screen.findByTestId("mcp-add-signin"))
    await screen.findByTestId("mcp-add-waiting")
    fireEvent.click(screen.getByTestId("mcp-add-cancel"))
    await waitFor(() => expect(cancelled).toHaveBeenCalled())
    expect(deletes(calls).map((c) => c.url)).toEqual([expect.stringMatching(/\/connections\/c-6$/)])
  })

  it("after the sign-in finished, a failed first test keeps the connection and says why", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null)
    const cancelled = vi.fn()
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "dcr" })],
      [
        "POST",
        "/connections/c-7/oauth/start",
        { data: { authorizationUrl: "https://auth.docs.example/a" } },
      ],
      [
        "POST",
        "/connections/c-7/test",
        { data: { ok: false, error: { message: "Sign in again", code: "needs_reauth" } } },
      ],
      ["GET", "/apps/mcp-manager/connections", { data: [{ id: "c-7", status: "needs_reauth" }] }],
      ["POST", "/apps/mcp-manager/connections", created("c-7")],
    ])
    renderInApp(() => <McpAddFlow onCancel={cancelled} />)
    await enterUrl("https://mcp.docs.example/mcp")
    fireEvent.click(await screen.findByTestId("mcp-add-signin"))
    await screen.findByTestId("mcp-add-waiting")
    fireEvent.click(screen.getByTestId("mcp-add-signed-in"))
    expect(await screen.findByTestId("mcp-add-error")).toHaveTextContent("Sign in again")
    fireEvent.click(screen.getByTestId("mcp-add-cancel"))
    await waitFor(() => expect(cancelled).toHaveBeenCalled())
    expect(deletes(calls)).toHaveLength(0)
  })

  it("personal: the connection is the caller's own", async () => {
    const calls = serve([
      ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "none" })],
      ["POST", "/connections/c-8/test", { data: { ok: true, toolCount: 0, tools: [] } }],
      ["GET", "/connections/c-8/policy", { data: [] }],
      ["POST", "/apps/mcp-manager/connections", created("c-8")],
    ])
    renderInApp(() => <McpAddFlow ownership="personal" />)
    expect(screen.getByTestId("mcp-personal-hint")).toBeInTheDocument()
    await enterUrl("https://mcp.docs.example/mcp")
    fireEvent.click(await screen.findByTestId("mcp-add-connect"))
    await screen.findByTestId("mcp-add-tools")
    expect(creates(calls)[0]?.body).toMatchObject({ ownershipScope: "personal" })
  })

  describe("the tools review dialog", () => {
    const connectAndReview = async () => {
      const done = vi.fn()
      const calls = serve([
        ["POST", "/apps/mcp-manager/probe", probeReply({ mode: "none" })],
        [
          "POST",
          "/connections/c-9/test",
          {
            data: {
              ok: true,
              toolCount: 2,
              // As the API sends them: what each connection default gives the tool.
              tools: [
                {
                  name: "search",
                  readOnly: true,
                  defaultDecisions: { auto: "auto", gate_writes: "auto", gate_all: "gate" },
                },
                {
                  name: "create_page",
                  readOnly: false,
                  defaultDecisions: { auto: "auto", gate_writes: "gate", gate_all: "gate" },
                },
              ],
            },
          },
        ],
        ["GET", "/connections/c-9/policy", { data: [] }],
        ["PATCH", "/connections/c-9", { data: { ok: true } }],
        ["POST", "/apps/mcp-manager/connections", created("c-9")],
      ])
      renderInApp(() => <McpAddFlow onDone={(c: McpConnection) => done(c.id)} />)
      await enterUrl("https://mcp.docs.example/mcp")
      fireEvent.click(await screen.findByTestId("mcp-add-connect"))
      const dialog = await screen.findByTestId("mcp-tools-review")
      return { done, calls, dialog }
    }
    const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH")

    it("opens after connect with the server's name, its tool count and gate_writes preselected", async () => {
      const { dialog } = await connectAndReview()
      expect(dialog).toHaveTextContent("Docs")
      expect(screen.getByTestId("mcp-tools-review-count")).toHaveTextContent("2")
      expect(
        (screen.getByTestId("mcp-review-policy-gate_writes") as HTMLInputElement).checked,
      ).toBe(true)
      expect(screen.getByTestId("mcp-tool-kind-search").dataset.kind).toBe("read")
    })

    const effective = (tool: string) => {
      const el = screen.getByTestId(`mcp-tool-effective-${tool}`)
      return [el.dataset.decision, el.dataset.source, el.textContent]
    }
    const pressed = (tool: string, decision: string) =>
      screen.getByTestId(`mcp-tool-policy-${tool}-${decision}`).getAttribute("aria-pressed")

    it("gate_writes and no overrides: reads show Allowed (default), writes Needs approval (default)", async () => {
      await connectAndReview()
      await waitFor(() =>
        expect(effective("search")).toEqual(["auto", "default", "Allowed · default"]),
      )
      expect(effective("create_page")).toEqual(["gate", "default", "Needs approval · default"])
      expect(pressed("search", "auto")).toBe("true")
      expect(pressed("create_page", "gate")).toBe("true")
      expect(screen.getByTestId("mcp-tool-policy-search-auto").dataset.source).toBe("default")
      // Nothing is overridden, so there is nothing to reset.
      expect(screen.queryByTestId("mcp-tool-reset-search")).toBeNull()
      expect(screen.queryByTestId("mcp-tools-bulk")).toBeNull()
    })

    it('switching to "Every call needs approval" updates every row live, before Done', async () => {
      const { calls } = await connectAndReview()
      await waitFor(() => expect(effective("search")[0]).toBe("auto"))
      fireEvent.click(screen.getByTestId("mcp-review-policy-gate_all"))
      await waitFor(() =>
        expect(effective("search")).toEqual(["gate", "default", "Needs approval · default"]),
      )
      expect(effective("create_page")).toEqual(["gate", "default", "Needs approval · default"])
      expect(pressed("search", "gate")).toBe("true")
      fireEvent.click(screen.getByTestId("mcp-review-policy-auto"))
      await waitFor(() =>
        expect(effective("create_page")).toEqual(["auto", "default", "Allowed · default"]),
      )
      // The choice is only shown: nothing is written until Done, and no per-tool overrides.
      expect(calls.filter((c) => c.method === "PATCH" || c.method === "PUT")).toHaveLength(0)
    })

    it("picking the decision a tool already gets from the default writes no override", async () => {
      const { calls } = await connectAndReview()
      await waitFor(() => expect(pressed("search", "auto")).toBe("true"))
      fireEvent.click(screen.getByTestId("mcp-tool-policy-search-auto"))
      fireEvent.click(screen.getByTestId("mcp-tool-policy-create_page-gate"))
      await new Promise((r) => setTimeout(r, 50))
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0)
      expect(pressed("search", "auto")).toBe("true")
    })

    it('Done with "Every call needs approval" saves gate_all', async () => {
      const { done, calls } = await connectAndReview()
      fireEvent.click(screen.getByTestId("mcp-review-policy-gate_all"))
      fireEvent.click(screen.getByTestId("mcp-tools-review-done"))
      await waitFor(() => expect(done).toHaveBeenCalledWith("c-9"))
      expect(patches(calls).map((c) => c.body)).toEqual([
        { connectionDefaultPolicy: "gate_all", toolsReviewed: true },
      ])
    })

    it("Escape keeps the default: no policy is written, the review is marked done", async () => {
      const { done, calls, dialog } = await connectAndReview()
      fireEvent.click(screen.getByTestId("mcp-review-policy-auto"))
      fireEvent.keyDown(dialog, { key: "Escape" })
      await waitFor(() => expect(done).toHaveBeenCalledWith("c-9"))
      await waitFor(() => expect(patches(calls)).toHaveLength(1))
      expect(patches(calls)[0]?.body).toEqual({ toolsReviewed: true })
      await waitFor(() => expect(screen.queryByTestId("mcp-tools-review")).toBeNull())
    })
  })
})
