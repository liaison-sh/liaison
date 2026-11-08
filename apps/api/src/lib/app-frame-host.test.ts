// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  appFrameHostFor,
  appFrameHostOf,
  appFrameSource,
  appFrameTemplateProblems,
  framedFirstPartyApps,
  splitFrameLabel,
} from "~/lib/app-frame-host"
import { appFrameTemplateShapeOk, env } from "~/lib/env"
import { hostBindingOf } from "~/lib/org-host"
import { contentSecurityPolicy } from "~/middleware/security-headers"
import { registrableDomain } from "~/modules/demo/demo-email"

const TEMPLATE = "https://{app}--{org}.usercontent.test"
const saved = {
  frame: env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE,
  org: env.LIAISON_ORG_HOST_TEMPLATE,
  framed: env.LIAISON_FRAMED_APPS,
}

beforeEach(() => {
  env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE = TEMPLATE
})
afterEach(() => {
  env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE = saved.frame
  env.LIAISON_ORG_HOST_TEMPLATE = saved.org
  env.LIAISON_FRAMED_APPS = saved.framed
})

describe("template shape", () => {
  it("takes exactly one {app}--{org} label in an http(s) origin", () => {
    expect(appFrameTemplateShapeOk(TEMPLATE)).toBe(true)
    expect(appFrameTemplateShapeOk("http://{app}--{org}.localhost:3000")).toBe(true)
    expect(appFrameTemplateShapeOk("https://{app}.{org}.usercontent.test")).toBe(false)
    expect(appFrameTemplateShapeOk("https://{app}--{org}.usercontent.test/")).toBe(false)
    expect(appFrameTemplateShapeOk("https://{app}--{org}.usercontent.test/x")).toBe(false)
    expect(appFrameTemplateShapeOk("https://{app}--{org}-{app}--{org}.test")).toBe(false)
    expect(appFrameTemplateShapeOk("https://x{app}--{org}.test")).toBe(false)
    expect(appFrameTemplateShapeOk("ftp://{app}--{org}.test")).toBe(false)
  })
})

describe("frame hosts", () => {
  it("split on the last --, and neither side may hold another", () => {
    expect(splitFrameLabel("shopify--acme")).toEqual({ app: "shopify", slug: "acme" })
    expect(splitFrameLabel("shopify--ac--me")).toBeNull()
    expect(appFrameHostFor("shopify", "ac--me")).toBeNull()
    expect(splitFrameLabel("shopify-acme")).toBeNull()
    expect(splitFrameLabel("--acme")).toBeNull()
    expect(appFrameHostOf("boxtal--acme-co.usercontent.test")).toEqual({
      app: "boxtal",
      slug: "acme-co",
    })
    expect(appFrameHostOf("BOXTAL--ACME.usercontent.test")).toEqual({ app: "boxtal", slug: "acme" })
    expect(appFrameHostOf("boxtal--acme.other.test")).toBeNull()
    expect(appFrameHostOf("acme.usercontent.test")).toBeNull()
  })

  it("names one label per app and org, and none past 63 characters (the opaque frame stays)", () => {
    expect(appFrameHostFor("shopify", "acme")).toBe("shopify--acme.usercontent.test")
    expect(appFrameHostFor("ab--c", "acme")).toBeNull()
    const longSlug = "a".repeat(50)
    expect(appFrameHostFor("metrics-o0123abcd", longSlug)).toBe(null)
    expect(appFrameHostFor("kpi", longSlug)).toBe(`kpi--${longSlug}.usercontent.test`)
  })

  it("is resolved before the org template, as a binding of its own", () => {
    env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.usercontent.test"
    expect(hostBindingOf("shopify--acme.usercontent.test")).toEqual({
      kind: "app-frame",
      app: "shopify",
      slug: "acme",
      host: "shopify--acme.usercontent.test",
    })
    // Without an org template the frame host is still a frame host, never `unbound`.
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    expect(hostBindingOf("shopify--acme.usercontent.test").kind).toBe("app-frame")
    expect(hostBindingOf("liaison.example.com").kind).toBe("unbound")
  })

  it("the page's frame-src names the frame domain only while the template is set", () => {
    expect(appFrameSource()).toBe("https://*.usercontent.test")
    expect(contentSecurityPolicy({ scriptHashes: [], storageOrigin: null })).toContain(
      "frame-src 'self' blob: https://*.usercontent.test",
    )
    // Never on API responses, which keep frame-ancestors 'none' and no frame-src.
    expect(contentSecurityPolicy({ storageOrigin: null })).not.toContain("usercontent")
    env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE = undefined
    expect(appFrameSource()).toBeNull()
    expect(contentSecurityPolicy({ scriptHashes: [], storageOrigin: null })).not.toContain(
      "usercontent",
    )
  })

  it("frames first-party apps on their own origin only when listed and the template is set", () => {
    env.LIAISON_FRAMED_APPS = "shopify, boxtal,Bad Name"
    expect([...framedFirstPartyApps()].sort()).toEqual(["boxtal", "shopify"])
    env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE = undefined
    expect(framedFirstPartyApps().size).toBe(0)
  })
})

