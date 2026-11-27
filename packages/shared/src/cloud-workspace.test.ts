// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import {
  buildCloudDomain,
  cloudPageUrl,
  DEFAULT_CLOUD_DOMAIN,
  resolveCloudDomain,
  workspaceAddress,
  workspaceSlugFromAddress,
  workspaceSlugFromInput,
} from "./cloud-workspace"

const D = "liaison.sh"

describe("the build's cloud domain", () => {
  it("is liaison.sh when the build names none", () => {
    expect(DEFAULT_CLOUD_DOMAIN).toBe("liaison.sh")
    expect(resolveCloudDomain(undefined)).toBe("liaison.sh")
    expect(resolveCloudDomain(null)).toBe("liaison.sh")
    expect(buildCloudDomain()).toBe("liaison.sh")
  })
  it("takes a fork's own domain, normalised", () => {
    expect(resolveCloudDomain(" Cloud.Example.COM. ")).toBe("cloud.example.com")
  })
  it("is off for an empty value or something that is not a domain", () => {
    expect(resolveCloudDomain("")).toBeNull()
    expect(resolveCloudDomain("   ")).toBeNull()
    expect(resolveCloudDomain("localhost")).toBeNull()
    expect(resolveCloudDomain("https://cloud.example.com")).toBeNull()
  })
})

describe("what a person types as a workspace", () => {
  it("takes a bare name, any case, trimmed", () => {
    expect(workspaceSlugFromInput("acme", D)).toBe("acme")
    expect(workspaceSlugFromInput("  Acme-Labs ", D)).toBe("acme-labs")
  })
  it("takes a pasted host or full URL under the cloud domain", () => {
    expect(workspaceSlugFromInput("acme.liaison.sh", D)).toBe("acme")
    expect(workspaceSlugFromInput("https://acme.liaison.sh/login?x=1", D)).toBe("acme")
    expect(workspaceSlugFromInput("HTTPS://ACME.LIAISON.SH/", D)).toBe("acme")
  })
  it("refuses empty input, other domains and names that are not one label", () => {
    for (const bad of [
      "",
      "  ",
      "acme.example.com",
      "a b",
      "-acme",
      "acme-",
      "a_b",
      "x".repeat(64),
    ]) {
      expect(workspaceSlugFromInput(bad, D)).toBeNull()
    }
  })
  it("builds the workspace address", () => {
    expect(workspaceAddress("acme", D)).toBe("https://acme.liaison.sh")
  })
})

describe("which server addresses are cloud workspaces", () => {
  it("names the workspace of an exact cloud address", () => {
    expect(workspaceSlugFromAddress("https://acme.liaison.sh", D)).toBe("acme")
    expect(workspaceSlugFromAddress("https://acme.liaison.sh/", D)).toBe("acme")
  })
  it("leaves every other address to the address screen", () => {
    for (const other of [
      "http://acme.liaison.sh",
      "https://acme.liaison.sh:8443",
      "https://acme.liaison.sh/path",
      "https://a.b.liaison.sh",
      "https://liaison.sh",
      "https://acme.example.com",
      "not a url",
    ]) {
      expect(workspaceSlugFromAddress(other, D)).toBeNull()
    }
  })
})

describe("the cloud's own pages", () => {
  it("are under /fr in French and at the root otherwise", () => {
    expect(cloudPageUrl(D, "login", "en")).toBe("https://liaison.sh/login")
    expect(cloudPageUrl(D, "signup", "fr")).toBe("https://liaison.sh/fr/signup")
    expect(cloudPageUrl(D, "login", "fr-FR")).toBe("https://liaison.sh/fr/login")
    expect(cloudPageUrl(D, "find-workspace", "en")).toBe("https://liaison.sh/find-workspace")
    expect(cloudPageUrl(D, "find-workspace", "fr")).toBe("https://liaison.sh/fr/find-workspace")
  })
})
