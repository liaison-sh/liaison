// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tailored demo's door in the browser: the needs picker, the verify band
// and its states, the link page that never verifies by itself, and the budget
// refusals (the next-steps dialog itself: DemoNextSteps.test.tsx).
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { DemoEntry } from "~/modules/demo/DemoEntry"
import { DemoVerifyPrompt } from "~/modules/demo/DemoVerifyPrompt"
import DemoVerifyRoute from "~/modules/demo/DemoVerifyRoute"
import {
  _resetDemoStore,
  DEMO_REFUSAL_EVENT,
  demoExhaustedRequest,
  demoVerifyFocusRequest,
  ensureDemoDoorSettings,
  listenForDemoRefusals,
  noteDemoRefusal,
  refreshDemoBudget,
} from "~/modules/demo/demo-store"
import { toggleEverything, toggleNeed } from "~/modules/demo/NeedsPicker"
import {
  _resetTurnstileLoader,
  createTurnstile,
  TURNSTILE_SCRIPT_URL,
} from "~/modules/demo/Turnstile"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider, useApi } from "~/modules/shell/ApiContext"
import { _resetBranding } from "~/modules/shell/branding-store"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"

const EN = en as Record<string, unknown>
/** The English text of a kernel key ("kernel.demo.x" -> its string). */
function i18nEn(key: string): string {
  let node: unknown = EN
  for (const part of key.replace(/^kernel\./, "").split(".")) {
    node = (node as Record<string, unknown>)?.[part]
  }
  return String(node)
}

function jwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Visitor",
      roles: ["admin"],
      scopes: ["kernel:org:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

interface Reply {
  status: number
  body: unknown
}

/** Answer per path (first matching needle wins) and record every call. */
function serve(replies: Array<[string, Reply | ((body: unknown) => Reply)]>) {
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? "GET", body })
    for (const [needle, reply] of replies) {
      if (url.includes(needle)) {
        const r = typeof reply === "function" ? reply(body) : reply
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        })
      }
    }
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  return calls
}

function mount(node: () => JSX.Element, path = "*") {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route path={path} component={() => <ApiProvider>{node()}</ApiProvider>} />
      </Router>
    </I18nProvider>
  ))
}

const BUDGET = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    data: {
      verified: false,
      emailMasked: "j•••@example.com",
      notifyManaged: false,
      budget: { usedMicroEur: 200000, capMicroEur: 200000 },
      box: { exhausted: false },
      byok: [],
      ...over,
    },
  },
})

beforeEach(() => {
  _resetDemoStore()
  _resetBranding()
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  _resetDemoStore()
  _resetBranding()
  clearAuth()
})

