// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's screens against a stub of `/api/portal/*`: the sign-in
// page (same words for every address, the link spent only on a click, the
// address cleaned of it), each screen and its states, one failed part leaving
// the rest, hours as a total only, and client text shown as text.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { englishT, I18nProvider } from "~/modules/i18n/i18n-context"
import { DocumentPage } from "./Approve"
import { documentState, hoursLine, money } from "./format"
import { NoticeToRead } from "./Notice"
import { HomePage, InvoicesPage, ProjectPage } from "./Pages"
import PortalRoot, { portalPath } from "./PortalRoot"
import { navItems } from "./PortalShell"
import { setPortalAccessToken } from "./portal-api"
import { RequestsPage } from "./Requests"
import { SignInForm } from "./SignIn"
import { heldSignInLink, linkFromFragment } from "./sign-in-link"
import type { PortalHome, PortalInvoice } from "./types"

type Reply = { status: number; body?: unknown }
type Handler = (init: RequestInit | undefined, url: string) => Reply

let calls: Array<{ url: string; init?: RequestInit }>
let routes: Record<string, Handler>

function serve(over: Record<string, Handler>) {
  routes = over
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const path = url.replace(/^.*\/api\/portal/, "").split("?")[0] ?? ""
    const method = init?.method ?? "GET"
    const h = routes[`${method} ${path}`]
    const r = h ? h(init, url) : { status: 404, body: { error: { message: "Not found" } } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    })
  })
}

const wrap = (ui: () => unknown) =>
  render(() => <I18nProvider initialLocale="en">{ui() as never}</I18nProvider>)

const ME = {
  id: "u1",
  name: "Paul Garnier",
  email: "paul@client.example",
  locale: "en",
  timezone: null,
  contactName: "Élodie Renard",
}

function home(over: Partial<PortalHome> = {}): PortalHome {
  return {
    me: ME,
    projects: [{ id: "p1", name: "Website", ownerName: "Léa Roux" }],
    invoices: [],
    upcoming: [],
    requests: [],
    requestsOpen: false,
    unavailable: [],
    ...over,
  }
}

const INV: PortalInvoice = {
  id: "i1",
  type: "invoice",
  number: "INV-2026-004",
  status: "issued",
  paymentStatus: "paid",
  currency: "EUR",
  grandTotalMinor: "5376000",
  issuedAt: "2026-10-01",
  dueAt: "2026-10-31",
  paidAt: "2026-10-20",
  originalDocumentId: null,
  label: "Milestone 1",
  hasPdf: true,
}

