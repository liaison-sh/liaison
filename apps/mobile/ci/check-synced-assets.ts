#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The synced web assets, scanned for an absolute path belonging to whatever
// machine built them, for any Argon2id code, and for a page that is not under
// the phone's Content Security Policy, as a step of its own.
//
// build-mobile.ts already runs this scan at the end of a build. It exists
// separately because the CI job needs it as the step IMMEDIATELY before
// signing: a signature over assets carrying the runner's checkout path makes a
// broken build look trustworthy, and the failure then belongs to whoever
// installs it rather than to the run that produced it.
//
// Usage: bun ci/check-synced-assets.ts [--dir <tree> ...]

import path from "node:path"
import {
  absolutePathOffenders,
  nonExemptCryptoOffenders,
  policyOffenders,
  SYNCED_ASSET_DIRS,
} from "../scripts/build-mobile"

const MOBILE_ROOT = path.resolve(import.meta.dir, "..")

export function scanTrees(dirs: readonly string[]): number {
  const offenders = absolutePathOffenders(dirs)
  for (const offender of offenders) {
    console.log(`${offender.file}: ${offender.match}`)
  }
  if (offenders.length > 0) {
    console.log(
      "The synced assets carry an absolute path from the machine that built them. Nothing " +
        "is signed over assets like that.",
    )
    return 1
  }
  const cryptoOffenders = nonExemptCryptoOffenders(dirs)
  for (const offender of cryptoOffenders) {
    console.log(`${offender.file}: ${offender.match}`)
  }
  if (cryptoOffenders.length > 0) {
    console.log(
      "The synced assets carry Argon2id code, so the export compliance declaration " +
        "(ITSAppUsesNonExemptEncryption false) would be wrong. Nothing is signed over them.",
    )
    return 1
  }
  const policy = policyOffenders(dirs)
  for (const offender of policy) {
    console.log(`${offender.file}: ${offender.match}`)
  }
  if (policy.length > 0) {
    console.log(
      "The synced page is not under the phone's Content Security Policy, or still carries " +
        "an inline script it would block. Nothing is signed over it.",
    )
    return 1
  }
  console.log(
    `scanned ${dirs.length} synced asset trees: no host path, no Argon2id, no inline script`,
  )
  return 0
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const explicit: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) explicit.push(path.resolve(argv[++i]))
  }
  const dirs =
    explicit.length > 0 ? explicit : SYNCED_ASSET_DIRS.map((dir) => path.join(MOBILE_ROOT, dir))
  process.exit(scanTrees(dirs))
}
