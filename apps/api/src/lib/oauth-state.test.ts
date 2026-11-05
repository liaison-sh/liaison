// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env, envSchema } from "~/lib/env"
import { oauthStateFor, oauthStateSlug, stateSlugFitsHost } from "~/lib/oauth-state"
import { oauthRedirectBaseUrl } from "~/lib/org-public-url"

const saved = { base: env.BASE_URL, redirect: env.LIAISON_OAUTH_REDIRECT_BASE }

afterEach(() => {
  env.BASE_URL = saved.base
  env.LIAISON_OAUTH_REDIRECT_BASE = saved.redirect
})

describe("oauthRedirectBaseUrl", () => {
  it("unset: BASE_URL exactly as configured", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = undefined
    env.BASE_URL = "https://liaison.example.com/"
    expect(oauthRedirectBaseUrl()).toBe("https://liaison.example.com/")
  })
  it("set: the central redirect host", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = "https://auth.example.com"
    expect(oauthRedirectBaseUrl()).toBe("https://auth.example.com")
  })
})

describe("LIAISON_OAUTH_REDIRECT_BASE schema", () => {
  const parse = (v: string) =>
    envSchema.safeParse({ ...process.env, LIAISON_OAUTH_REDIRECT_BASE: v })
  it("takes an http(s) origin", () => {
    const r = parse("https://auth.example.com")
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.LIAISON_OAUTH_REDIRECT_BASE).toBe("https://auth.example.com")
  })
  it("empty reads as unset", () => {
    const r = parse("")
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.LIAISON_OAUTH_REDIRECT_BASE).toBeUndefined()
  })
  it("refuses a path, a trailing slash or another scheme", () => {
    for (const bad of [
      "https://auth.example.com/",
      "https://auth.example.com/x",
      "ftp://auth.example.com",
      "auth.example.com",
    ]) {
      expect(parse(bad).success).toBe(false)
    }
  })
})

describe("OAuth state with an org prefix", () => {
  it("unset: the random token alone, untouched", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = undefined
    expect(oauthStateFor("acme", "AbC_-123")).toBe("AbC_-123")
  })
  it("set: <slug>.<random>, parsed back to the slug", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = "https://auth.example.com"
    const state = oauthStateFor("acme-2", "AbC_-123")
    expect(state).toBe("acme-2.AbC_-123")
    expect(oauthStateSlug(state)).toBe("acme-2")
  })
  it("set: refuses to mint a state for a slug that cannot be a host label", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = "https://auth.example.com"
    expect(() => oauthStateFor("Acme.evil", "x")).toThrow()
    expect(() => oauthStateFor(undefined, "x")).toThrow()
  })
  it("rejects every malformed state", () => {
    for (const bad of [
      "",
      "nodot",
      ".random",
      "acme.",
      "Acme.random",
      "acme..random",
      "-acme.random",
      "acme-.random",
      "acme.ran.dom",
      "acme.ran dom",
      "ac_me.random",
      "acme.ran%2Edom",
      `${"a".repeat(64)}.random`,
    ]) {
      expect(oauthStateSlug(bad)).toBeNull()
    }
  })
  it("stateSlugFitsHost: unset always fits; set needs a well-formed state of the host's org", () => {
    env.LIAISON_OAUTH_REDIRECT_BASE = undefined
    expect(stateSlugFitsHost("anything", { kind: "non-org" })).toBe(true)
    env.LIAISON_OAUTH_REDIRECT_BASE = "https://auth.example.com"
    const org = { kind: "org", slug: "acme", origin: "https://acme.example.com" } as const
    expect(stateSlugFitsHost("acme.r4nd0m", org)).toBe(true)
    expect(stateSlugFitsHost("other.r4nd0m", org)).toBe(false)
    expect(stateSlugFitsHost("r4nd0m", org)).toBe(false)
    expect(stateSlugFitsHost("acme.r4nd0m", { kind: "non-org" })).toBe(false)
    // No org hosts on this instance: the prefix must still be well formed.
    expect(stateSlugFitsHost("acme.r4nd0m", { kind: "unbound" })).toBe(true)
    expect(stateSlugFitsHost("r4nd0m", { kind: "unbound" })).toBe(false)
  })
})