beforeEach(() => {
  calls = []
  setPortalAccessToken(null)
  window.sessionStorage.clear()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("sign-in", () => {
  it("answers the same words for any address and posts the org's slug with it", async () => {
    serve({ "POST /auth/request": () => ({ status: 200, body: { data: { requested: true } } }) })
    const r = wrap(() => (
      <SignInForm
        slug="maison-alpha"
        branding={{ name: "Maison Alpha", logoUrl: null, notice: null }}
      />
    ))
    expect(r.getByTestId("portal-signin-title").textContent).toBe("Sign in to Maison Alpha")
    fireEvent.input(r.getByTestId("portal-signin-email"), { target: { value: "nobody@x.example" } })
    fireEvent.submit(r.getByTestId("portal-signin-email").closest("form") as HTMLFormElement)
    const sent = await r.findByTestId("portal-signin-sent")
    expect(sent.textContent).toBe(
      "If this address has access, a sign-in link is on its way. Check your inbox.",
    )
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      orgSlug: "maison-alpha",
      email: "nobody@x.example",
    })
  })

  it("reads the link from the fragment only", () => {
    expect(linkFromFragment("#c=abc&t=def")).toEqual({ challengeId: "abc", token: "def" })
    expect(linkFromFragment("#t=def")).toBeNull()
  })

  it("after load the address has no fragment, the history entry holds no token, and nothing is spent before the click", async () => {
    serve({
      "GET /auth/branding/maison-alpha": () => ({
        status: 200,
        body: {
          data: { name: "Maison Alpha", logoUrl: null, notice: "We keep your data 12 months." },
        },
      }),
      "POST /auth/verify": () => ({ status: 200, body: { data: { accessToken: "acc" } } }),
      "POST /auth/refresh": () => ({
        status: 401,
        body: { error: { message: "Invalid session" } },
      }),
      "GET /home": () => ({ status: 200, body: { data: home() } }),
      "GET /documents": () => ({ status: 200, body: { data: [] } }),
    })
    window.history.replaceState(null, "", "/portal/sign-in?org=maison-alpha#c=ch1&t=secret-token")
    const r = wrap(() => (
      <Router>
        <Route path="/portal/:slug/*" component={PortalRoot} />
      </Router>
    ))
    const button = await r.findByTestId("portal-verify-continue")
    expect(window.location.pathname).toBe("/portal/maison-alpha/verify")
    expect(window.location.hash).toBe("")
    expect(window.location.href).not.toContain("secret-token")
    expect(JSON.stringify(window.history.state ?? null)).not.toContain("secret-token")
    expect(calls.filter((c) => c.url.includes("/auth/verify"))).toEqual([])
    expect(heldSignInLink()).toEqual({ challengeId: "ch1", token: "secret-token" })
    expect(await r.findByTestId("portal-signin-notice")).toBeTruthy()

    fireEvent.click(button)
    expect(await r.findByTestId("portal-home")).toBeTruthy()
    const verify = calls.find((c) => c.url.includes("/auth/verify"))
    expect(JSON.parse(String(verify?.init?.body))).toEqual({
      challengeId: "ch1",
      token: "secret-token",
    })
    // A link works once: this tab forgets it, and no URL ever carried it.
    expect(heldSignInLink()).toBeNull()
    expect(calls.filter((c) => c.url.includes("secret-token"))).toEqual([])
    // The access token travels as a header, never in a URL.
    const homeCall = calls.find((c) => c.url.endsWith("/portal/home"))
    expect((homeCall?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer acc",
    )
    expect(calls.every((c) => !c.url.includes("acc"))).toBe(true)
  })

  it("a link that no longer works says so and asks for a new one", async () => {
    serve({
      "GET /auth/branding/maison-alpha": () => ({
        status: 200,
        body: { data: { name: "Maison Alpha", logoUrl: null, notice: null } },
      }),
      "POST /auth/verify": () => ({
        status: 401,
        body: { error: { message: "This link or code no longer works" } },
      }),
    })
    window.history.replaceState(null, "", "/portal/sign-in?org=maison-alpha#c=ch1&t=old")
    const r = wrap(() => (
      <Router>
        <Route path="/portal/:slug/*" component={PortalRoot} />
      </Router>
    ))
    fireEvent.click(await r.findByTestId("portal-verify-continue"))
    expect((await r.findByTestId("portal-verify-invalid")).textContent).toContain("no longer works")
  })

  it("without a session the portal page is the sign-in form, and the ended state is said plainly", async () => {
    const r = wrap(() => <SignInForm slug="maison-alpha" branding={null} ended />)
    expect(r.getByTestId("portal-access-ended").textContent).toContain("has ended")
    expect(portalPath("/portal/maison-alpha/projects/p1")).toEqual({
      slug: "maison-alpha",
      rest: ["projects", "p1"],
    })
  })
})

describe("home and shell", () => {
  it("shows the person's contact, and one failed part leaves the rest standing", () => {
    const r = wrap(() => (
      <HomePage
        home={home({ invoices: null, unavailable: ["invoices"], requestsOpen: true })}
        documents={[]}
        go={() => {}}
      />
    ))
    expect(r.getByTestId("portal-contact").textContent).toBe("Your contact: Élodie Renard")
    expect(r.getByTestId("portal-part-failed-invoices")).toBeTruthy()
    expect(r.getByTestId("portal-project-row-p1").textContent).toContain("Website")
    expect(r.getByTestId("portal-home-new-request")).toBeTruthy()
  })

  it("lists documents with their state in the client's words, and no withdrawn one", () => {
    const doc = (id: string, status: string) => ({
      id,
      number: `AG-${id}`,
      kind: "sow",
      title: "Statement of work",
      status,
      signedAt: null,
    })
    const r = wrap(() => (
      <HomePage
        home={home()}
        documents={[doc("1", "sent"), doc("2", "voided"), doc("3", "partly_signed")]}
        go={() => {}}
      />
    ))
    expect(r.getByTestId("portal-document-row-1").textContent).toContain("Waiting")
    expect(r.getByTestId("portal-document-row-3").textContent).toContain("Waiting")
    expect(r.queryByTestId("portal-document-row-2")).toBeNull()
    expect(r.getByTestId("portal-home-documents").textContent).not.toContain("portal.")
  })

  it("has a nav item only for a page with something shared", () => {
    expect(navItems(home(), null).map((i) => i.id)).toEqual(["home"])
    expect(navItems(home({ invoices: [INV], requestsOpen: true }), null).map((i) => i.id)).toEqual([
      "home",
      "invoices",
      "requests",
    ])
  })

  it("never shows a contact line when the company has no manager", () => {
    const r = wrap(() => (
      <HomePage home={home({ me: { ...ME, contactName: null } })} documents={[]} go={() => {}} />
    ))
    expect(r.queryByTestId("portal-contact")).toBeNull()
  })
})

describe("hours", () => {
  it("a retainer reads as hours used so far, never billed; hourly reads billed; none reads nothing", () => {
    const t = englishT
    expect(
      hoursLine({ kind: "so_far", usedMinutes: 1080, ofMinutes: 2400, period: null }, t, "en"),
    ).toBe("Hours used: 18 of 40 h so far")
    const billed = hoursLine(
      { kind: "billed", usedMinutes: 720, ofMinutes: null, period: null },
      t,
      "en",
    )
    expect(billed).toBe("Hours billed: 12 h")
    expect(
      hoursLine({ kind: "so_far", usedMinutes: 60, ofMinutes: null, period: null }, t, "en"),
    ).not.toMatch(/billed/)
    expect(hoursLine(null, t, "en")).toBeNull()
  })

  it("a project page shows the hours total and its steps; another company's project reads as not available", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /projects/p1": () => ({
        status: 200,
        body: {
          data: {
            id: "p1",
            name: "Website",
            ownerName: "Léa Roux",
            steps: [{ id: "s1", title: "Design", state: "done", doneShare: 100, dueOn: null }],
            hours: {
              kind: "so_far",
              usedMinutes: 1080,
              ofMinutes: 2400,
              period: "2026-11-01/2026-11-30",
            },
          },
        },
      }),
    })
    const r = wrap(() => <ProjectPage id="p1" />)
    expect((await r.findByTestId("portal-hours-line")).textContent).toBe(
      "Hours used: 18 of 40 h so far",
    )
    expect(r.getByTestId("portal-project-hours").textContent).toContain("November 2026")
    expect(r.getByTestId("portal-step-s1").textContent).toContain("Done")
    cleanup()
    const other = wrap(() => <ProjectPage id="p-other" />)
    expect((await other.findByTestId("portal-not-available")).textContent).toBe(
      "This page is not available.",
    )
  })

  it("a project with no hours row shows no hours at all", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /projects/p1": () => ({
        status: 200,
        body: { data: { id: "p1", name: "Website", ownerName: null, steps: [], hours: null } },
      }),
    })
    const r = wrap(() => <ProjectPage id="p1" />)
    await r.findByTestId("portal-project")
    expect(r.queryByTestId("portal-project-hours")).toBeNull()
    expect(r.getByTestId("portal-project").textContent).not.toMatch(/\bh\b|hours/i)
  })

  it("a project that bills by milestone says so, and that it has no billed hours", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /projects/p1": () => ({
        status: 200,
        body: {
          data: {
            id: "p1",
            name: "Website",
            ownerName: null,
            steps: [],
            hours: null,
            hoursNote: "by_milestone",
          },
        },
      }),
    })
    const r = wrap(() => <ProjectPage id="p1" />)
    expect((await r.findByTestId("portal-hours-note")).textContent).toBe(
      "This project bills by milestone, so it has no billed hours.",
    )
    expect(r.queryByTestId("portal-hours-line")).toBeNull()
    expect(r.getByTestId("portal-project").textContent).not.toMatch(/\d+\s*h\b/)
  })
})

