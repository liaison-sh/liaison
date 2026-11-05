// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app runs in a QuickJS sandbox that has no `Intl`. Bun has it, so a parser that leans on
// `Intl.DisplayNames` passes here and fails in production: an invoice address ending in its
// country line ("Germany") was read with the country as the city and no postcode, and Boxtal
// refused the quote ("postal code required for DE"). These cases parse with `Intl` removed.
import { afterEach, describe, expect, it } from "bun:test"
import { parseInvoiceAddress, type RecipientAddressInput } from "./shipment"

const realIntl = globalThis.Intl

function withoutIntl<T>(fn: () => T): T {
  // biome-ignore lint/performance/noDelete: the sandbox has no Intl at all; undefined is not enough for `in` checks
  delete (globalThis as { Intl?: unknown }).Intl
  try {
    expect(typeof (globalThis as { Intl?: unknown }).Intl).toBe("undefined")
    return fn()
  } finally {
    ;(globalThis as { Intl?: unknown }).Intl = realIntl
  }
}

afterEach(() => {
  ;(globalThis as { Intl?: unknown }).Intl = realIntl
})

function parse(raw: string, iso: string): RecipientAddressInput | null {
  return withoutIntl(() => parseInvoiceAddress(raw, { name: "Kunde", email: null, countryIsoCode: iso }))
}

interface Case {
  iso: string
  lines: string[]
  want: Partial<RecipientAddressInput>
}

const CASES: Case[] = [
  { iso: "DE", lines: ["Hauptstraße 12", "10115 Berlin", "Germany"], want: { street: "Hauptstraße 12", postalCode: "10115", city: "Berlin" } },
  { iso: "DE", lines: ["Hauptstraße 12", "10115 Berlin", "Deutschland"], want: { postalCode: "10115", city: "Berlin" } },
  { iso: "DE", lines: ["Hauptstraße 12", "10115 Berlin", "Allemagne"], want: { postalCode: "10115", city: "Berlin" } },
  { iso: "FR", lines: ["12 rue de la Paix", "75002 Paris", "France"], want: { street: "12 rue de la Paix", postalCode: "75002", city: "Paris" } },
  { iso: "PL", lines: ["ul. Marszałkowska 10", "00-950 Warszawa", "Poland"], want: { postalCode: "00-950", city: "Warszawa" } },
  { iso: "PL", lines: ["ul. Marszałkowska 10", "00-950 Warszawa", "Polska"], want: { postalCode: "00-950", city: "Warszawa" } },
  { iso: "NL", lines: ["Damrak 1", "1012 LG Amsterdam", "The Netherlands"], want: { postalCode: "1012 LG", city: "Amsterdam" } },
  { iso: "NL", lines: ["Damrak 1", "1012 LG Amsterdam", "Nederland"], want: { postalCode: "1012 LG", city: "Amsterdam" } },
  { iso: "IT", lines: ["Via Roma 1", "00184 Roma", "Italy"], want: { postalCode: "00184", city: "Roma" } },
  { iso: "IT", lines: ["Via Roma 1", "00184 Roma", "Italia"], want: { postalCode: "00184", city: "Roma" } },
  { iso: "ES", lines: ["Calle Mayor 1", "28013 Madrid", "Spain"], want: { postalCode: "28013", city: "Madrid" } },
  { iso: "ES", lines: ["Calle Mayor 1", "28013 Madrid", "España"], want: { postalCode: "28013", city: "Madrid" } },
  { iso: "BE", lines: ["Rue Neuve 1", "1000 Bruxelles", "Belgium"], want: { postalCode: "1000", city: "Bruxelles" } },
  { iso: "BE", lines: ["Rue Neuve 1", "1000 Bruxelles", "Belgique"], want: { postalCode: "1000", city: "Bruxelles" } },
  { iso: "AT", lines: ["Stephansplatz 1", "1010 Wien", "Austria"], want: { postalCode: "1010", city: "Wien" } },
  { iso: "AT", lines: ["Stephansplatz 1", "1010 Wien", "Österreich"], want: { postalCode: "1010", city: "Wien" } },
  { iso: "CH", lines: ["Bahnhofstrasse 1", "8001 Zürich", "Switzerland"], want: { postalCode: "8001", city: "Zürich" } },
  { iso: "CH", lines: ["Bahnhofstrasse 1", "8001 Zürich", "Schweiz"], want: { postalCode: "8001", city: "Zürich" } },
  // GB postcodes trail the town, which this parser does not split; the country line must still go.
  { iso: "GB", lines: ["1 Test Road", "London SW1A 1AA", "United Kingdom"], want: { street: "1 Test Road", city: "London SW1A 1AA" } },
  { iso: "GB", lines: ["1 Test Road", "London SW1A 1AA", "Great Britain"], want: { street: "1 Test Road", city: "London SW1A 1AA" } },
  { iso: "US", lines: ["250 W 94th St, Apt. 8j", "New York, NY 10025", "United States"], want: { postalCode: "10025", city: "New York", state: "NY" } },
  { iso: "US", lines: ["250 W 94th St, Apt. 8j", "New York, NY 10025", "United States of America"], want: { postalCode: "10025", city: "New York", state: "NY" } },
]

describe("parseInvoiceAddress without Intl (the QuickJS sandbox)", () => {
  for (const c of CASES) {
    it(`${c.iso}: ${c.lines.join(" / ")}`, () => {
      const got = parse(c.lines.join("\n"), c.iso)
      expect(got).toMatchObject({ ...c.want, countryIsoCode: c.iso })
      // The country line is noise: the result is the one the address gives without it.
      expect(got).toEqual(parse(c.lines.slice(0, -1).join("\n"), c.iso))
    })
  }

  it("never takes a locality whose city shares the country name for the country line", () => {
    expect(parse("1 Avenue des Fleurs\n98000 Monaco", "MC")).toMatchObject({ street: "1 Avenue des Fleurs", postalCode: "98000", city: "Monaco" })
    expect(parse("12 rue du Marché\n1234 Luxembourg", "LU")).toMatchObject({ street: "12 rue du Marché", postalCode: "1234", city: "Luxembourg" })
    expect(parse("Via Roma 3\n47890 San Marino", "SM")).toMatchObject({ street: "Via Roma 3", postalCode: "47890", city: "San Marino" })
  })

  it("parses the production-shaped 3-line German invoice address (company line folded in by the caller)", () => {
    const got = parse("Lindenweg 3a\n10115 Berlin\nGermany", "DE")
    expect(got?.postalCode).toBe("10115")
    expect(got?.city).toBe("Berlin")
    expect(got?.street).toBe("Lindenweg 3a")
    expect(got?.countryIsoCode).toBe("DE")
  })

  it("falls back on the line above when the last line is an unlisted country name", () => {
    // "Germanien" is not in the table: the postcode line above still wins over reading the
    // country as the city.
    const got = parse("Lindenweg 3a\n10115 Berlin\nGermanien", "DE")
    expect(got).toMatchObject({ street: "Lindenweg 3a", postalCode: "10115", city: "Berlin" })
  })

  it("does not take a street number for a postcode in the fallback", () => {
    // FR: "12 rue de la Paix" is a street, not "<5-digit postcode> <city>".
    const got = parse("12 rue de la Paix\nParis", "FR")
    expect(got).toMatchObject({ street: "12 rue de la Paix", city: "Paris", postalCode: null })
  })
})
