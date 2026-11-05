// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The validator itself must be able to say no: the official FNFE example passes all four checks,
// and targeted breakages are reported by the rule that owns them.

import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  profileAsserts,
  runSchematron,
  sefCacheKey,
  validateFacturxXml,
  validateXsd,
} from "./validate"

const EXAMPLE = readFileSync(join(import.meta.dir, "fixtures", "fnfe-uc1-en16931.xml"), "utf8")

function ids(asserts: Array<{ id: string }>): string[] {
  return asserts.map((a) => a.id)
}

describe("factur-x validator", () => {
  test("the FNFE EN16931 example passes the XSD and all three official schematrons", () => {
    const r = validateFacturxXml(EXAMPLE)
    expect(r.xsd.errors).toEqual([])
    // The official example carries no BAR note (optional in XP Z12-012); this profile always
    // emits one, so only the profile's own assert may fire on it.
    expect(ids(r.blocking)).toEqual(["LX-BAR-01"])
  }, 120_000)

  test("the profile asserts: BAR note, BT-3 against BT-25, no BT-7", () => {
    const withBar = EXAMPLE.replace(
      "</rsm:ExchangedDocument>",
      "<ram:IncludedNote><ram:Content>B2B</ram:Content><ram:SubjectCode>BAR</ram:SubjectCode></ram:IncludedNote></rsm:ExchangedDocument>",
    )
    expect(profileAsserts(withBar)).toEqual([])
    expect(
      ids(
        profileAsserts(
          withBar.replace("<ram:Content>B2B</ram:Content>", "<ram:Content>B2C</ram:Content>"),
        ),
      ),
    ).toEqual(["LX-BAR-01"])
    const asCredit = withBar.replace(
      "<ram:TypeCode>380</ram:TypeCode>",
      "<ram:TypeCode>381</ram:TypeCode>",
    )
    expect(ids(profileAsserts(asCredit))).toEqual(["LX-BT3-02"])
    expect(
      ids(
        profileAsserts(
          withBar.replace("<ram:TypeCode>380</ram:TypeCode>", "<ram:TypeCode>384</ram:TypeCode>"),
        ),
      ),
    ).toContain("LX-BT3-01")
  })

  test("an unknown document type code is reported by the French rules and by the EN16931 code lists", () => {
    const broken = EXAMPLE.replace(
      "<ram:TypeCode>380</ram:TypeCode>",
      "<ram:TypeCode>999</ram:TypeCode>",
    )
    expect(broken).not.toBe(EXAMPLE)
    expect(ids(runSchematron("fnfe-br-fr", broken))).toContain("BR-FR-04_BT-3")
    expect(ids(runSchematron("cen-en16931", broken))).toContain("BR-CL-01")
    expect(validateFacturxXml(broken).ok).toBe(false)
  }, 120_000)

  test("the Factur-X schematron reads its code database (an unknown country code is caught)", () => {
    const broken = EXAMPLE.replace(
      /<ram:CountryID>FR<\/ram:CountryID>/,
      "<ram:CountryID>QQ</ram:CountryID>",
    )
    expect(broken).not.toBe(EXAMPLE)
    const fx = runSchematron("fnfe-facturx", broken)
    expect(fx.length).toBeGreaterThan(0)
  }, 120_000)

  test("an element-order swap fails the XSD", () => {
    // ram:ID must precede ram:TypeCode inside rsm:ExchangedDocument.
    const id = /<ram:ID>F202500003<\/ram:ID>/.exec(EXAMPLE)?.[0]
    expect(id).toBeTruthy()
    const swapped = EXAMPLE.replace(id as string, "").replace(
      "<ram:TypeCode>380</ram:TypeCode>",
      `<ram:TypeCode>380</ram:TypeCode>${id}`,
    )
    expect(validateXsd(swapped).ok).toBe(false)
  }, 60_000)

  test("a compiled stylesheet is cached per checkout location, so a moved checkout recompiles", () => {
    // The SEF bakes the absolute path its codedb is read from: the same XSLT content under another
    // rules directory must not reuse it.
    const here = join(import.meta.dir, "rules")
    const moved = mkdtempSync(join(tmpdir(), "schematron-moved-"))
    try {
      cpSync(here, moved, { recursive: true })
      expect(sefCacheKey("fnfe-facturx", moved)).not.toBe(sefCacheKey("fnfe-facturx", here))
      expect(sefCacheKey("fnfe-facturx", here)).toBe(sefCacheKey("fnfe-facturx"))
    } finally {
      rmSync(moved, { recursive: true, force: true })
    }
  })
})