describe("invoices", () => {
  it("lists issued invoices, a credit note names what it corrects, and nothing asks to pay online", () => {
    const credit: PortalInvoice = {
      ...INV,
      id: "c1",
      type: "credit_note",
      number: "CN-2026-001",
      grandTotalMinor: "-10000",
      originalDocumentId: "i1",
    }
    const r = wrap(() => <InvoicesPage home={home({ invoices: [INV, credit] })} />)
    expect(r.getByTestId("portal-invoice-c1").textContent).toContain(
      "Credit note correcting INV-2026-004",
    )
    expect(r.getByTestId("portal-invoice-i1").textContent).toContain(money("5376000", "EUR", "en"))
    expect(r.getByTestId("portal-invoices").textContent).toContain("bank transfer")
    expect(r.getByTestId("portal-invoices").textContent).not.toMatch(/pay now|card/i)
  })
})

describe("requests", () => {
  it("a failed send keeps the text and offers Send again", async () => {
    setPortalAccessToken("acc")
    serve({ "POST /requests": () => ({ status: 503, body: { error: { message: "down" } } }) })
    const r = wrap(() => <RequestsPage home={home({ requestsOpen: true })} reload={() => {}} />)
    fireEvent.input(r.getByTestId("portal-request-subject"), { target: { value: "Logo" } })
    fireEvent.input(r.getByTestId("portal-request-text"), { target: { value: "Please swap it" } })
    fireEvent.submit(r.getByTestId("portal-new-request"))
    expect(await r.findByTestId("portal-request-failed")).toBeTruthy()
    expect((r.getByTestId("portal-request-text") as HTMLTextAreaElement).value).toBe(
      "Please swap it",
    )
    expect(r.getByTestId("portal-request-send").textContent).toBe("Send again")
  })

  it("shows the person's requests with the replies, and no form when requests are closed", () => {
    const r = wrap(() => (
      <RequestsPage
        home={home({
          requests: [
            {
              id: "t1",
              subject: "Logo",
              status: "open",
              createdAt: null,
              lastMessageAt: null,
              messages: [
                {
                  id: "m1",
                  kind: "inbound",
                  fromName: "Paul",
                  authorLabel: null,
                  textBody: "Hi",
                  sentAt: null,
                },
                {
                  id: "m2",
                  kind: "outbound",
                  fromName: null,
                  authorLabel: "Léa Roux",
                  textBody: "Done",
                  sentAt: null,
                },
              ],
            },
          ],
        })}
        reload={() => {}}
      />
    ))
    expect(r.queryByTestId("portal-new-request")).toBeNull()
    expect(r.getByTestId("portal-message-m2").textContent).toContain("Léa Roux")
    expect(r.getByTestId("portal-message-m1").textContent).toContain("You")
  })
})

