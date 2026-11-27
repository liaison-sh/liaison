// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigateSpy = vi.fn()
let currentPathname = "/"

vi.mock("@solidjs/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solidjs/router")>()
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    useLocation: () => ({
      get pathname() {
        return currentPathname
      },
    }),
  }
})

import {
  getTabTypes,
  patternToUrl,
  registerTabType,
  resetRegistry,
  urlToTabInfo,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { openFromWork } from "~/modules/shell/open-from-work"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import {
  createPushNav,
  isDetailRoute,
  masterRouteFor,
  openDetailFrom,
  parentRouteForPath,
  patternIsDetail,
  resetPushNavOpener,
} from "~/primitives/createPushNav"

describe("createPushNav", () => {
  beforeEach(() => {
    navigateSpy.mockClear()
    window.history.replaceState(null, "", "/")
    currentPathname = "/"
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetPushNavOpener()
  })

  afterEach(() => {
    resetRegistry()
    resetBootstrap()
  })

  it("detailOpen is false when the route matches only the list pattern", () => {
    createRoot((dispose) => {
      const nav = createPushNav()
      expect(nav.detailOpen()).toBe(false)
      dispose()
    })
  })

  it("pushDetail navigates to the given path and detailOpen becomes true", () => {
    createRoot((dispose) => {
      const nav = createPushNav()
      nav.pushDetail("/threads/thread-1")
      expect(navigateSpy).toHaveBeenCalledWith(
        "/threads/thread-1",
        expect.objectContaining({ state: expect.anything() }),
      )
      // The navigation stub does not move the router, so mirror what the real
      // router would report and assert the derived boolean off the route.
      currentPathname = "/threads/thread-1"
      expect(nav.detailOpen()).toBe(true)
      dispose()
    })
  })

  it("popDetail invokes real browser back navigation, not a local only flag reset", () => {
    createRoot((dispose) => {
      currentPathname = "/threads/thread-1"
      // The spy stands in for the router, so mirror what a real pushDetail
      // would have left in the history entry.
      window.history.pushState({ pushNavDetail: true }, "", "/threads/thread-1")
      const nav = createPushNav()
      expect(nav.detailOpen()).toBe(true)
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith(-1)
      dispose()
    })
  })

  it("popDetail on a deep link with no pushed history goes UP to the Chats list, replacing the entry", () => {
    createRoot((dispose) => {
      currentPathname = "/threads/thread-1"
      window.history.replaceState(null, "", "/threads/thread-1")
      const nav = createPushNav()
      nav.popDetail()
      // Not `/threads`: no screen answers it, and the shell drew a dead page.
      expect(navigateSpy).toHaveBeenCalledWith("/chats", { replace: true })
      expect(navigateSpy).not.toHaveBeenCalledWith(-1)
      dispose()
    })
  })

  it("a conversation opened from a push tap goes back to the Chats list, cold or warm", () => {
    // The mobile shell routes a tap by pushing the route with no state of ours
    // and firing popstate (apps/mobile/src/deep-link.ts, historyNavigator):
    // cold, over the boot entry; warm, over whatever screen was open.
    for (const before of ["/", "/work"]) {
      navigateSpy.mockClear()
      window.history.replaceState(null, "", before)
      window.history.pushState({}, "", "/threads/thread-1")
      currentPathname = "/threads/thread-1"
      createRoot((dispose) => {
        const nav = createPushNav()
        expect(nav.detailOpen()).toBe(true)
        expect(nav.backLabel()).toBe("Chats")
        nav.popDetail()
        expect(navigateSpy.mock.calls).toEqual([["/chats", { replace: true }]])
        dispose()
      })
    }
  })

  it("a task opened from a notification goes back to Projects, not to a project named 'tasks'", () => {
    const stub = (urlPattern: string, label: string) =>
      ({
        component: (() => null) as any,
        urlPattern,
        defaultLabel: label,
        icon: undefined,
        sidebar: null,
      }) as any
    registerTabType("projects:home", { ...stub("/projects", "Projects"), singleton: true })
    registerTabType("projects:project", stub("/projects/:entityId", "Project"))
    registerTabType("projects:task", stub("/projects/tasks/:entityId", "Task"))
    window.history.replaceState(null, "", "/projects/tasks/task-9")
    currentPathname = "/projects/tasks/task-9"
    createRoot((dispose) => {
      const nav = createPushNav()
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith("/projects", { replace: true })
      dispose()
    })
  })

  it("a label pushed from Chats does not outlive its conversation", () => {
    // A thread pushed from Chats and left through the tab bar used to name
    // the NEXT detail's back control: "< Chats" on an agent opened from You.
    window.history.replaceState(null, "", "/chats")
    currentPathname = "/chats"
    createRoot((dispose) => {
      const nav = createPushNav()
      nav.pushDetail("/threads/thread-1", { fromLabel: "From Chats" })
      currentPathname = "/threads/thread-1"
      expect(nav.backLabel()).toBe("From Chats")
      // Left through the tab bar, then another conversation, reached elsewhere.
      currentPathname = "/threads/thread-2"
      expect(nav.backLabel()).toBe("Chats")
      dispose()
    })
  })

  it("an agent opened from You goes back to You, labelled You", () => {
    resetTabStore()
    window.history.replaceState(null, "", "/agents/self")
    currentPathname = "/agents/self"
    createRoot((dispose) => {
      const nav = createPushNav()
      openDetailFrom({ label: "You", returnTo: "/settings" }, () =>
        openTab({ type: "agents:agent", entityId: "self", label: "Agent" }),
      )
      expect(nav.detailOpen()).toBe(true)
      expect(nav.backLabel()).toBe("You")
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith("/settings", { replace: true })
      // Popped: the record is spent, a later deep link goes to the parent.
      navigateSpy.mockClear()
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith("/work", { replace: true })
      dispose()
    })
    resetTabStore()
  })

  // iOS re-walk N2: a module root opened from the Work list (Help, Projects)
  // is no detail route, and had no back control and no edge swipe.
  it("a screen opened from the Work list goes back to it, labelled Work", () => {
    currentPathname = "/help"
    createRoot((dispose) => {
      const nav = createPushNav()
      expect(nav.detailOpen()).toBe(false)
      openFromWork(
        (key) => (key === "kernel.phoneTabWork" ? "Work" : key),
        () => openTab({ type: "kernel:help", entityId: "help", label: "Help" }),
      )
      expect(nav.detailOpen()).toBe(true)
      expect(nav.backLabel()).toBe("Work")
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith("/work", { replace: true })
      // Spent: the help root on its own is a root screen again.
      expect(nav.detailOpen()).toBe(false)
      dispose()
    })
    resetTabStore()
  })

  it("a detail pushed over a screen opened from Work hands its way back to Work on return", () => {
    currentPathname = "/projects"
    createRoot((dispose) => {
      const nav = createPushNav()
      openFromWork(
        () => "Work",
        () => openTab({ type: "kernel:help", entityId: "help", label: "Help" }),
      )
      window.history.replaceState(null, "", "/projects")
      nav.pushDetail("/threads/thread-1", { fromLabel: "Projects" })
      currentPathname = "/threads/thread-1"
      window.history.pushState({ pushNavDetail: true }, "", "/threads/thread-1")
      expect(nav.backLabel()).toBe("Projects")
      nav.popDetail()
      expect(navigateSpy).toHaveBeenLastCalledWith(-1)
      currentPathname = "/projects"
      expect(nav.detailOpen()).toBe(true)
      expect(nav.backLabel()).toBe("Work")
      dispose()
    })
    resetTabStore()
  })

  it("an agent page reached by a link goes back to Work, never to the /agents redirect", () => {
    // `/agents` redirects straight back to the viewer's own agent: Back there
    // did nothing at all.
    expect(parentRouteForPath("/agents/@my-agent")).toBe("/work")
  })

  it("pushDetail marks the entry it pushes so popDetail can tell it apart", () => {
    createRoot((dispose) => {
      const nav = createPushNav()
      nav.pushDetail("/threads/thread-1")
      const [, options] = navigateSpy.mock.calls[0]
      expect(options?.state).toBeTruthy()
      dispose()
    })
  })
})

describe("isDetailRoute - only an entity tail is a detail route", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    resetRegistry()
    resetBootstrap()
  })

  function register(type: string, urlPattern: string) {
    registerTabType(type, {
      component: (() => null) as any,
      urlPattern,
      defaultLabel: type,
      icon: undefined,
      sidebar: null,
    } as any)
  }

  it("a dynamic entity tail is a detail route", () => {
    expect(isDetailRoute("/threads/thread-1")).toBe(true)
  })

  it("a list filter segment is NOT a detail route", () => {
    register("invoicing-documents", "/invoicing/documents/:typeFilter")
    expect(isDetailRoute("/invoicing/documents/quotes")).toBe(false)
  })

  it("a descriptively named id tail is a detail route", () => {
    register("invoicing-editor", "/invoicing/editor/:documentId")
    expect(isDetailRoute("/invoicing/editor/doc-7")).toBe(true)
  })

  it("a static route is never a detail route", () => {
    expect(isDetailRoute("/search")).toBe(false)
  })

  it("every registered url pattern classifies as the pinned table says", () => {
    // Pin the rule against every pattern the repo registers today. A new
    // pattern that is neither an entity tail nor a list tail must be added
    // here deliberately, not classified by accident.
    const expected: Record<string, boolean> = {
      "/": false,
      // P4c-T39 retired the flat agent screens and their detail tabs; the
      // agent app registers the directory and one page per agent instead.
      "/agents": false,
      "/chats": false,
      "/agents/:entityId": true,
      // One app draft in the builder.
      "/apps/builder/:entityId": true,
      // A singleton list screen, no entity tail: pushing into it is a tab
      // switch, not a detail push.
      "/approvals": false,
      "/contacts": false,
      // The Dashboards page: the list of the viewer's dashboards.
      "/dashboards": false,
      // One saved dashboard (kernel:dashboard).
      "/dashboard/:entityId": true,
      // One dashboard table (kernel:dashboard_table).
      "/dashboard-table/:entityId": true,
      "/detail/:entityId+": true,
      // The Help tab: one screen, its page picked inside it.
      "/help": false,
      // The Sessions app's import take-over: one screen, no entity tail.
      "/import-sessions": false,
      "/invoicing/documents/:typeFilter": false,
      "/invoicing/editor/:documentId": true,
      "/knowledge": false,
      "/knowledge/documents/:entityId": true,
      "/knowledge/settings/synced-sources/add": false,
      "/knowledge/sources/:entityId": true,
      "/mail/:entityId": true,
      "/sales/:entityId": true,
      "/search": false,
      // The Sessions app: its list screen, and one computer session (kernel:session).
      "/sessions": false,
      "/sessions/:entityId": true,
      "/settings": false,
      // A staff signer's own Read and sign (kernel:client_action).
      "/sign/:entityId": true,
      "/support/:entityId": true,
      "/threads/:entityId": true,
      "/tickets/:entityId": true,
      "/work": false,
    }
    for (const [pattern, isDetail] of Object.entries(expected)) {
      expect({ pattern, isDetail: patternIsDetail(pattern) }).toEqual({ pattern, isDetail })
    }
    // Every kernel registered pattern is covered by the table above.
    for (const reg of Object.values(getTabTypes())) {
      expect([reg.urlPattern, Object.hasOwn(expected, reg.urlPattern)]).toEqual([
        reg.urlPattern,
        true,
      ])
    }
  })
})

