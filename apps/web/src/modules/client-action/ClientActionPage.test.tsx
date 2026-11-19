// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The token page, step by step, against a stub of the public client action
// routes: what it posts (the token in the body only), what it shows, and that
// nothing moves forward before the document was shown and read to its end.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ClientActionPage, { COPY_REFRESH_MS } from "~/modules/client-action/ClientActionPage"
import { I18nProvider } from "~/modules/i18n/i18n-context"

const TOKEN = "tok_".padEnd(43, "x")

type Reply = { status: number; body?: unknown; blob?: boolean }
type Route = (body: Record<string, unknown>) => Reply

const OPEN = {
  state: "open",
  kind: "sign",
  sender: { name: "Léa Roux", org: "Maison Alpha" },
  title: "Statement of work",
  ref: "ab12cd34",
  valid_until: "2030-01-20",
  summary: [{ k: "Price", v: "38,000 EUR" }],
  invited_email_masked: "j•••@client.example",
  phrase: null,
  steps: ["read", "identity", "sign"],
}

let calls: Array<{ route: string; body: Record<string, unknown>; url: string; init?: RequestInit }>
let routes: Record<string, Route>
let ioCallbacks: Array<() => void>

function serve(over: Partial<Record<string, Route>> = {}) {
  routes = {
    open: () => ({ status: 200, body: OPEN }),
    seen: () => ({ status: 204 }),
    document: (b) =>
      b.format === "blocks"
        ? {
            status: 200,
            body: {
              format: "blocks",
              content: [
                { type: "heading", text: "Scope", level: 1 },
                { type: "paragraph", text: "The parties agree." },
              ],
            },
          }
        : { status: 404, body: { error: { code: "not_found" } } },
    code: () => ({ status: 202, body: { sent_to: "j•••@client.example", next_at: null } }),
    verify: () => ({
      status: 200,
      body: {
        proof: "p".repeat(43),
        words: "I sign it with a simple electronic signature.",
        words_key: "k",
      },
    }),
    decide: (b) => ({
      status: 200,
      body: {
        state: b.decision === "decline" ? "declined" : "signed",
        copy_to: "j•••@client.example",
      },
    }),
    request: () => ({ status: 202, body: { accepted: true } }),
    ...over,
  } as Record<string, Route>
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const route = url.split("/").pop() ?? ""
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ route, body, url, init })
    const r = (routes[route] ?? (() => ({ status: 404 })))(body)
    if (r.blob)
      return new Response(new Blob(["x"], { type: "image/webp" }), {
        status: 200,
        headers: { "content-type": "image/webp" },
      })
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    })
  })
}

class FakeObserver {
  constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
  observe() {
    ioCallbacks.push(() => this.cb([{ isIntersecting: true }]))
  }
  disconnect() {}
}