describe("approve", () => {
  const DOC = (actions: unknown[]) => ({
    status: 200,
    body: {
      data: {
        id: "a1",
        number: "AG-2026-011",
        kind: "proposal",
        title: "Statement of work",
        status: "sent",
        signedAt: null,
        versions: [],
        evidence: [],
        actions,
      },
    },
  })

  it("someone else's item shows who it waits on and offers no decision", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /documents/a1": () =>
        DOC([
          {
            id: "x1",
            kind: "approve",
            invitedName: "Anne Morel",
            mine: false,
            decidedAt: null,
            revokedAt: null,
            expiresAt: null,
          },
        ]),
    })
    const r = wrap(() => <DocumentPage id="a1" />)
    expect((await r.findByTestId("portal-waits-on")).textContent).toBe("Waiting on Anne Morel")
    expect(r.queryByTestId("portal-decide-yes")).toBeNull()
  })

  it("signing always asks the emailed code before it decides", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /documents/a1": () =>
        DOC([
          {
            id: "x1",
            kind: "sign",
            invitedName: "Paul",
            mine: true,
            decidedAt: null,
            revokedAt: null,
            expiresAt: null,
            words: "I sign it with a simple electronic signature.",
          },
        ]),
      "POST /actions/x1/code": () => ({ status: 202, body: { sent_to: "p•••@client.example" } }),
      "POST /actions/x1/decide": () => ({ status: 200, body: { data: { state: "signed" } } }),
    })
    const r = wrap(() => <DocumentPage id="a1" />)
    fireEvent.click(await r.findByTestId("portal-decide-yes"))
    await r.findByTestId("portal-decide-code")
    expect(calls.some((c) => c.url.includes("/decide"))).toBe(false)
    fireEvent.input(r.getByTestId("portal-decide-code"), { target: { value: "123456" } })
    fireEvent.input(r.getByTestId("portal-decide-name"), { target: { value: "Paul Garnier" } })
    fireEvent.click(r.getByTestId("portal-decide-confirm"))
    expect(await r.findByTestId("portal-decided")).toBeTruthy()
    const decide = calls.find((c) => c.url.includes("/decide"))
    expect(JSON.parse(String(decide?.init?.body))).toMatchObject({
      decision: "sign",
      code: "123456",
      typed_name: "Paul Garnier",
    })
  })

  it("after signing, says it was done and shows the document signed, without a reload", async () => {
    setPortalAccessToken("acc")
    const action = {
      id: "x1",
      kind: "sign",
      invitedName: "Paul",
      mine: true,
      decidedAt: null as string | null,
      revokedAt: null,
      expiresAt: null,
    }
    let reads = 0
    serve({
      "GET /documents/a1": () => {
        reads++
        const out = DOC([action])
        // The signed state lands a moment after the decision (the app records it).
        if (reads >= 3) (out.body.data as { status: string }).status = "signed"
        return out
      },
      "POST /actions/x1/code": () => ({ status: 202, body: { sent_to: "p•••@client.example" } }),
      "POST /actions/x1/decide": () => {
        action.decidedAt = "2026-11-17"
        return { status: 200, body: { data: { state: "signed" } } }
      },
    })
    const r = wrap(() => <DocumentPage id="a1" />)
    fireEvent.click(await r.findByTestId("portal-decide-yes"))
    await r.findByTestId("portal-decide-code")
    fireEvent.input(r.getByTestId("portal-decide-code"), { target: { value: "123456" } })
    fireEvent.input(r.getByTestId("portal-decide-name"), { target: { value: "Paul Garnier" } })
    fireEvent.click(r.getByTestId("portal-decide-confirm"))
    expect(await r.findByTestId("portal-decided-note")).toBeTruthy()
    await waitFor(
      () => expect(r.getByTestId("portal-document-status").textContent).toContain("Signed"),
      { timeout: 4000 },
    )
    expect(r.getByTestId("portal-decided-note")).toBeTruthy()
  })

  it("a code asked too soon says when it can be asked again", async () => {
    setPortalAccessToken("acc")
    serve({
      "GET /documents/a1": () =>
        DOC([
          {
            id: "x1",
            kind: "sign",
            invitedName: "Paul",
            mine: true,
            decidedAt: null,
            revokedAt: null,
            expiresAt: null,
          },
        ]),
      "POST /actions/x1/code": () => ({
        status: 429,
        body: { error: { code: "rate_limited", retry_at: "2030-01-01T10:30:00.000Z" } },
      }),
    })
    const r = wrap(() => <DocumentPage id="a1" />)
    fireEvent.click(await r.findByTestId("portal-decide-yes"))
    const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(
      new Date("2030-01-01T10:30:00.000Z"),
    )
    await waitFor(() => expect(r.getByTestId("portal-decide-note").textContent).toContain(time))
  })

  it("an approval in an old session asks the code when the server says so", async () => {
    setPortalAccessToken("acc")
    let decides = 0
    serve({
      "GET /documents/a1": () =>
        DOC([
          {
            id: "x1",
            kind: "approve",
            invitedName: "Paul",
            mine: true,
            decidedAt: null,
            revokedAt: null,
            expiresAt: null,
          },
        ]),
      "POST /actions/x1/decide": () => {
        decides++
        return decides === 1
          ? { status: 401, body: { error: { code: "code_required" } } }
          : { status: 200, body: { data: { state: "approved" } } }
      },
      "POST /actions/x1/code": () => ({ status: 202, body: { sent_to: "p•••@client.example" } }),
    })
    const r = wrap(() => <DocumentPage id="a1" />)
    fireEvent.click(await r.findByTestId("portal-decide-yes"))
    // The code refusal is about the decision: the session stays, a code is asked.
    expect(await r.findByTestId("portal-decide-code")).toBeTruthy()
    expect(calls.some((c) => c.url.includes("/auth/refresh"))).toBe(false)
  })

  it("names a document's state in the client's words", () => {
    expect(documentState("sent")).toBe("waiting")
    expect(documentState("partly_signed")).toBe("waiting")
    expect(documentState("signed")).toBe("signed")
    expect(documentState("voided")).toBe("withdrawn")
  })

  it("a generated document shows its text; an uploaded one its page pictures", async () => {
    setPortalAccessToken("acc")
    const doc = DOC([]) as { status: number; body: { data: Record<string, unknown> } }
    doc.body.data.versions = [
      {
        id: "v1",
        number: 1,
        hasFile: true,
        pageCount: 0,
        source: {
          body: {
            blocks: [
              { type: "heading", text: "1. Scope" },
              { type: "paragraph", text: "The studio builds the sign-on." },
            ],
          },
        },
      },
    ]
    serve({ "GET /documents/a1": () => doc })
    const r = wrap(() => <DocumentPage id="a1" />)
    const body = await r.findByTestId("portal-document-body")
    expect(body.textContent).toContain("1. Scope")
    expect(body.textContent).toContain("The studio builds the sign-on.")
    expect(r.queryByTestId("portal-document-empty")).toBeNull()
  })

  it("a version with neither text nor pictures says so instead of an empty section", async () => {
    setPortalAccessToken("acc")
    const doc = DOC([]) as { status: number; body: { data: Record<string, unknown> } }
    doc.body.data.versions = [
      { id: "v1", number: 1, hasFile: false, pageCount: 0, source: { body: { blocks: [] } } },
    ]
    serve({ "GET /documents/a1": () => doc })
    const r = wrap(() => <DocumentPage id="a1" />)
    expect((await r.findByTestId("portal-document-empty")).textContent).toBe(
      "This document cannot be shown here. Ask your contact for a copy.",
    )
  })
})

