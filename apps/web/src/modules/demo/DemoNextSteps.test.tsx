// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The next-steps dialog at its two moments: the budget spent (opened once per
// workspace by the first refusal) and the end of the last scenario. Options
// ordered by the visitor's address, real numbers in the recap and the budget.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import type { DemoScenarioItem } from "~/modules/demo/DemoScenarioRunner"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { _resetBranding } from "~/modules/shell/branding-store"

const scenarios = vi.hoisted(() => ({ items: null as unknown }))
vi.mock("~/modules/demo/DemoScenarioRunner", () => {
  const [items, setItems] = createSignal<DemoScenarioItem[]>([])
  scenarios.items = setItems
  return { demoScenarioQueue: items, demoScenarioQueueLoaded: () => true }
})

const {
  DemoNextSteps,
  DemoRegisterBannerEntry,
  demoContactUrl,
  demoRegisterUrl,
  isPersonalEmail,
  orderedPaths,
} = await import("~/modules/demo/DemoNextSteps")
const {
  _resetDemoStore,
  demoExhaustedRequest,
  demoNextSteps,
  noteDemoRefusal,
  openDemoNextSteps,
  openDemoNextStepsOnce,
} = await import("~/modules/demo/demo-store")

function setQueue(items: DemoScenarioItem[]): void {
  ;(scenarios.items as (v: DemoScenarioItem[]) => void)(items)
}

const item = (need: DemoScenarioItem["need"], status: DemoScenarioItem["status"]) => ({
  need,
  tourId: `kernel.scenario-${need}`,
  status,
  beatIndex: 0,
  beatCount: 8,
})

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

