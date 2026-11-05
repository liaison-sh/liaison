// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only validator for Factur-X (CII D22B, EN 16931 profile) XML. No Java anywhere:
//
//   1. XSD: `xmllint --schema` (libxml2 CLI) against the pinned Factur-X 1.09.2 EN16931 XSD.
//   2. Schematron: three vendored, already-compiled schematron XSLTs run in-process by SaxonJS
//      (the `saxon-js` engine shipped with the exact-pinned `xslt3` devDependency):
//        - `cen-en16931`  CEN/EU EN16931 CII validation artefacts, release validation-1.3.17
//        - `fnfe-facturx` FNFE-MPE FACTUR-X_EN16931 (Factur-X 1.09.2), with its codedb beside it
//        - `fnfe-br-fr`   FNFE-MPE BR-FR-Flux2-Schematron-CII (France_RFE v1.4.0.04, fatal variant)
//      plus `liaison-profile`, a few named TS asserts for choices of this profile that no official
//      rule enforces (BAR note always B2B, BT-3 consistent with BT-25, no BT-7).
//      Each XSLT is compiled once to a SEF (SaxonJS's executable form) by the `xslt3` CLI into a
//      cache directory next to this file (git-ignored), keyed by the XSLT's content hash AND the
//      absolute rules directory: a SEF bakes the absolute base URI its companions (the codedb) are
//      resolved from, so a moved checkout must recompile rather than read a file that is gone.
//
// A document passes when the XSD validates AND no `svrl:failed-assert` has a flag other than
// `warning` (an absent flag counts as blocking). Never imported by product code.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES = join(HERE, "rules")
const SEF_CACHE = join(HERE, ".sef")

export const XSD_PATH = join(HERE, "xsd", "facturx-1.09.2-en16931", "Factur-X_EN16931.xsd")

export type SchematronName = "cen-en16931" | "fnfe-facturx" | "fnfe-br-fr" | "liaison-profile"

export type XsltSchematron = Exclude<SchematronName, "liaison-profile">

const STYLESHEETS: Record<XsltSchematron, { dir: string; xslt: string; companions: string[] }> = {
  "cen-en16931": {
    dir: "cen-en16931-cii-1.3.17",
    xslt: "EN16931-CII-validation.xslt",
    companions: [],
  },
  "fnfe-facturx": {
    dir: "fnfe-france-rfe-1.4.0.04",
    xslt: "FACTUR-X_EN16931.xslt",
    // Resolved by `document('FACTUR-X_EN16931_codedb.xml')` relative to the stylesheet: it must sit
    // next to the compiled SEF, or every code-list rule silently evaluates against an empty list.
    companions: ["FACTUR-X_EN16931_codedb.xml"],
  },
  "fnfe-br-fr": {
    dir: "fnfe-france-rfe-1.4.0.04",
    xslt: "BR-FR-Flux2-Schematron-CII.xslt",
    companions: [],
  },
}

export const SCHEMATRONS: SchematronName[] = [
  ...(Object.keys(STYLESHEETS) as XsltSchematron[]),
  "liaison-profile",
]

export interface FailedAssert {
  schematron: SchematronName
  id: string
  flag: string | null
  location: string
  text: string
}

export interface ValidationReport {
  xsd: { ok: boolean; errors: string[] }
  failedAsserts: FailedAssert[]
  /** failed-asserts whose flag is absent or not `warning`. */
  blocking: FailedAssert[]
  ok: boolean
}

const requireHere = createRequire(import.meta.url)

function xslt3Cli(): string {
  return requireHere.resolve("xslt3/xslt3.js")
}

// biome-ignore lint/suspicious/noExplicitAny: SaxonJS ships no types.
let saxon: any = null
// biome-ignore lint/suspicious/noExplicitAny: SaxonJS ships no types.
function saxonJs(): any {
  if (saxon) return saxon
  // `saxon-js` is the engine `xslt3` depends on; resolve it from there so the pinned pair is used.
  const fromXslt3 = createRequire(xslt3Cli())
  saxon = fromXslt3("saxon-js")
  return saxon
}

/** Cache key of a compiled stylesheet: its content and where its rules live (see the header). */
export function sefCacheKey(name: XsltSchematron, rulesDir: string = RULES): string {
  const def = STYLESHEETS[name]
  const hash = createHash("sha256")
    .update(readFileSync(join(rulesDir, def.dir, def.xslt)))
    .update("\0")
    .update(rulesDir)
    .digest("hex")
    .slice(0, 16)
  return `${name}-${hash}`
}

