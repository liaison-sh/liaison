// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CSV cell escaper for the invoicing exports. Bundled apps cannot import @liaison/shared, so this is a
// verbatim copy of its `csvCell` (packages/shared/src/csv.ts); apps/api csv.parity.test.ts pins them equal.
// A cell starting with = + - @ tab or CR is a spreadsheet formula, so it gets a leading single quote
// (plain numbers like "-5000" stay numeric).

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
