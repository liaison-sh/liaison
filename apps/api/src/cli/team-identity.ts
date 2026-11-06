// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison team identity mint [--force]`
// `liaison team identity install --key-file <path>`
//
// The managed edition's identity with its control plane, provisioned rather
// than registered (modules/liaison-team/provisioned-identity.ts): `mint` makes
// a new instance id (state pending) for the operator to pin on the control
// plane; `install` stores the instance key the control plane derived for it,
// read from a file only its owner can read (mode 0600), never from the command
// line. Managed edition only. STDOUT carries one JSON report.

import { NotOwnerOnlyError, readOwnerOnlyFile } from "~/cli/owner-only-file"
import { isManagedEdition } from "~/lib/edition"
import {
  installProvisionedKey,
  mintProvisionedIdentity,
  ProvisionedIdentityError,
} from "~/modules/liaison-team/provisioned-identity"

export const TEAM_IDENTITY_USAGE =
  "usage: liaison team identity mint [--force] | liaison team identity install --key-file <path>"

export interface TeamIdentityCliResult {
  exitCode: number
  report: Record<string, unknown> | null
  message?: string
}

const usage = (message = TEAM_IDENTITY_USAGE): TeamIdentityCliResult => ({
  exitCode: 2,
  report: null,
  message,
})

function refused(err: unknown): TeamIdentityCliResult {
  if (err instanceof ProvisionedIdentityError)
    return { exitCode: 1, report: null, message: err.message }
  throw err
}

/** `argv` starts at the subcommand (`mint` / `install`). */
export async function runTeamIdentityCli(argv: string[]): Promise<TeamIdentityCliResult> {
  const [sub, ...rest] = argv
  if (sub !== "mint" && sub !== "install") return usage()
  if (!isManagedEdition()) {
    return usage(
      "liaison team identity is for the managed edition (LIAISON_EDITION=managed); a self-hosted server registers from Settings > System",
    )
  }

  if (sub === "mint") {
    if (rest.some((a) => a !== "--force")) return usage()
    try {
      const minted = await mintProvisionedIdentity({ force: rest.includes("--force") })
      return { exitCode: 0, report: { instanceId: minted.instanceId, state: minted.state } }
    } catch (err) {
      return refused(err)
    }
  }

  if (rest.length !== 2 || rest[0] !== "--key-file" || !rest[1]) return usage()
  const path = rest[1]
  let key: string
  try {
    key = readOwnerOnlyFile(path)
  } catch (err) {
    if (err instanceof NotOwnerOnlyError) return usage(err.message)
    return usage(`Cannot read ${path}: ${(err as Error).message}`)
  }
  try {
    const installed = await installProvisionedKey(key)
    return {
      exitCode: 0,
      report: {
        instanceId: installed.instanceId,
        state: "registered",
        keyFingerprint: installed.fingerprint,
      },
    }
  } catch (err) {
    return refused(err)
  }
}
