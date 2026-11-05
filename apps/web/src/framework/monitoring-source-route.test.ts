// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A monitoring source page is addressed `/monitoring/source/<encoded id>`, and
// a source id may hold a slash or a space (`grafana/prod`, `aws eu`). Through
// the real shell chain (the pathname the router reports, the kernel pattern
// match, the tab, the tab's URL, the page's decode) such an id must open its
// own page, not a 404 or a sibling route. Helpers imported by relative path:
// no new package dependency.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decodeSourceId, sourcePath } from "../../../../bundled-apps/monitoring/src/ui/sources"
import { openTab, tabStore, tabToUrl } from "../modules/shell/tab-store"
import { registerTabType, unregisterTabType, urlToTabInfo } from "./app-registry"

const Stub = () => null
const TYPES = ["monitoring:source", "monitoring:dashboard"]

describe("monitoring source page route", () => {
  beforeEach(() => {
    registerTabType("monitoring:source", {
      component: Stub,
      sidebar: null,
      icon: Stub,
      urlPattern: "/monitoring/source/:id",
      defaultLabel: "Source",
    })
    // The app's own bare page, which a mismatched path would fall back onto.
    registerTabType("monitoring:dashboard", {
      component: Stub,
      sidebar: null,
      icon: Stub,
      urlPattern: "/monitoring",
      defaultLabel: "Monitoring",
    })
  })
  afterEach(() => {
    for (const t of TYPES) unregisterTabType(t)
  })

  for (const id of ["grafana/prod", "aws eu", "a/b c#1?x", "100%", "plain-id"]) {
    it(`opens the page of ${JSON.stringify(id)}`, () => {
      const path = sourcePath(id)
      // What the router reports as location.pathname for that link.
      const pathname = new URL(path, "http://liaison.test").pathname
      const info = urlToTabInfo(pathname)
      expect(info?.type).toBe("monitoring:source")
      expect(decodeSourceId(info?.entityId ?? "")).toBe(id)

      openTab({ type: info!.type, entityId: info!.entityId, label: info!.label })
      const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
      // The tab's URL is the link itself, so the URL sync never rewrites it.
      expect(tab && tabToUrl(tab)).toBe(pathname)
    })
  }
})
