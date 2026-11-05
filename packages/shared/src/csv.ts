// SPDX-License-Identifier: FSL-1.1-ALv2
// The one CSV cell escaper for every Liaison export.
//
// A cell that starts with = + - @ tab or CR is read as a formula by Excel / Sheets / LibreOffice,
// so attacker-controlled text (an email subject, a customer name) in an export can exfiltrate data
// or launch a program on the accountant's machine. Such a cell gets a leading single quote, which
// spreadsheets render as plain text. Plain numbers ("-5000", "-12.50") are exempt: they cannot hold
// a formula and an accounting export needs its credit-note totals to stay numeric.
//
// KEEP IN SYNC: sandboxed app scripts cannot import this module, so verbatim copies live in
// apps/api/src/apps/tickets/handlers.ts (csvCell), apps/api/src/apps/mail/handlers.ts (mailCsvCell),
// apps/api/src/apps/knowledge/handlers.ts, apps/api/src/apps/projects/handlers.ts and
// bundled-apps/invoicing/src/csv.ts; csv.parity.test.ts in apps/api pins all of them to this one.

const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value)
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