describe("needs picker", () => {
  it("keeps the pick order and Everything picks every need in canonical order", () => {
    expect(toggleNeed(toggleNeed([], "dev"), "support")).toEqual(["dev", "support"])
    expect(toggleNeed(["dev", "support", "chat"], "support")).toEqual(["dev", "chat"])
    expect(toggleEverything(["dev"])).toEqual([
      "support",
      "projects",
      "chat",
      "sales",
      "commerce",
      "dev",
      "knowledge",
    ])
    expect(toggleEverything(toggleEverything([]))).toEqual([])
  })

  it("shows rank badges in pick order, gates Continue on a pick, and posts the picks", async () => {
    const calls = serve([
      ["/demo/orgs", { status: 400, body: { error: { message: "x", code: "turnstile_failed" } } }],
    ])
    mount(() => <DemoEntry onSignedIn={() => {}} />)
    expect(screen.getByTestId("demo-continue")).toBeDisabled()
    expect(screen.getByTestId("demo-pick-summary").textContent).toBe(
      "Pick at least one. You can pick several; they play in that order.",
    )

    fireEvent.click(screen.getByTestId("demo-needs-sales"))
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    expect(screen.getByTestId("demo-needs-rank-sales").textContent).toBe("1")
    expect(screen.getByTestId("demo-needs-rank-support").textContent).toBe("2")
    expect(screen.getByTestId("demo-needs-sales").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("demo-pick-summary").textContent).toBe(
      "Sales & CRM → Customer support · about 7 min",
    )

    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "j@example.com" } })
    expect(screen.getByTestId("demo-create")).not.toBeDisabled()
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(screen.getByTestId("demo-signup-error")).toBeTruthy())
    expect(screen.getByTestId("demo-signup-error").textContent).toContain("could not confirm")
    const post = calls.find((c) => c.url.includes("/demo/orgs"))
    expect(post?.body).toMatchObject({ needs: ["sales", "support"] })
    expect(post?.body).not.toHaveProperty("newsOptIn")

    fireEvent.click(screen.getByTestId("demo-details-back"))
    fireEvent.click(screen.getByTestId("demo-change-picks"))
    fireEvent.click(screen.getByTestId("demo-needs-all"))
    expect(screen.getByTestId("demo-needs-rank-dev").textContent).toBe("6")
    expect(screen.getByTestId("demo-needs-rank-knowledge").textContent).toBe("7")
  })

  it("offers news as an unticked checkbox and posts the consent only when ticked", async () => {
    const calls = serve([
      ["/demo/orgs", { status: 400, body: { error: { message: "x", code: "turnstile_failed" } } }],
    ])
    mount(() => <DemoEntry onSignedIn={() => {}} />)
    fireEvent.click(screen.getByTestId("demo-needs-sales"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "j@example.com" } })
    const box = screen.getByTestId("demo-news-opt-in") as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByTestId("demo-signup-door").textContent).toContain(
      "Send me occasional news about Liaison",
    )
    expect(screen.getByTestId("demo-lead-notice").textContent).toContain("deleted")
    fireEvent.click(box)
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(screen.getByTestId("demo-signup-error")).toBeTruthy())
    const post = calls.find((c) => c.url.includes("/demo/orgs"))
    expect(post?.body).toMatchObject({ newsOptIn: true })
  })

  it("says what is missing beside the button it stops", () => {
    serve([])
    mount(() => <DemoEntry onSignedIn={() => {}} />)
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    const hint = () => screen.queryByTestId("demo-create-hint")?.textContent ?? null
    expect(screen.getByTestId("demo-create")).toBeDisabled()
    expect(hint()).toBe("Enter your name and email to start.")
    expect(screen.getByTestId("demo-create").getAttribute("aria-describedby")).toBe(
      "demo-create-hint",
    )
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "j@example.com" } })
    expect(hint()).toBeNull()
    expect(screen.getByTestId("demo-create")).not.toBeDisabled()
  })

  it("lets the visitor just explore: everything seeded, on to the company page", async () => {
    const calls = serve([
      ["/demo/orgs", { status: 400, body: { error: { message: "x", code: "turnstile_failed" } } }],
    ])
    mount(() => <DemoEntry onSignedIn={() => {}} />)
    fireEvent.click(screen.getByTestId("demo-explore"))
    expect(screen.getByTestId("demo-picked-all").textContent).toBe(
      "Everything loaded, explore at your own pace",
    )
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "j@example.com" } })
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/demo/orgs"))).toBe(true))
    expect(calls.find((c) => c.url.includes("/demo/orgs"))?.body).toMatchObject({
      needs: ["support", "projects", "chat", "sales", "commerce", "dev", "knowledge"],
    })
  })

  it("fits a phone: two columns of tiles below lg, nothing with a fixed wide width", () => {
    serve([])
    mount(() => <DemoEntry onSignedIn={() => {}} />)
    const list = screen.getByTestId("demo-needs-list")
    expect(list.className.split(" ")).toContain("grid-cols-2")
    expect(list.className.split(" ")).toContain("lg:grid-cols-4")
    expect(screen.getByTestId("demo-needs-support").className).toContain("w-full")
    const all = screen.getByTestId("demo-entry").querySelectorAll("*")
    for (const el of all) {
      for (const token of (el.getAttribute("class") ?? "").split(/\s+/)) {
        if (/^(?:lg|xl|2xl):/.test(token)) continue
        const m = token.match(/^(?:[a-z]+:)?(?:min-)?w-\[(\d+)px\]$/)
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(390)
        expect(token).not.toMatch(/^grid-cols-\[.*\d{3,}px/)
      }
    }
  })
})