describe("client text", () => {
  it("renders a request subject and text with markup as plain text", () => {
    const payload = `<script>alert(1)</script><img src=x onerror=alert(2)>`
    const r = wrap(() => (
      <RequestsPage
        home={home({
          requests: [
            {
              id: "t1",
              subject: payload,
              status: "open",
              createdAt: null,
              lastMessageAt: null,
              messages: [
                {
                  id: "m1",
                  kind: "inbound",
                  fromName: payload,
                  authorLabel: null,
                  textBody: payload,
                  sentAt: null,
                },
              ],
            },
          ],
        })}
        reload={() => {}}
      />
    ))
    const row = r.getByTestId("portal-request-t1")
    expect(row.textContent).toContain(payload)
    expect(row.querySelector("script, img")).toBeNull()
  })
})

describe("notice", () => {
  it("acknowledges the version it showed; when the notice changed it shows the new one to read again", async () => {
    setPortalAccessToken("acc")
    const posted: unknown[] = []
    let current = 1
    serve({
      "POST /me/notice-ack": (init) => {
        const body = JSON.parse(String(init?.body)) as { version: number }
        posted.push(body)
        return body.version === current
          ? { status: 200, body: { data: { noticeVersion: current } } }
          : {
              status: 409,
              body: { error: { code: "NOTICE_CHANGED", message: "The notice changed." } },
            }
      },
    })
    const [branding, setBranding] = createSignal({
      name: "Maison Alpha",
      logoUrl: null,
      notice: "We log each sign-in.",
      noticeVersion: 1,
    })
    // The org wrote a new text after the page loaded.
    current = 2
    const r = wrap(() => (
      <NoticeToRead
        branding={branding()}
        acknowledged={null}
        onChanged={() =>
          setBranding({
            ...branding(),
            notice: "We log each sign-in and download.",
            noticeVersion: 2,
          })
        }
      />
    ))
    expect(r.getByTestId("portal-notice-read").textContent).toContain("We log each sign-in.")
    fireEvent.click(r.getByTestId("portal-notice-ack"))
    await waitFor(() =>
      expect(r.getByTestId("portal-notice-read").textContent).toContain(
        "We log each sign-in and download.",
      ),
    )
    expect(r.getByTestId("portal-notice-changed")).toBeTruthy()
    fireEvent.click(r.getByTestId("portal-notice-ack"))
    await waitFor(() => expect(r.queryByTestId("portal-notice-read")).toBeNull())
    expect(posted).toEqual([{ version: 1 }, { version: 2 }])
  })

  it("asks nothing when the person already acknowledged the notice shown", () => {
    const r = wrap(() => (
      <NoticeToRead
        branding={{ name: "Maison Alpha", logoUrl: null, notice: "We log.", noticeVersion: 3 }}
        acknowledged={3}
        onChanged={() => {}}
      />
    ))
    expect(r.queryByTestId("portal-notice-read")).toBeNull()
  })
})

describe("session", () => {
  it("a 401 on a data route tries one refresh, then the page signs the person out", async () => {
    setPortalAccessToken("old")
    serve({
      "GET /projects/p1": () => ({ status: 401, body: { error: { message: "Unauthorized" } } }),
      "POST /auth/refresh": () => ({
        status: 401,
        body: { error: { message: "Invalid session" } },
      }),
    })
    const r = wrap(() => <ProjectPage id="p1" />)
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/auth/refresh")).length).toBe(1))
    await r.findByTestId("portal-part-failed-project")
  })
})
