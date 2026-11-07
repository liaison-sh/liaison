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

import { getTabTypes, registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import {
  createPushNav,
  isDetailRoute,
  masterRouteFor,
  patternIsDetail,
} from "~/primitives/createPushNav"

describe("createPushNav", () => {
  beforeEach(() => {
    navigateSpy.mockClear()
    window.history.replaceState(null, "", "/")
    currentPathname = "/"
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
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

  it("popDetail on a deep link with no pushed history goes to the master route", () => {
    createRoot((dispose) => {
      currentPathname = "/threads/thread-1"
      window.history.replaceState(null, "", "/threads/thread-1")
      const nav = createPushNav()
      nav.popDetail()
      expect(navigateSpy).toHaveBeenCalledWith("/threads")
      expect(navigateSpy).not.toHaveBeenCalledWith(-1)
      dispose()
    })
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
      // A singleton list screen, no entity tail: pushing into it is a tab
      // switch, not a detail push.
      "/approvals": false,
      "/contacts": false,
      // One saved dashboard (kernel:dashboard).
      "/dashboard/:entityId": true,
      "/detail/:entityId+": true,
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