/** Brings every observed element into view, as scrolling to the end would. */
function scrollAll() {
  for (const cb of ioCallbacks.splice(0)) cb()
}

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/a${hash}`)
  render(() => (
    <I18nProvider initialLocale="en">
      <ClientActionPage />
    </I18nProvider>
  ))
}

beforeEach(() => {
  calls = []
  ioCallbacks = []
  window.sessionStorage.clear()
  vi.stubGlobal("IntersectionObserver", FakeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const of = (route: string) => calls.filter((c) => c.route === route)

async function readToEnd() {
  await screen.findByTestId("doc-view")
  fireEvent.pointerDown(screen.getByTestId("client-action-page"))
  scrollAll()
  await waitFor(() =>
    expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(false),
  )
}

async function toConfirm() {
  await readToEnd()
  fireEvent.click(screen.getByTestId("read-continue"))
  await screen.findByTestId("step-identity-panel")
  fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
  fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean Tessier" } })
  fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
  fireEvent.click(screen.getByTestId("identity-continue"))
  await screen.findByTestId("step-confirm-panel")
}

describe("the token page", () => {
  it("takes the token from the fragment, cleans the address, and posts it only in bodies", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("client-action-title")
    expect(window.location.hash).toBe("")
    expect(window.location.href).not.toContain(TOKEN)
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN)
      expect(c.url).toMatch(/\/api\/public\/client-actions\/[a-z]+$/)
      expect(c.init?.method).toBe("POST")
      expect(c.init?.credentials).toBe("omit")
      expect(c.body.t).toBe(TOKEN)
    }
  })

  it("keeps the token for a reload of this tab only", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("client-action-title")
    cleanup()
    calls = []
    renderAt("")
    await screen.findByTestId("client-action-title")
    expect(of("open")[0]?.body.t).toBe(TOKEN)
  })

  it("read: says who asks, the level in plain words, and keeps Continue off until the end is in view", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-view")
    expect(screen.getByTestId("client-action-ask").textContent).toContain(
      "Léa Roux at Maison Alpha",
    )
    expect(screen.getByTestId("level-sentence").textContent).toContain(
      "Simple electronic signature",
    )
    expect(screen.getByTestId("doc-paragraph").textContent).toBe("The parties agree.")
    expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(true)
    expect(of("seen")).toHaveLength(0)
    scrollAll()
    await waitFor(() =>
      expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(false),
    )
    // No gesture yet: nothing marks the link opened or read.
    expect(of("seen")).toHaveLength(0)
    fireEvent.pointerDown(screen.getByTestId("client-action-page"))
    await waitFor(() => expect(of("seen")).toHaveLength(2))
    expect(of("seen")[1]?.body).toEqual({ t: TOKEN, reached_end: true })
  })

  it("identity: asks for the code on Continue, and sends name, capacity and the page language", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    expect(of("code")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    await waitFor(() => expect(of("code")).toHaveLength(1))
    expect(screen.getByTestId("identity-sent").textContent).toContain("j•••@client.example")
    expect((screen.getByTestId("identity-continue") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean Tessier" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await screen.findByTestId("step-confirm-panel")
    expect(of("verify")[0]?.body).toEqual({
      t: TOKEN,
      code: "123456",
      name: "Jean Tessier",
      capacity: "Director",
      lang: "en",
    })
  })

  it("identity: on a demo box the code step says plainly that no code mail is sent there, and stays on the step", async () => {
    serve({ code: () => ({ status: 403, body: { error: { code: "NO_MAIL_ON_DEMO" } } }) })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    expect((await screen.findByTestId("client-action-note")).textContent).toContain(
      "This is a demo: no code mail is sent here",
    )
    expect(screen.getByTestId("step-identity-panel")).toBeTruthy()
  })

  it("identity: a wrong code says how many tries are left and stays on the step", async () => {
    serve({ verify: () => ({ status: 401, body: { error: { code: "wrong_code", left: 3 } } }) })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "000000" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    expect((await screen.findByTestId("client-action-note")).textContent).toContain("3")
    expect(screen.getByTestId("step-identity-panel")).toBeTruthy()
  })

  it("identity: a name the signature page cannot draw asks for Latin letters and stays on the step", async () => {
    serve({ verify: () => ({ status: 400, body: { error: { code: "name_not_drawable" } } }) })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "\u{1F600}" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await waitFor(() =>
      expect(screen.getByTestId("client-action-note").textContent).toBe(
        "Your name holds characters the signature page cannot show. Please type it in Latin letters.",
      ),
    )
    expect(screen.getByTestId("step-identity-panel")).toBeTruthy()
  })

  it("identity: a pause after wrong codes shows the attempts frame", async () => {
    serve({
      verify: () => ({ status: 423, body: { error: { code: "paused", retry_at: "2030-01-01" } } }),
    })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "000000" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Director" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await screen.findByTestId("token-frame-attempts")
  })

  it("sign: shows the server's consent words, and Sign stays off until the typed name matches", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await toConfirm()
    expect(screen.getByTestId("consent-words").textContent).toBe(
      "I sign it with a simple electronic signature.",
    )
    const sign = screen.getByTestId("sign-confirm") as HTMLButtonElement
    expect((screen.getByTestId("sign-name") as HTMLInputElement).value).toBe("")
    expect(sign.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Jean Tesier" } })
    expect(sign.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: " jean  TESSIER " } })
    expect(sign.disabled).toBe(false)
    fireEvent.click(sign)
    await screen.findByTestId("step-done-panel")
    expect(of("decide")[0]?.body).toEqual({
      t: TOKEN,
      proof: "p".repeat(43),
      decision: "sign",
      typed_name: "jean  TESSIER",
    })
    expect(screen.getByTestId("done-copy").textContent).toContain("j•••@client.example")
  })

  /** The first open shows the document; once signed, the link answers its signed frame. */
  function signedAfter(copies: string[]) {
    let n = 0
    return () => {
      n += 1
      if (n === 1) return { status: 200, body: OPEN }
      const copy = copies[Math.min(n - 2, copies.length - 1)]
      return {
        status: 200,
        body: {
          state: "signed",
          sender: OPEN.sender,
          next: "copy",
          copy,
          copy_to: "j•••@client.example",
        },
      }
    }
  }

  async function signIt() {
    await toConfirm()
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Jean Tessier" } })
    fireEvent.click(screen.getByTestId("sign-confirm"))
    await screen.findByTestId("step-done-panel")
  }

  it("sign: the done page says where the copy stands, from the signed link's own answer", async () => {
    serve({ open: signedAfter(["sent"]) })
    renderAt(`#t=${TOKEN}`)
    await signIt()
    await waitFor(() =>
      expect(screen.getByTestId("done-copy").textContent).toBe(
        "The signed PDF and its proof of signature were sent to j•••@client.example. Keep that email: it is your own proof, separate from Maison Alpha's systems.",
      ),
    )
    expect(of("open").map((c) => c.body)).toEqual([{ t: TOKEN }, { t: TOKEN }])
  })

  it("sign: while other signers are awaited the done page says so, and asks again until the copy settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] })
    try {
      serve({ open: signedAfter(["waiting_for_others", "on_its_way", "not_sent"]) })
      renderAt(`#t=${TOKEN}`)
      await signIt()
      await waitFor(() =>
        expect(screen.getByTestId("done-copy").textContent).toMatch(
          /^Your copy waits for the other signers\./,
        ),
      )
      await vi.advanceTimersByTimeAsync(COPY_REFRESH_MS)
      await waitFor(() =>
        expect(screen.getByTestId("done-copy").textContent).toMatch(/^Everyone has signed\./),
      )
      await vi.advanceTimersByTimeAsync(COPY_REFRESH_MS)
      await waitFor(() =>
        expect(screen.getByTestId("done-copy").textContent).toBe(
          "Your copy could not be sent to j•••@client.example. Maison Alpha has been told.",
        ),
      )
      await vi.advanceTimersByTimeAsync(COPY_REFRESH_MS * 3)
      expect(of("open")).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("sign: the done page says where the copy stands in French too", async () => {
    serve({ open: signedAfter(["on_its_way"]) })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("client-action-lang-fr"))
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean Tessier" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Directeur" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await screen.findByTestId("step-confirm-panel")
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Jean Tessier" } })
    fireEvent.click(screen.getByTestId("sign-confirm"))
    await screen.findByTestId("step-done-panel")
    await waitFor(() =>
      expect(screen.getByTestId("done-copy").textContent).toBe(
        "Tout le monde a signé. Le PDF signé et sa preuve de signature sont en route vers j•••@client.example. Gardez cet e-mail : c'est votre propre preuve, distincte des systèmes de Maison Alpha.",
      ),
    )
  })

  it("sign: asks for the sender's words when the open answer names them", async () => {
    serve({ open: () => ({ status: 200, body: { ...OPEN, phrase: "Lu et approuvé" } }) })
    renderAt(`#t=${TOKEN}`)
    await toConfirm()
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Jean Tessier" } })
    const sign = screen.getByTestId("sign-confirm") as HTMLButtonElement
    expect(sign.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("sign-phrase"), { target: { value: "lu et approuve" } })
    expect(sign.disabled).toBe(false)
    fireEvent.click(sign)
    await screen.findByTestId("step-done-panel")
    expect(of("decide")[0]?.body.typed_phrase).toBe("lu et approuve")
  })

  it("sign: a proof that ended sends the person back to the code step", async () => {
    serve({ decide: () => ({ status: 401, body: { error: { code: "bad_proof" } } }) })
    renderAt(`#t=${TOKEN}`)
    await toConfirm()
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Jean Tessier" } })
    fireEvent.click(screen.getByTestId("sign-confirm"))
    await screen.findByTestId("step-identity-panel")
    expect(screen.getByTestId("client-action-note")).toBeTruthy()
  })

  it("decline: posts no proof, the reason if given, and closes", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-view")
    fireEvent.click(screen.getByTestId("to-decline"))
    await screen.findByTestId("step-decline-panel")
    fireEvent.input(screen.getByTestId("decline-reason"), { target: { value: "Not now" } })
    fireEvent.click(screen.getByTestId("decline-confirm"))
    await screen.findByTestId("step-declined-panel")
    expect(of("decide")[0]?.body).toEqual({ t: TOKEN, decision: "decline", reason: "Not now" })
  })

  it("decline: Go back returns to the step it came from", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-view")
    fireEvent.click(screen.getByTestId("to-decline"))
    fireEvent.click(await screen.findByTestId("decline-back"))
    await screen.findByTestId("step-read-panel")
  })

  it("accept: the steps say review and accept, never sign, and there is no level sentence", async () => {
    serve({
      open: () => ({
        status: 200,
        body: { ...OPEN, kind: "accept", steps: ["review", "identity", "accept"] },
      }),
      decide: (b) => ({
        status: 200,
        body: { state: b.decision === "decline" ? "declined" : "accepted", copy_to: "j" },
      }),
      verify: () => ({
        status: 200,
        body: { proof: "p".repeat(43), words: "I accept it.", words_key: "k" },
      }),
    })
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    expect(screen.queryByTestId("level-sentence")).toBeNull()
    expect(screen.getByTestId("step-read").textContent).toBe("1. Review")
    expect(screen.getByTestId("step-confirm").textContent).toBe("3. Accept")
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    expect(screen.queryByTestId("identity-capacity")).toBeNull()
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Ana" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await screen.findByTestId("step-confirm-panel")
    expect(screen.getByTestId("step-confirm-panel").textContent).not.toMatch(/signs? /i)
    fireEvent.input(screen.getByTestId("sign-name"), { target: { value: "Ana" } })
    fireEvent.click(screen.getByTestId("sign-confirm"))
    await screen.findByTestId("step-done-panel")
    expect(of("decide")[0]?.body.decision).toBe("accept")
  })

  it("an uploaded file is read as page pictures, with a text switch, and ends on the last picture", async () => {
    serve({
      document: (b) =>
        b.format === "blocks"
          ? { status: 404, body: { error: { code: "not_found" } } }
          : b.format === "pages"
            ? {
                status: 200,
                body: {
                  format: "pages",
                  content: [
                    { n: 1, sha256: "a", text: "First page" },
                    { n: 2, sha256: "b", text: "Second page" },
                  ],
                },
              }
            : { status: 200, blob: true },
    })
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    )
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-page-2")
    scrollAll()
    await waitFor(() =>
      expect(of("document").filter((c) => c.body.format === "page")).toHaveLength(2),
    )
    expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(true)
    const pics = await screen.findAllByRole("img")
    for (const img of pics) fireEvent.load(img)
    await waitFor(() =>
      expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("doc-text-switch"))
    expect(screen.getByTestId("doc-text").textContent).toContain("Second page")
  })

  it("a scanned file with no text offers no text switch", async () => {
    serve({
      document: (b) =>
        b.format === "pages"
          ? { status: 200, body: { format: "pages", content: [{ n: 1, sha256: "a", text: null }] } }
          : { status: 404, body: { error: { code: "not_found" } } },
    })
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-page-1")
    expect(screen.queryByTestId("doc-text-switch")).toBeNull()
  })

  it("a document with nothing to read says so and never lets the person continue", async () => {
    for (const content of [
      { format: "blocks", content: [] },
      { format: "blocks", content: [{ type: "paragraph", text: " " }] },
      { format: "pages", content: [] },
    ]) {
      serve({
        document: (b) =>
          b.format === content.format
            ? { status: 200, body: content }
            : { status: 404, body: { error: { code: "not_found" } } },
      })
      renderAt(`#t=${TOKEN}`)
      expect((await screen.findByTestId("doc-empty")).textContent).toBe(
        "This document has nothing to read, so it cannot be signed or accepted here. Ask the sender for a new link.",
      )
      expect(screen.queryByTestId("doc-end")).toBeNull()
      fireEvent.pointerDown(screen.getByTestId("client-action-page"))
      scrollAll()
      await new Promise((r) => setTimeout(r, 20))
      expect((screen.getByTestId("read-continue") as HTMLButtonElement).disabled).toBe(true)
      expect(of("seen").some((c) => c.body.reached_end === true)).toBe(false)
      cleanup()
      calls = []
      ioCallbacks = []
    }
  })

  it("no fragment: the not-found frame, with no sender and no call", async () => {
    serve()
    renderAt("")
    await screen.findByTestId("token-frame-notfound")
    expect(screen.queryByTestId("token-frame-sender")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("the server unreachable: the down frame, and Try again opens it again", async () => {
    serve()
    let fail = true
    const ok = routes.open
    routes.open = (b) => (fail ? { status: 503, body: { state: "down" } } : (ok as Route)(b))
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("token-frame-down")
    fail = false
    fireEvent.click(screen.getByTestId("token-frame-action"))
    await screen.findByTestId("client-action-title")
  })

  it("This is not for me: tells the server and offers to ask for an invitation", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("read-continue"))
    fireEvent.click(await screen.findByTestId("identity-not-me"))
    await screen.findByTestId("token-frame-wrong")
    expect(of("request")[0]?.body).toEqual({ t: TOKEN, type: "not_me" })
    fireEvent.input(screen.getByTestId("token-frame-email"), {
      target: { value: "me@client.example" },
    })
    fireEvent.click(screen.getByTestId("token-frame-action"))
    await screen.findByTestId("token-frame-done")
    expect(of("request")[1]?.body).toEqual({
      t: TOKEN,
      type: "invite_asked",
      email: "me@client.example",
    })
  })

  it("the page offers French, and the code step then asks the server for French words", async () => {
    serve()
    renderAt(`#t=${TOKEN}`)
    await readToEnd()
    fireEvent.click(screen.getByTestId("client-action-lang-fr"))
    expect(screen.getByTestId("read-continue").textContent).toBe("Continuer vers la signature")
    // The document is not translated with the page.
    expect(screen.getByTestId("doc-paragraph").textContent).toBe("The parties agree.")
    fireEvent.click(screen.getByTestId("read-continue"))
    await screen.findByTestId("step-identity-panel")
    fireEvent.input(screen.getByTestId("code-input"), { target: { value: "123456" } })
    fireEvent.input(screen.getByTestId("identity-name"), { target: { value: "Jean" } })
    fireEvent.input(screen.getByTestId("identity-capacity"), { target: { value: "Directeur" } })
    fireEvent.click(screen.getByTestId("identity-continue"))
    await screen.findByTestId("step-confirm-panel")
    expect(of("verify")[0]?.body.lang).toBe("fr")
  })

  it("renders client and sender text as text, never as markup", async () => {
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`
    serve({
      open: () => ({
        status: 200,
        body: {
          ...OPEN,
          title: payload,
          sender: { name: payload, org: payload },
          summary: [{ k: payload, v: payload }],
        },
      }),
      document: (b) =>
        b.format === "blocks"
          ? {
              status: 200,
              body: { format: "blocks", content: [{ type: "paragraph", text: payload }] },
            }
          : { status: 404, body: { error: { code: "not_found" } } },
    })
    renderAt(`#t=${TOKEN}`)
    await screen.findByTestId("doc-view")
    const page = screen.getByTestId("client-action-page")
    expect(page.querySelector("script")).toBeNull()
    expect(page.querySelector("img")).toBeNull()
    expect(screen.getByTestId("client-action-title").textContent).toBe(payload)
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
  })
})
