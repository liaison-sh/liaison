// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A staff signer's Read and sign: the tab makes this session's link, then the
// reading and signing steps run with the member's session on verify and decide.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import StaffSignTab from "./StaffSignTab"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  accessToken: () => "member-session",
}))

const TOKEN = "tok_".padEnd(43, "x")
const OPEN = {
  state: "open",
  kind: "sign",
  sender: { name: "Léa Roux", org: "Maison Alpha" },
  title: "Statement of work",
  ref: "ab12cd34",
  valid_until: "2030-01-20",
  summary: [],
  invited_email_masked: "l•••@maison.example",
  phrase: null,
  steps: ["read", "identity", "sign"],
}

let calls: Array<{ route: string; body: Record<string, unknown>; init?: RequestInit }>
let inView: Array<() => void> = []

beforeEach(() => {
  calls = []
  inView = []
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
      observe() {
        inView.push(() => this.cb([{ isIntersecting: true }]))
      }
      disconnect() {}
    },
  )
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const route = url.split("/").pop() ?? ""
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ route, body, init })
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
    if (route === "open") return json(200, OPEN)
    if (route === "document")
      return body.format === "blocks"
        ? json(200, {
            format: "blocks",
            content: [{ type: "paragraph", text: "The parties agree." }],
          })
        : json(404, { error: { code: "not_found" } })
    if (route === "code") return json(202, { sent_to: "l•••@maison.example", next_at: null })
    if (route === "verify")
      return json(200, { proof: "p".repeat(43), words: "I sign.", words_key: "k" })
    return new Response(null, { status: 204 })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(post: (path: string) => Promise<unknown>) {
  const api = { post: vi.fn(post), get: vi.fn() }
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api as never}>
        <StaffSignTab entityId="a1b2c3d4-0000-4000-8000-000000000001" />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return api
}

const header = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string> | undefined)?.[name] ?? null

describe("a staff signer's Read and sign", () => {
  it("makes this session's link, shows the document, and verifies with the member's session", async () => {
    const api = mount(async () => ({ token: TOKEN }))
    expect((await screen.findByTestId("doc-paragraph")).textContent).toBe("The parties agree.")
    expect(api.post).toHaveBeenCalledWith(
      "/client-actions/a1b2c3d4-0000-4000-8000-000000000001/my-link",
      {},
    )
    expect(calls.find((c) => c.route === "open")?.body.t).toBe(TOKEN)
    // Reading needs no member session; the signature does.
    expect(header(calls.find((c) => c.route === "open")?.init, "authorization")).toBeNull()
    fireEvent.pointerDown(screen.getByTestId("client-action-page"))
    for (const cb of inView.splice(0)) cb()
    await waitFor(() =>
      expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Léa Roux" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await waitFor(() => expect(calls.some((c) => c.route === "verify")).toBe(true))
    expect(header(calls.find((c) => c.route === "verify")?.init, "authorization")).toBe(
      "Bearer member-session",
    )
  })

  it("not their turn yet says so, and shows no document", async () => {
    mount(async () => {
      throw new ApiError("waits", 409, "not_your_turn")
    })
    expect((await screen.findByTestId("staff-sign-refused")).textContent).toBe(
      "This document waits for the signer before you. You can sign it after them.",
    )
    expect(calls).toEqual([])
  })
})