describe("verify band", () => {
  function VerifyHarness() {
    const api = useApi()
    void refreshDemoBudget(api)
    return <DemoVerifyPrompt />
  }

  beforeEach(() => setTokens(jwt(), "refresh"))

  it("is idle with the masked address, then verified on the right code", async () => {
    const calls = serve([
      ["/demo/budget", BUDGET()],
      ["/demo/verify", { status: 200, body: { data: { verified: true } } }],
    ])
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    expect(screen.getByTestId("demo-verify").textContent).toContain("j•••@example.com")
    const input = screen.getByTestId("demo-verify-code")
    expect(input.getAttribute("autocomplete")).toBe("one-time-code")
    expect(input.getAttribute("inputmode")).toBe("numeric")
    expect(screen.getByTestId("demo-verify-submit")).toBeDisabled()
    fireEvent.input(input, { target: { value: " 123 456 " } })
    fireEvent.click(screen.getByTestId("demo-verify-submit"))
    await waitFor(() => expect(screen.getByTestId("demo-verify-success")).toBeTruthy())
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/demo/verify"))
    expect(post?.body).toEqual({ code: "123456" })
  })

  it("shows the attempts left on a wrong code, then expired", async () => {
    let n = 0
    serve([
      ["/demo/budget", BUDGET()],
      [
        "/demo/verify",
        () => {
          n += 1
          return n === 1
            ? {
                status: 400,
                body: {
                  error: { message: "x", code: "code_invalid", details: { attemptsLeft: 3 } },
                },
              }
            : { status: 410, body: { error: { message: "x", code: "code_expired" } } }
        },
      ],
    ])
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    fireEvent.input(screen.getByTestId("demo-verify-code"), { target: { value: "000000" } })
    fireEvent.click(screen.getByTestId("demo-verify-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-verify-status").textContent).toContain("Attempts left: 3"),
    )
    expect(screen.getByTestId("demo-verify").getAttribute("data-status")).toBe("invalid")
    fireEvent.click(screen.getByTestId("demo-verify-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-verify").getAttribute("data-status")).toBe("expired"),
    )
  })

  it("goes sending then sent on resend", async () => {
    const latch: { release: () => void } = { release: () => {} }
    const gate = new Promise<void>((r) => {
      latch.release = r
    })
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("/demo/verify/send")) await gate
      const body = url.includes("/demo/budget")
        ? BUDGET().body
        : { data: { sent: true, emailMasked: "j•••@example.com" } }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    fireEvent.click(screen.getByTestId("demo-verify-resend"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-verify").getAttribute("data-status")).toBe("sending"),
    )
    latch.release()
    await waitFor(() =>
      expect(screen.getByTestId("demo-verify").getAttribute("data-status")).toBe("sent"),
    )
  })

  it("says the code could not be sent, with a retry, when none went out", async () => {
    serve([["/demo/budget", BUDGET({ codeSent: false })]])
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    const text = screen.getByTestId("demo-verify").textContent ?? ""
    expect(text).not.toContain("We sent a 6-digit code")
    expect(text).toContain("cannot send the code right now")
    expect(screen.getByTestId("demo-verify-resend")).toBeTruthy()
  })

  it("does not nag a visitor who saved their own key", async () => {
    serve([["/demo/budget", BUDGET({ byok: ["openrouter"], codeSent: true })]])
    mount(() => <VerifyHarness />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("demo-verify")).toBeNull()
  })

  it("says Turnstile failed when a resend gets no token", async () => {
    const calls = serve([
      ["/settings/branding", { status: 200, body: { data: { demo: { turnstileSiteKey: "k" } } } }],
      ["/demo/budget", BUDGET({ codeSent: true })],
    ])
    await ensureDemoDoorSettings()
    // The script never loads in the test page: the widget yields no token.
    window.turnstile = {
      render: (_el, opts) => {
        queueMicrotask(() => opts["error-callback"]?.())
        return "w1"
      },
      execute: () => {},
      reset: () => {},
      remove: () => {},
    }
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    fireEvent.click(screen.getByTestId("demo-verify-resend"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-verify-status").textContent).toContain(
        i18nEn("kernel.demo.errTurnstile"),
      ),
    )
    expect(calls.some((c) => c.url.includes("/demo/verify/send"))).toBe(false)
    window.turnstile = undefined
  })

  it("is absent once verified", async () => {
    serve([["/demo/budget", BUDGET({ verified: true })]])
    mount(() => <VerifyHarness />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("demo-verify")).toBeNull()
  })

  it("takes focus when a spend is refused for want of a confirmed address", async () => {
    serve([["/demo/budget", BUDGET()]])
    mount(() => <VerifyHarness />)
    await waitFor(() => expect(screen.getByTestId("demo-verify")).toBeTruthy())
    const before = demoVerifyFocusRequest()
    listenForDemoRefusals()
    window.dispatchEvent(
      new CustomEvent(DEMO_REFUSAL_EVENT, { detail: { code: "demo_verification_required" } }),
    )
    expect(demoVerifyFocusRequest()).toBe(before + 1)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("demo-verify-code")))
  })
})

