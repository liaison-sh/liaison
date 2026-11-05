// SPDX-License-Identifier: FSL-1.1-ALv2
// `bun run app:sign <tarball>` — cosign keyless-sign a `.liaisonapp` package.
//
// The signature is a DETACHED sibling file: `<tarball>.cosign.bundle`. The
// `.liaisonapp` tarball itself is never modified — signing then re-taring would
// change the bytes out from under the signature, so the signed blob and the
// distributed artifact are guaranteed identical. Distribute both files together;
// the install service fetches `<url>` and `<url>.cosign.bundle` side by side.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename } from "node:path"

export interface SignOptions {
  /** Path to the `.liaisonapp` tarball to sign. */
  tarballPath: string
}

export interface SignResult {
  tarballPath: string
  /** Path to the detached cosign signature bundle written next to the tarball. */
  signaturePath: string
}

export function signApp(opts: SignOptions): SignResult {
  const { tarballPath } = opts
  if (!existsSync(tarballPath)) {
    throw new Error(`Tarball not found: ${tarballPath}`)
  }

  // Detached signature — sibling file, tarball untouched.
  const signaturePath = `${tarballPath}.cosign.bundle`
  const sign = spawnSync("cosign", ["sign-blob", "--yes", "--bundle", signaturePath, tarballPath], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  if (sign.error) {
    throw new Error(
      `cosign binary not available: ${sign.error.message} — install cosign (https://docs.sigstore.dev/cosign/installation/)`,
    )
  }
  if (sign.status !== 0) {
    throw new Error("cosign sign-blob failed")
  }
  return { tarballPath, signaturePath }
}

// CLI entry point.
if (import.meta.main) {
  const tarballPath = process.argv[2]
  if (!tarballPath) {
    console.error("usage: bun run app:sign <tarball.liaisonapp>")
    process.exit(1)
  }
  try {
    const { signaturePath } = signApp({ tarballPath })
    console.log(`✓ signed ${basename(tarballPath)} → ${basename(signaturePath)}`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