describe("boot checks", () => {
  const base = {
    LIAISON_APP_FRAME_ORIGIN_TEMPLATE: TEMPLATE,
    BASE_URL: "https://cell-1.liaison.example",
    LIAISON_ORG_HOST_TEMPLATE: "https://{slug}.liaison.example",
  }

  it("passes a frame domain of its own", () => {
    const managed = appFrameTemplateProblems(
      { ...base, LIAISON_EDITION: "managed" },
      registrableDomain,
    )
    expect(managed).toEqual({ refuse: [], warn: [] })
  })

  it("refuses a managed cell without an org template", () => {
    const { refuse } = appFrameTemplateProblems(
      { ...base, LIAISON_EDITION: "managed", LIAISON_ORG_HOST_TEMPLATE: undefined },
      registrableDomain,
    )
    expect(refuse.join(" ")).toContain("needs LIAISON_ORG_HOST_TEMPLATE")
  })

  it("refuses the app's own registrable domain on managed, warns on self-hosted", () => {
    const sameSite = {
      ...base,
      LIAISON_APP_FRAME_ORIGIN_TEMPLATE: "https://{app}--{org}.apps.liaison.example",
    }
    const managed = appFrameTemplateProblems(
      { ...sameSite, LIAISON_EDITION: "managed" },
      registrableDomain,
    )
    expect(managed.refuse.join(" ")).toContain("same registrable domain (liaison.example)")
    const selfHosted = appFrameTemplateProblems(sameSite, registrableDomain)
    expect(selfHosted.refuse).toEqual([])
    expect(selfHosted.warn.join(" ")).toContain("BASE_URL and LIAISON_ORG_HOST_TEMPLATE")
  })

  it("refuses templates that can name one host, in every edition", () => {
    const overlap = appFrameTemplateProblems(
      {
        BASE_URL: "https://liaison.other.example",
        LIAISON_ORG_HOST_TEMPLATE: "https://{slug}.usercontent.test",
        LIAISON_APP_FRAME_ORIGIN_TEMPLATE: TEMPLATE,
      },
      registrableDomain,
    )
    expect(overlap.refuse.join(" ")).toContain("can name the same host")
  })

  it("refuses a BASE_URL the frame template names, and a template whose label is not first", () => {
    const named = appFrameTemplateProblems(
      { BASE_URL: "https://a--b.usercontent.test", LIAISON_APP_FRAME_ORIGIN_TEMPLATE: TEMPLATE },
      registrableDomain,
    )
    expect(named.refuse.join(" ")).toContain("BASE_URL is a host")
    const notFirst = appFrameTemplateProblems(
      {
        BASE_URL: "https://liaison.other.example",
        LIAISON_APP_FRAME_ORIGIN_TEMPLATE: "https://x.{app}--{org}.usercontent.test",
      },
      registrableDomain,
    )
    expect(notFirst.refuse.join(" ")).toContain("must start its host")
  })
})

describe("the frame policy's images", () => {
  it("adds the manifest's https image hosts and nothing else", async () => {
    const { appFramePolicy } = await import("@liaison/shared")
    const policy = appFramePolicy("n", {
      imgSources: [
        "https://cdn.shopify.com",
        "https://*.example.com",
        "http://x.test",
        "*",
        "'unsafe-inline'",
      ],
    })
    expect(policy).toContain("img-src data: blob: https://cdn.shopify.com https://*.example.com;")
    expect(appFramePolicy("n")).toContain("img-src data: blob:;")
  })
})