describe("the link page", () => {
  it("does not POST on open, and POSTs once on Confirm", async () => {
    window.history.replaceState(null, "", "/demo/verify?t=org.code.mac")
    const calls = serve([["/demo/verify", { status: 200, body: { data: { verified: true } } }]])
    mount(() => <DemoVerifyRoute />, "/demo/verify")
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("demo-verify-link-confirm"))
    await waitFor(() => expect(screen.getByTestId("demo-verify-link-done")).toBeTruthy())
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ token: "org.code.mac" })
  })

  it("says so when the link was already used", async () => {
    window.history.replaceState(null, "", "/demo/verify?t=org.code.mac")
    serve([
      ["/demo/verify", { status: 410, body: { error: { message: "x", code: "code_expired" } } }],
    ])
    mount(() => <DemoVerifyRoute />, "/demo/verify")
    fireEvent.click(screen.getByTestId("demo-verify-link-confirm"))
    await waitFor(() => expect(screen.getByTestId("demo-verify-link-expired")).toBeTruthy())
  })
})

describe("the budget refusals", () => {
  it("asks to open on the FIRST exhausted refusal only", () => {
    const before = demoExhaustedRequest()
    noteDemoRefusal("demo_budget_exhausted")
    noteDemoRefusal("demo_box_exhausted")
    expect(demoExhaustedRequest()).toBe(before + 1)
  })
})

describe("Turnstile", () => {
  afterEach(() => {
    window.turnstile = undefined
    _resetTurnstileLoader()
    for (const s of document.querySelectorAll("script[data-testid=turnstile-script]")) s.remove()
  })

  function Probe(props: { out: (t: string) => void; action: "demo_start" | "demo_code" }) {
    const ts = createTurnstile()
    return (
      <>
        <ts.Widget />
        <button
          type="button"
          data-testid="probe"
          onClick={() => void ts.token(props.action).then(props.out)}
        />
      </>
    )
  }

  it("loads nothing and yields no token without a site key", async () => {
    serve([["/settings/branding", { status: 200, body: { data: { flags: { demo: true } } } }]])
    await ensureDemoDoorSettings()
    const out = vi.fn()
    mount(() => <Probe out={out} action="demo_start" />)
    fireEvent.click(screen.getByTestId("probe"))
    await waitFor(() => expect(out).toHaveBeenCalledWith(""))
    expect(document.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`)).toBeNull()
  })

  it("asks a fresh token per action with the site key", async () => {
    serve([
      [
        "/settings/branding",
        {
          status: 200,
          body: {
            data: { demo: { selfHostUrl: "https://d.example", turnstileSiteKey: "site-key" } },
          },
        },
      ],
    ])
    await ensureDemoDoorSettings()
    const rendered: Array<{ sitekey: string; action: string }> = []
    window.turnstile = {
      render: (_el, opts) => {
        rendered.push({ sitekey: opts.sitekey, action: opts.action })
        queueMicrotask(() => opts.callback(`token-for-${opts.action}`))
        return `w${rendered.length}`
      },
      execute: () => {},
      reset: () => {},
      remove: () => {},
    }
    const out = vi.fn()
    mount(() => <Probe out={out} action="demo_code" />)
    fireEvent.click(screen.getByTestId("probe"))
    await waitFor(() => expect(out).toHaveBeenCalledWith("token-for-demo_code"))
    fireEvent.click(screen.getByTestId("probe"))
    await waitFor(() => expect(out).toHaveBeenCalledTimes(2))
    expect(rendered).toEqual([
      { sitekey: "site-key", action: "demo_code" },
      { sitekey: "site-key", action: "demo_code" },
    ])
  })
})