describe("parentRouteForPath - Back from a deep-linked detail lands on a real screen", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    resetRegistry()
    resetBootstrap()
  })

  it("names the list each kernel detail belongs to", () => {
    expect(parentRouteForPath("/threads/t-1")).toBe("/chats")
    expect(parentRouteForPath("/sessions/s-1")).toBe("/sessions")
    expect(parentRouteForPath("/dashboard/d-1")).toBe("/dashboards")
    expect(parentRouteForPath("/dashboard-table/x-1")).toBe("/dashboards")
    // A multi-segment entity tail with no list above it: Home.
    expect(parentRouteForPath("/detail/tickets/ticket/42")).toBe("/")
  })

  it("every kernel detail's parent is a route the shell renders, never an unmatched one", () => {
    for (const reg of Object.values(getTabTypes())) {
      if (!patternIsDetail(reg.urlPattern)) continue
      const sample = patternToUrl(reg.urlPattern, "sample-1")
      const parent = parentRouteForPath(sample)
      expect([sample, parent, urlToTabInfo(parent) !== null]).toEqual([sample, parent, true])
      expect([sample, isDetailRoute(parent)]).toEqual([sample, false])
    }
  })
})

describe("masterRouteFor", () => {
  it("drops the entity tail of a detail pattern", () => {
    expect(masterRouteFor("/tickets/:entityId")).toBe("/tickets")
    expect(masterRouteFor("/agent/chat/:entityId")).toBe("/agent/chat")
    expect(masterRouteFor("/detail/:entityId+")).toBe("/detail")
  })

  it("falls back to the root when nothing is left", () => {
    expect(masterRouteFor("/:entityId")).toBe("/")
    expect(masterRouteFor("/")).toBe("/")
  })
})