/** Answer per path (first matching needle wins) and record every call. */
function serve(replies: Array<[string, unknown]>) {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? "GET" })
    const hit = replies.find(([needle]) => url.includes(needle))
    return new Response(JSON.stringify({ data: hit ? hit[1] : {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  return calls
}

const BRANDING = {
  orgName: "Demo",
  flags: { demo: true },
  demo: { bookingUrl: "https://example.test/contact", selfHostUrl: "https://example.test/self" },
}

function budget(over: Record<string, unknown> = {}) {
  return {
    verified: true,
    emailMasked: "j•••@studio.example",
    email: "jo@studio.example",
    nextStepsShown: false,
    notifyManaged: false,
    budget: { usedMicroEur: 200000, capMicroEur: 200000 },
    box: { exhausted: false },
    byok: [],
    ...over,
  }
}

const RECAP = {
  startedAt: new Date(Date.now() - 22 * 60_000).toISOString(),
  agentActions: 47,
  approvalsDecided: 5,
}

const REGISTER = "https://hosted.example/signup/"
const WITH_REGISTER = { ...BRANDING, demo: { ...BRANDING.demo, registerUrl: REGISTER } }

function world(over: Record<string, unknown> = {}, branding: unknown = BRANDING) {
  return serve([
    ["/settings/branding", branding],
    ["/demo/budget", budget(over)],
    ["/demo/recap", RECAP],
    ["/demo/next-steps/shown", { nextStepsShown: true }],
  ])
}

function mount(locale: "en" | "fr" = "en", banner = false) {
  render(() => (
    <I18nProvider initialLocale={locale}>
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>{banner ? <DemoRegisterBannerEntry /> : <DemoNextSteps />}</ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

const pathOrder = () =>
  [...screen.getByTestId("demo-next-paths").querySelectorAll("section")].map((s) =>
    s.getAttribute("data-testid"),
  )

beforeEach(() => {
  _resetDemoStore()
  _resetBranding()
  setTokens(jwt(), "refresh")
  setQueue([item("support", "completed"), item("sales", "new"), item("dev", "new")])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  _resetDemoStore()
  _resetBranding()
  clearAuth()
})

describe("the budget moment", () => {
  it("renders the real budget and recap, setup first for a work address", async () => {
    world()
    mount()
    openDemoNextSteps("budget")
    await waitFor(() =>
      expect(screen.getByTestId("demo-next-steps").getAttribute("data-state")).toBe("spent"),
    )
    expect(screen.getByRole("dialog").textContent).toContain(
      "Your agents did good work. Here is how to keep going.",
    )
    expect(screen.getByTestId("demo-next-lead").textContent).toBe(
      "You used €0.20 of the €0.20 on us, so agents on our key have stopped. The rest of your workspace stays open.",
    )
    await waitFor(() =>
      expect(screen.getByTestId("demo-next-recap-actions").textContent).toBe("47"),
    )
    expect(screen.getByTestId("demo-next-recap-approvals").textContent).toBe("5")
    expect(screen.getByTestId("demo-next-recap-scenarios").textContent).toBe("1 / 3")
    expect(screen.getByTestId("demo-next-recap-minutes").textContent).toBe("22 min")
    await waitFor(() =>
      expect(pathOrder()).toEqual(["demo-next-setup", "demo-next-key", "demo-next-self"]),
    )
    expect(screen.getByTestId("demo-next-setup").hasAttribute("data-primary")).toBe(true)
    // Without a register URL nothing changes: three cards, no register, no text links.
    expect(screen.queryByTestId("demo-next-register")).toBeNull()
    expect(screen.getByTestId("demo-next-key").hasAttribute("data-link")).toBe(false)
    // The remaining scenarios, the played one struck through.
    expect(screen.getByTestId("demo-next-remaining").textContent).toContain(
      "2 more scenarios to play with your key:",
    )
    expect(screen.getByTestId("demo-next-chip-support").hasAttribute("data-done")).toBe(true)
    expect(screen.getByTestId("demo-next-chip-sales").hasAttribute("data-done")).toBe(false)
    // While the budget is spent there is nothing left to explore with it.
    expect(screen.queryByTestId("demo-next-explore")).toBeNull()
    expect(screen.getByTestId("demo-next-continue")).toBeTruthy()
  })

  it("puts the key first for a personal address, and opens the demo's key form", async () => {
    world({ email: "jo@gmail.com" })
    mount()
    openDemoNextSteps("budget")
    await waitFor(() =>
      expect(pathOrder()).toEqual(["demo-next-key", "demo-next-self", "demo-next-setup"]),
    )
    expect(screen.getByTestId("demo-next-key").hasAttribute("data-primary")).toBe(true)
    expect(screen.queryByTestId("demo-byok-standalone")).toBeNull()
    fireEvent.click(screen.getByTestId("demo-next-key-action"))
    expect(screen.getByTestId("demo-byok-standalone")).toBeTruthy()
  })

  it("opens the contact page with the address and the scenarios seen", async () => {
    world()
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    mount()
    openDemoNextSteps("budget")
    await waitFor(() => expect(screen.getByTestId("demo-next-setup-action")).toBeTruthy())
    // The address comes with the budget read.
    await waitFor(() =>
      expect(screen.getByTestId("demo-next-steps").getAttribute("data-state")).toBe("spent"),
    )
    fireEvent.click(screen.getByTestId("demo-next-setup-action"))
    expect(open).toHaveBeenCalledWith(
      "https://example.test/contact?topic=setup&from=demo&email=jo%40studio.example&scenarios=support",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("a tick on the form is done only once the address is confirmed", async () => {
    world({ notifyManaged: true, verified: false })
    mount()
    openDemoNextSteps("budget")
    expect(await screen.findByTestId("demo-next-notify")).toBeTruthy()
    expect(screen.queryByTestId("demo-next-notify-done")).toBeNull()
  })

  it("speaks French", async () => {
    world()
    mount("fr")
    openDemoNextSteps("budget")
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Vos agents ont bien travaillé. Voici comment continuer.",
      ),
    )
    expect(screen.getByTestId("demo-next-setup").textContent).toContain("On l'installe pour vous")
  })
})

describe("with a register URL (the hosted edition's signup)", () => {
  it("puts register first and filled, for a work and a personal address, the rest as text links", async () => {
    for (const email of ["jo@studio.example", "jo@gmail.com"]) {
      _resetDemoStore()
      world({ email }, WITH_REGISTER)
      mount()
      openDemoNextSteps("budget")
      await waitFor(() =>
        expect(screen.getByTestId("demo-next-steps").getAttribute("data-state")).toBe("spent"),
      )
      await waitFor(() => expect(pathOrder()[0]).toBe("demo-next-register"))
      expect(pathOrder().slice(1).sort()).toEqual([
        "demo-next-key",
        "demo-next-self",
        "demo-next-setup",
      ])
      expect(screen.getByTestId("demo-next-register").hasAttribute("data-primary")).toBe(true)
      for (const id of ["setup", "key", "self"]) {
        expect(screen.getByTestId(`demo-next-${id}`).hasAttribute("data-primary")).toBe(false)
        expect(screen.getByTestId(`demo-next-${id}`).hasAttribute("data-link")).toBe(true)
      }
      cleanup()
    }
  })

  it("leads the end card too, and opens the URL with from and goal, never the address", async () => {
    setQueue([item("sales", "completed"), item("knowledge", "completed")])
    world({}, WITH_REGISTER)
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    mount()
    openDemoNextSteps("end")
    await waitFor(() => expect(pathOrder()[0]).toBe("demo-next-register"))
    expect(screen.getByTestId("demo-next-register").hasAttribute("data-primary")).toBe(true)
    fireEvent.click(screen.getByTestId("demo-next-register-action"))
    expect(open).toHaveBeenCalledWith(
      "https://hosted.example/signup/?from=demo&goal=knowledge",
      "_blank",
      "noopener,noreferrer",
    )
    expect(JSON.stringify(open.mock.calls)).not.toContain("studio.example")
  })

  it("the key option still opens the demo's key form from its text link", async () => {
    world({ email: "jo@gmail.com" }, WITH_REGISTER)
    mount()
    openDemoNextSteps("budget")
    await waitFor(() => expect(screen.getByTestId("demo-next-key-action")).toBeTruthy())
    fireEvent.click(screen.getByTestId("demo-next-key-action"))
    expect(screen.getByTestId("demo-byok-standalone")).toBeTruthy()
  })

  it("speaks French", async () => {
    world({}, WITH_REGISTER)
    mount("fr")
    openDemoNextSteps("budget")
    await waitFor(() =>
      expect(screen.getByTestId("demo-next-register").textContent).toContain("Créez votre espace"),
    )
  })

  it("the banner offers it once a scenario is finished, and not before", async () => {
    setQueue([item("support", "new")])
    world({}, WITH_REGISTER)
    mount("en", true)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("demo-banner-register")).toBeNull()
    setQueue([item("support", "completed")])
    const link = await screen.findByTestId("demo-banner-register")
    expect(link.textContent).toBe("Create your workspace")
    expect(link.getAttribute("href")).toBe("https://hosted.example/signup/?from=demo&goal=support")
  })

  it("without a register URL, the banner shows nothing", async () => {
    setQueue([item("support", "completed")])
    world()
    mount("en", true)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("demo-banner-register")).toBeNull()
  })
})

describe("opens by itself once", () => {
  /** The two reads the store makes, the budget answering whether it already opened. */
  function fakeApi(shown: boolean) {
    const posted: string[] = []
    return {
      posted,
      get: async <T,>() => budget({ nextStepsShown: shown }) as T,
      post: async <T,>(path: string) => {
        posted.push(path)
        return {} as T
      },
    }
  }

  it("opens on the first refusal and records it, so a reload does not reopen it", async () => {
    const api = fakeApi(false)
    const before = demoExhaustedRequest()
    noteDemoRefusal("demo_budget_exhausted")
    noteDemoRefusal("demo_budget_exhausted")
    expect(demoExhaustedRequest()).toBe(before + 1)
    await openDemoNextStepsOnce(api)
    expect(demoNextSteps()).toBe("budget")
    expect(api.posted).toEqual(["/demo/next-steps/shown"])
  })

  it("stays closed when the workspace already showed it", async () => {
    const api = fakeApi(true)
    await openDemoNextStepsOnce(api)
    expect(demoNextSteps()).toBeNull()
    expect(api.posted).toEqual([])
  })
})

describe("the end of the last scenario", () => {
  it("names the scenarios seen and leads with the budget left", async () => {
    setQueue([item("support", "completed"), item("sales", "completed"), item("dev", "completed")])
    world({ budget: { usedMicroEur: 130000, capMicroEur: 200000 } })
    mount()
    openDemoNextSteps("end")
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "You have seen the 3 scenarios. What now?",
      ),
    )
    await waitFor(() => expect(screen.getByTestId("demo-next-explore")).toBeTruthy())
    expect(screen.getByTestId("demo-next-explore-body").textContent).toContain(
      "You have €0.07 left of the €0.20 on us.",
    )
    expect((screen.getByTestId("demo-next-explore-bar") as HTMLElement).style.width).toBe("35%")
    expect(screen.getByTestId("demo-next-recap-scenarios").textContent).toBe("3 / 3")
    await waitFor(() => expect(pathOrder()[0]).toBe("demo-next-setup"))
    expect(screen.getByTestId("demo-next-key").textContent).toContain(
      "Once the €0.20 on us is spent",
    )
    expect(screen.queryByTestId("demo-next-remaining")).toBeNull()
    fireEvent.click(screen.getByTestId("demo-next-explore-action"))
    expect(demoNextSteps()).toBeNull()
  })
})

describe("helpers", () => {
  it("tells personal addresses from work ones", () => {
    for (const e of ["a@gmail.com", "a@yahoo.fr", "a@hotmail.co.uk", "a@gmx.de", "a@free.fr"]) {
      expect(isPersonalEmail(e)).toBe(true)
    }
    for (const e of ["a@studio-tone.fr", "a@example.com", null, "broken"]) {
      expect(isPersonalEmail(e)).toBe(false)
    }
    expect(orderedPaths(["self", "key"], false)).toEqual(["key", "self"])
  })

  it("builds the register URL: from=demo, a goal only for knowledge, support and projects", () => {
    expect(demoRegisterUrl(REGISTER, "projects")).toBe(`${REGISTER}?from=demo&goal=projects`)
    expect(demoRegisterUrl(REGISTER, "sales")).toBe(`${REGISTER}?from=demo`)
    expect(demoRegisterUrl(REGISTER, null)).toBe(`${REGISTER}?from=demo`)
    expect(demoRegisterUrl("https://hosted.example/signup/?plan=base", "support")).toBe(
      "https://hosted.example/signup/?plan=base&from=demo&goal=support",
    )
  })

  it("adds the parameters to a web page and leaves a mail link alone", () => {
    expect(demoContactUrl("mailto:a@example.test", "jo@x.test", ["support"])).toBe(
      "mailto:a@example.test",
    )
    expect(demoContactUrl("https://example.test/contact", null, [])).toBe(
      "https://example.test/contact?topic=setup&from=demo",
    )
  })
})
