// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calibrate the oxidize-pdf smoke check against the veraPDF corpus (labelled pass/fail files):
//   bun tools/pdfa-check/calibrate.ts <corpus-root> <report.md>
// <corpus-root> holds `PDF_A-2b/` and `PDF_A-3b/` from github.com/veraPDF/veraPDF-corpus. Each
// directory is checked at its own level (2b, 3b). Per ISO clause (first two levels, from the
// directory name) the report gives recall on `-fail-` files (flagged invalid), specificity on
// `-pass-` files (accepted), and overall agreement. Test-only; never part of a runtime image.

import { spawnSync } from "node:child_process"
import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const [root, out] = process.argv.slice(2)
if (!root || !out) {
  console.error("usage: bun tools/pdfa-check/calibrate.ts <corpus-root> <report.md>")
  process.exit(2)
}
const BIN = join(import.meta.dir, "target", "release", "pdfa-check")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".pdf") ? [p] : []
  })
}

interface Row {
  file: string
  clause: string
  expectPass: boolean
  gotValid: boolean
  parseError: string | null
  codes: string[]
}

type Result = { valid: boolean; parse_error: string | null; errors: Array<{ code: string }> }

function run(level: string, files: string[]): Map<string, Result> {
  const res = new Map<string, Result>()
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100)
    const p = spawnSync(BIN, ["--level", level, ...chunk], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    for (const line of p.stdout.split("\n")) {
      if (!line.trim()) continue
      const j = JSON.parse(line) as Result & { file: string }
      res.set(j.file, j)
    }
  }
  return res
}

const ARTEFACT = "XmpMissingPdfAIdentifier"

function falseAlarmReasons(pass: Row[]): string {
  const counts = new Map<string, number>()
  for (const r of pass.filter((x) => !x.gotValid)) {
    for (const c of r.parseError ? ["parse_error"] : r.codes)
      counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} x${n}`)
      .join(", ") || "none"
  )
}

const sections: string[] = []
const totals: Array<[string, Row[]]> = []
for (const [dir, level] of [
  ["PDF_A-2b", "2b"],
  ["PDF_A-3b", "3b"],
] as const) {
  const base = join(root, dir)
  const files = walk(base)
  const res = run(level, files)
  const rows: Row[] = files.map((f) => {
    const rel = relative(base, f)
    const clause = (rel.split("/")[0] ?? "").split(" ")[0] ?? "?"
    const sub = rel.split("/").length > 2 ? (rel.split("/")[1] ?? "").split(" ")[0] : clause
    const r = res.get(f)
    return {
      file: rel,
      clause: sub ?? clause,
      expectPass: /-pass-/.test(f),
      gotValid: r?.valid ?? false,
      parseError: r ? r.parse_error : "not run",
      codes: [...new Set((r?.errors ?? []).map((e) => e.code))],
    }
  })
  totals.push([dir, rows])
  const byClause = new Map<string, Row[]>()
  for (const r of rows) byClause.set(r.clause, [...(byClause.get(r.clause) ?? []), r])
  const lines = [...byClause.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([c, rs]) => {
      const fail = rs.filter((r) => !r.expectPass)
      const pass = rs.filter((r) => r.expectPass)
      const caught = fail.filter((r) => !r.gotValid).length
      // oxidize-pdf reads only the element form of pdfaid:part; the corpus writes the attribute
      // form, so every corpus file gets XmpMissingPdfAIdentifier. Real recall counts a fail file
      // only when it is flagged for some other reason.
      const caughtReal = fail.filter(
        (r) => !r.gotValid && (r.parseError || r.codes.some((c) => c !== ARTEFACT)),
      ).length
      const accepted = pass.filter((r) => r.gotValid).length
      const agree = rs.filter((r) => r.gotValid === r.expectPass).length
      const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`)
      return `| ${c} | ${fail.length} | ${caught} (${pct(caught, fail.length)}) | ${caughtReal} (${pct(caughtReal, fail.length)}) | ${pass.length} | ${accepted} (${pct(accepted, pass.length)}) | ${pct(agree, rs.length)} |`
    })
  const fail = rows.filter((r) => !r.expectPass)
  const pass = rows.filter((r) => r.expectPass)
  sections.push(
    `## ${dir} (checked at level ${level}, ${rows.length} files)\n\n` +
      `Overall: fail files flagged ${fail.filter((r) => !r.gotValid).length}/${fail.length} ` +
      `(for a reason other than ${ARTEFACT}: ${fail.filter((r) => !r.gotValid && (r.parseError || r.codes.some((c) => c !== ARTEFACT))).length}), ` +
      `pass files accepted ${pass.filter((r) => r.gotValid).length}/${pass.length}, ` +
      `parse errors ${rows.filter((r) => r.parseError).length}.\n\n` +
      `Reasons given for rejecting pass files (false alarms): ${falseAlarmReasons(pass)}.\n\n` +
      "| clause | fail files | flagged (raw recall) | flagged for a real reason (recall) | pass files | accepted (specificity) | agreement |\n|---|---|---|---|---|---|---|\n" +
      lines.join("\n"),
  )
}

writeFileSync(
  out,
  `# oxidize-pdf calibration (generated by tools/pdfa-check/calibrate.ts, ${new Date().toISOString().slice(0, 10)})\n\n` +
    "Validator: oxidize-pdf 5.4.2 `PdfAValidator` via tools/pdfa-check. Corpus: veraPDF-corpus PDF_A-2b + PDF_A-3b.\n" +
    "Recall = share of `-fail-` files the smoke check rejects; specificity = share of `-pass-` files it accepts.\n\n" +
    sections.join("\n\n") +
    "\n",
)
console.log(`wrote ${out}`)
