// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Who issues what" in the issuer settings: without Stripe only the two other streams show, each
// always not billed from Stripe; the card stream's issuer reads as decided or not; and the word
// Checked shows only after a person said Stripe's own emails are off.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import { emailsLine, InvoicingIssuerStreams, streamRow } from "./IssuerStreams"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("who issues what, in the issuer settings", () => {
  it("without Stripe the section shows the two other streams, each always not billed from Stripe", () => {
    // What issuer_stream_get returns for an org with no Stripe connection.
    const streams = [
      { stream: "transfer" as const, issuer: "liaison" as const, notBilledFromStripe: true },
      { stream: "one_off" as const, issuer: "liaison" as const, notBilledFromStripe: true },
    ]
    expect(streams.map(streamRow)).toEqual([
      { name: "Recurring by transfer", who: "Always: not billed from Stripe" },
      { name: "One-off invoices", who: "Always: not billed from Stripe" },
    ])
    expect(streamRow({ stream: "card", issuer: "undecided" }).who).toBe("Not decided yet")
    expect(streamRow({ stream: "card", issuer: "stripe" }).who).toBe("Stripe invoices")
    // A block of the existing issuer settings section, not a page or a sidebar row.
    const section = (manifest as any).settings.sections.find((s: any) => s.id === "issuers")
    expect(section.blocks.map((b: any) => b.component)).toContain("InvoicingIssuerStreams")
    expect(typeof InvoicingIssuerStreams).toBe("function")
    // French readers get the same lines.
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
  })

  it("the word Checked never shows without a person's click", () => {
    expect(emailsLine(null)).toBeNull()
    const unknown = emailsLine({ state: "unknown", confirmedBy: null, confirmedAt: null })
    expect(unknown).toContain("Please check in Stripe")
    expect(unknown).not.toMatch(/checked/i)
    // A confirmed state with no time is not a person's statement.
    expect(emailsLine({ state: "confirmed", confirmedBy: "u1", confirmedAt: null })).not.toMatch(/^Checked/)
    expect(emailsLine({ state: "confirmed", confirmedBy: "u1", confirmedAt: "2026-11-03T10:00:00.000Z" }, "en-GB")).toMatch(/^Checked by a person on 3 Nov 2026/)
    // No other string of the block says Checked.
    const source = readFileSync(join(import.meta.dir, "IssuerStreams.tsx"), "utf8")
    expect(source.match(/"Checked[^"]*"/g)).toEqual(['"Checked by a person on {{day}}. Liaison cannot read this setting, so check again if someone changes it."'])
  })
})
