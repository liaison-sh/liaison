// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The folder, named in the only way the server is allowed to know it.
//
// A local session runs in a folder on the user's own machine, and that path is
// the one thing the audit trail must never carry (A20): `/Users/alice/acme-
// acquisition` says more about the business than the whole row around it. So
// every server-facing mention of a folder is this digest, and the audit route
// itself refuses anything that is not exactly 64 hex characters
// (`local-session-routes.ts:41-46`).
//
// The SAME digest keys the per (agent, folder) resume store, so the two can
// never disagree about which folder a session belonged to.
//
// SALTED, with a per install secret the shell creates once and the server never
// sees (`get_install_salt`). An unsalted sha256 of a path is a dictionary
// lookup: `/Users/alice/work` and a few hundred other common paths hash to
// known values, so a row carrying the bare digest names the folder to anyone
// holding the rows. The salt makes the digest meaningful only on this machine,
// which is all the trail needs: it has to tell two folders apart, not name
// them. It is stable for the install, because a salt that rolled would silently
// forget every resumable session.

import { getInstallSalt } from "./sidecar-client"

/**
 * One folder, one digest. Trailing separators go (a picker answers with and
 * without one for the same folder), and the path is lowercased: macOS and
 * Windows hand back whatever casing the dialog happened to produce for a
 * filesystem that does not distinguish them, and two digests for one folder
 * would silently split a session's trail in half.
 *
 * BOUND: on a case sensitive filesystem two folders differing only in case
 * therefore share a digest. That is the cheaper of the two errors here (a
 * resumed session in a sibling directory, versus a resume that never works on
 * the two platforms the app ships on first), and it is recorded rather than
 * hidden.
 */
export function normalizeFolderPath(folder: string): string {
  const trimmed = folder.trim()
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "")
  // A root ("/" or "C:\") is all separator: stripping it would hash the empty
  // string for every root on the machine.
  return (withoutTrailing || trimmed).toLowerCase()
}

/**
 * The digest, salted. The salt is the shell's when none is named, so every
 * caller in the window agrees without passing it around; a caller that names
 * one (a test, or a second install's digest) gets exactly that one.
 */
export async function hashFolder(folder: string, salt?: string): Promise<string> {
  const applied = salt ?? (await getInstallSalt())
  // The salt is fixed length hex, so the two halves cannot be read as each
  // other whatever the path is; the separator is there so a missing salt (a
  // page with no shell) still hashes a shape rather than the bare path.
  const bytes = new TextEncoder().encode(`${applied}\n${normalizeFolderPath(folder)}`)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
