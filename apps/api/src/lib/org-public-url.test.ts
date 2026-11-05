// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env, envSchema } from "~/lib/env"
import {
  instanceAppOrigin,
  orgAppBaseUrl,
  orgHostsEnabled,
  orgPublicBaseUrl,
  orgPublicBaseUrlForSlug,
} from "~/lib/org-public-url"

const saved = {
  template: env.LIAISON_ORG_HOST_TEMPLATE,
  base: env.BASE_URL,
  origins: env.ALLOWED_ORIGINS,
}

afterEach(() => {
  env.LIAISON_ORG_HOST_TEMPLATE = saved.template
  env.BASE_URL = saved.base
  env.ALLOWED_ORIGINS = saved.origins
})

describe("orgPublicBaseUrl without org hosts", () => {
  it("is BASE_URL exactly as configured, trailing slash and all", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    env.BASE_URL = "https://liaison.example.com/"
    expect(orgHostsEnabled()).toBe(false)
    expect(orgPublicBaseUrlForSlug("acme")).toBe("https://liaison.example.com/")
    expect(await orgPublicBaseUrl({ slug: "acme" })).toBe("https://liaison.example.com/")
    // An id reads nothing: no database is needed to answer.
    expect(await orgPublicBaseUrl("00000000-0000-0000-0000-000000000000")).toBe(
      "https://liaison.example.com/",
    )
  })

  it("web-app links use the first configured web origin, as before", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    env.ALLOWED_ORIGINS = "*, https://app.example.com ,https://other.example.com"
    expect(instanceAppOrigin()).toBe("https://app.example.com")
    expect(await orgAppBaseUrl({ slug: "acme" })).toBe("https://app.example.com")
    expect(await orgAppBaseUrl(null)).toBe("https://app.example.com")
    env.ALLOWED_ORIGINS = "*"
    expect(instanceAppOrigin()).toBe("http://localhost:5173")
  })
})

describe("orgPublicBaseUrl with org hosts", () => {
  it("fills the slug into the template", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
    expect(orgHostsEnabled()).toBe(true)
    expect(orgPublicBaseUrlForSlug("acme")).toBe("https://acme.example.com")
    expect(orgPublicBaseUrlForSlug("acme-north-2")).toBe("https://acme-north-2.example.com")
    expect(await orgPublicBaseUrl({ slug: "a-b" })).toBe("https://a-b.example.com")
    expect(await orgAppBaseUrl({ slug: "a-b" })).toBe("https://a-b.example.com")
  })

  it("web-app links with no org known stay on the instance's web origin", async () => {
    env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
    env.ALLOWED_ORIGINS = "https://app.example.com"
    expect(await orgAppBaseUrl(null)).toBe("https://app.example.com")
  })

  it("refuses a slug that cannot be a host label", () => {
    env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
    for (const slug of ["", "Acme", "-acme", "acme-", "a.b", "evil.com/x", "a_b", "x".repeat(64)]) {
      expect(() => orgPublicBaseUrlForSlug(slug)).toThrow("cannot name a host")
    }
  })
})

describe("LIAISON_ORG_HOST_TEMPLATE schema", () => {
  const base = {
    JWT_SECRET: "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4u",
    ENCRYPTION_KEY: "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3",
  }
  const parse = (v: string) => envSchema.safeParse({ ...base, LIAISON_ORG_HOST_TEMPLATE: v })

  it("accepts an origin with {slug} once in its host", () => {
    for (const v of ["https://{slug}.example.com", "http://{slug}.localhost:3000"]) {
      const r = parse(v)
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.LIAISON_ORG_HOST_TEMPLATE).toBe(v)
    }
  })

  it("reads empty as unset", () => {
    const r = parse("")
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.LIAISON_ORG_HOST_TEMPLATE).toBeUndefined()
  })

  it("refuses a path, a trailing slash, no slug, two slugs, a slug off the host or another scheme", () => {
    for (const v of [
      "https://{slug}.example.com/",
      "https://{slug}.example.com/app",
      "https://example.com",
      "https://{slug}.{slug}.example.com",
      "https://example.com/{slug}",
      "ftp://{slug}.example.com",
      "{slug}.example.com",
    ]) {
      expect(parse(v).success).toBe(false)
    }
  })
})