function sefPathFor(name: XsltSchematron): string {
  const def = STYLESHEETS[name]
  const src = join(RULES, def.dir, def.xslt)
  const key = sefCacheKey(name)
  const dir = join(SEF_CACHE, key)
  const sef = join(dir, `${def.xslt}.sef.json`)
  if (existsSync(sef)) return sef
  // Stale compilations of this stylesheet (an older XSLT, or another checkout location) are dropped.
  if (existsSync(SEF_CACHE)) {
    for (const entry of readdirSync(SEF_CACHE)) {
      if (
        entry !== key &&
        entry.startsWith(`${name}-`) &&
        /^[0-9a-f]{16}$/.test(entry.slice(name.length + 1))
      ) {
        rmSync(join(SEF_CACHE, entry), { recursive: true, force: true })
      }
    }
  }
  mkdirSync(dir, { recursive: true })
  for (const c of def.companions) copyFileSync(join(RULES, def.dir, c), join(dir, c))
  const run = spawnSync(process.execPath, [xslt3Cli(), `-xsl:${src}`, `-export:${sef}`, "-nogo"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.status !== 0 || !existsSync(sef)) {
    throw new Error(`SEF compilation failed for ${name}: ${run.stderr || run.stdout}`)
  }
  return sef
}

const loadedSef = new Map<XsltSchematron, string>()

/**
 * Rules the official schematrons cannot enforce because they are choices of this profile, not of
 * the standard: the BAR note is optional in XP Z12-012 (it only drives BR-FR-11/21), and a credit
 * note typed 380 is a valid invoice to every official rule. Each is a named assert, like theirs.
 */
export function profileAsserts(xml: string): FailedAssert[] {
  const out: FailedAssert[] = []
  const fail = (id: string, text: string) =>
    out.push({
      schematron: "liaison-profile",
      id,
      flag: "fatal",
      location: "/rsm:CrossIndustryInvoice",
      text,
    })
  const bar = [
    ...xml.matchAll(
      /<ram:IncludedNote>\s*<ram:Content>([^<]*)<\/ram:Content>\s*<ram:SubjectCode>BAR<\/ram:SubjectCode>/g,
    ),
  ]
  if (bar.length !== 1 || (bar[0]?.[1] ?? "").trim() !== "B2B") {
    fail("LX-BAR-01", "Exactly one BAR note with the value B2B must be present.")
  }
  const typeCode =
    /<rsm:ExchangedDocument>[\s\S]*?<ram:TypeCode>\s*(\d+)\s*<\/ram:TypeCode>/.exec(xml)?.[1] ?? ""
  if (typeCode !== "380" && typeCode !== "381")
    fail("LX-BT3-01", `BT-3 must be 380 or 381, got ${typeCode || "none"}.`)
  const referencesInvoice = /<ram:InvoiceReferencedDocument>/.test(xml)
  if (referencesInvoice !== (typeCode === "381")) {
    fail(
      "LX-BT3-02",
      "A document referencing a prior invoice (BT-25) must be a credit note (381), and a credit note must reference one.",
    )
  }
  if (/<ram:TaxPointDate>/.test(xml))
    fail("LX-BT7-01", "BT-7 (tax point date) is never emitted (BR-CO-03 with BT-8).")
  return out
}

/** Run one schematron and return every failed-assert it reports. */
export function runSchematron(name: SchematronName, xml: string): FailedAssert[] {
  if (name === "liaison-profile") return profileAsserts(xml)
  let sef = loadedSef.get(name)
  if (!sef) {
    sef = sefPathFor(name)
    loadedSef.set(name, sef)
  }
  const out = saxonJs().transform(
    { stylesheetFileName: sef, sourceText: xml, destination: "serialized" },
    "sync",
  ) as { principalResult: string }
  return parseFailedAsserts(name, out.principalResult)
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? decodeEntities(m[1] ?? "") : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

export function parseFailedAsserts(name: SchematronName, svrl: string): FailedAssert[] {
  const out: FailedAssert[] = []
  const re = /<svrl:failed-assert\b([^>]*)>([\s\S]*?)<\/svrl:failed-assert>/g
  for (let m = re.exec(svrl); m; m = re.exec(svrl)) {
    const tag = ` ${m[1] ?? ""}`
    const textMatch = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(m[2] ?? "")
    out.push({
      schematron: name,
      id: attr(tag, "id") ?? "",
      flag: attr(tag, "flag"),
      location: attr(tag, "location") ?? "",
      text: decodeEntities((textMatch?.[1] ?? "").replace(/\s+/g, " ").trim()),
    })
  }
  return out
}

/** XSD validation through the libxml2 CLI. */
export function validateXsd(xml: string): { ok: boolean; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "facturx-xsd-"))
  try {
    const file = join(dir, "factur-x.xml")
    writeFileSync(file, xml)
    const run = spawnSync("xmllint", ["--noout", "--schema", XSD_PATH, file], { encoding: "utf8" })
    if (run.error) throw new Error(`xmllint unavailable: ${run.error.message}`)
    const errors = (run.stderr ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.endsWith(" validates"))
    return { ok: run.status === 0, errors }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function isBlocking(a: FailedAssert): boolean {
  return a.flag !== "warning"
}

/** Full chain: XSD then the three schematrons. */
export function validateFacturxXml(xml: string): ValidationReport {
  const xsd = validateXsd(xml)
  const failedAsserts = SCHEMATRONS.flatMap((n) => runSchematron(n, xml))
  const blocking = failedAsserts.filter(isBlocking)
  return { xsd, failedAsserts, blocking, ok: xsd.ok && blocking.length === 0 }
}
