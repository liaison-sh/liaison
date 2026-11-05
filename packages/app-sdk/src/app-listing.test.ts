// SPDX-License-Identifier: FSL-1.1-ALv2
// Store listing on a `.liaisonapp` manifest: shape, the source-available rule
// (https sourceRepository + SPDX license) and the no-pricing rule.
import { describe, expect, it } from "bun:test"
import { isSpdxLicenseExpression, listingDeclarationErrors } from "./app-listing"
import { packageManifestSchema } from "./package-format"

const LISTING = {
  publisher: "Example Labs",
  category: "Support" as const,
  icon: "ticket",
  summary: "Answer customer requests from one shared queue.",
  screenshots: ["https://example.com/shot-1.png"],
  sourceRepository: "https://github.com/example/helpdesk",
}

function pkg(extra: Record<string, unknown>) {
  return {
    name: "my-app",
    version: "1.0.0",
    packageFormat: 1,
    license: "MIT",
    scopes: ["my-app:items:read"],
    ...extra,
  }
}

function issues(input: unknown): string {
  const r = packageManifestSchema.safeParse(input)
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
}

describe("package manifest listing", () => {
  it("accepts a complete listing and keeps it on the parsed manifest", () => {
    const r = packageManifestSchema.safeParse(pkg({ listing: LISTING }))
    expect(r.success).toBe(true)
    expect(r.success && r.data.listing).toEqual(LISTING)
  })

  it("accepts a manifest with no listing (an Unlisted URL install)", () => {
    expect(packageManifestSchema.safeParse(pkg({})).success).toBe(true)
  })

  it("accepts a listing without the optional publisher and screenshots", () => {
    const { publisher: _p, screenshots: _s, ...minimal } = LISTING
    expect(packageManifestSchema.safeParse(pkg({ listing: minimal })).success).toBe(true)
  })

  it.each(["price", "pricing", "plan", "Price"])("refuses a top-level listing.%s key", (key) => {
    const message = issues(pkg({ listing: { ...LISTING, [key]: "9 EUR/month" } }))
    expect(message).toContain(`listing.${key}`)
    expect(message).toContain("no price, pricing or plan")
  })

  it("refuses a pricing key nested anywhere under the listing", () => {
    const message = issues(
      pkg({ listing: { ...LISTING, screenshots: [{ url: "https://x.test/a.png", plan: "pro" }] } }),
    )
    expect(message).toContain("listing.screenshots.0.plan")
    expect(message).toContain("no price, pricing or plan")
  })

  it("refuses a listing without sourceRepository", () => {
    const { sourceRepository: _r, ...noRepo } = LISTING
    expect(issues(pkg({ listing: noRepo }))).toContain("listing.sourceRepository")
  })

  it("refuses a non-https sourceRepository", () => {
    const message = issues(
      pkg({ listing: { ...LISTING, sourceRepository: "http://github.com/example/helpdesk" } }),
    )
    expect(message).toContain("sourceRepository must be an https URL")
  })

  it("refuses an unknown category, a non-kebab icon and an unknown listing key", () => {
    expect(issues(pkg({ listing: { ...LISTING, category: "Games" } }))).toContain(
      "listing.category",
    )
    expect(issues(pkg({ listing: { ...LISTING, icon: "TicketIcon" } }))).toContain("listing.icon")
    expect(issues(pkg({ listing: { ...LISTING, rating: 5 } }))).toContain("listing")
  })

  it("refuses a listed package whose license is not an SPDX expression", () => {
    expect(issues(pkg({ license: "UNLICENSED", listing: LISTING }))).toContain(
      "a listed app needs a top-level SPDX license",
    )
    expect(issues(pkg({ license: "see LICENSE file", listing: LISTING }))).toContain(
      "a listed app needs a top-level SPDX license",
    )
  })
})

describe("listingDeclarationErrors", () => {
  it("requires a top-level license when a listing is present", () => {
    expect(listingDeclarationErrors({ listing: LISTING })).toEqual([
      "license: a listed app needs a top-level SPDX license (e.g. 'MIT', 'Apache-2.0', 'FSL-1.1-ALv2')",
    ])
  })

  it("yields nothing for an unlisted manifest", () => {
    expect(listingDeclarationErrors({})).toEqual([])
  })
})

describe("isSpdxLicenseExpression", () => {
  it.each([
    "MIT",
    "Apache-2.0",
    "FSL-1.1-ALv2",
    "MIT OR Apache-2.0",
    "GPL-2.0-only WITH Classpath-exception-2.0",
  ])("accepts %s", (id) => expect(isSpdxLicenseExpression(id)).toBe(true))

  it.each(["", "NOASSERTION", "NONE", "UNLICENSED", "MIT OR UNLICENSED", "free for all", "MIT;rm"])(
    "refuses %p",
    (id) => expect(isSpdxLicenseExpression(id)).toBe(false),
  )
})
