// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signing scripts run on self-hosted Macs too, which outlive the job and
// sign other products. The temporary keychain must leave that machine as it
// found it: the user's search list kept, no keychain and no decoded private
// key left behind. Run against a stub `security` that records every call.
import { afterEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CI_DIR = import.meta.dir
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubbedRun(script: string, args: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "keychain-test-"))
  scratch.push(root)
  const bin = path.join(root, "bin")
  const builds = path.join(root, "builds")
  const log = path.join(root, "security.log")
  for (const dir of [bin, builds]) Bun.spawnSync(["mkdir", "-p", dir])
  writeFileSync(
    path.join(bin, "security"),
    `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in
  list-keychains) [ "$#" -le 3 ] && printf '    "/Users/someone/Library/Keychains/login.keychain-db"\\n    "/Users/someone/Library/Keychains/other product.keychain-db"\\n' ;;
  find-identity) echo '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Test (TEAMID0001)"' ;;
esac
exit 0
`,
  )
  writeFileSync(
    path.join(bin, "codesign"),
    `#!/bin/bash
[ "$1" = "-dvv" ] && printf 'Authority=Developer ID Application: Test (TEAMID0001)\\nTeamIdentifier=TEAMID0001\\n' >&2
exit 0
`,
  )
  for (const name of ["security", "codesign"]) chmodSync(path.join(bin, name), 0o755)
  const binary = path.join(root, "liaison-sidecar-aarch64-apple-darwin")
  writeFileSync(binary, "not really a binary")
  const run = Bun.spawnSync(
    ["/bin/bash", path.join(CI_DIR, script), ...args.map((a) => a.replace("$BINARY", binary))],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CI_BUILDS_DIR: builds,
        MACOS_CERTIFICATE_P12: Buffer.from("fake p12").toString("base64"),
        MACOS_CERTIFICATE_PWD: "p12-password",
        MACOS_KEYCHAIN_PWD: "keychain-password",
        APPLE_TEAM_ID: "TEAMID0001",
      },
    },
  )
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []
  return { run, calls, builds }
}

describe("the temporary signing keychain", () => {
  it("adds itself to the user's search list and leaves nothing behind", () => {
    const { run, calls, builds } = stubbedRun("sign-sidecar-macos.sh", ["$BINARY"])
    expect(run.exitCode).toBe(0)

    const created = calls.find((c) => c.startsWith("create-keychain"))
    expect(created).toBeTruthy()
    const keychain = created!.split(" ").at(-1)!
    // The identity is looked up in the temporary keychain only.
    expect(calls).toContain(`find-identity -v -p codesigning ${keychain}`)

    // Prepended to the existing list, never a list of only itself and login.
    const set = calls.find((c) => c.startsWith("list-keychains -d user -s"))
    expect(set).toBe(
      `list-keychains -d user -s ${keychain} /Users/someone/Library/Keychains/login.keychain-db /Users/someone/Library/Keychains/other product.keychain-db`,
    )

    // Deleted on exit, which also drops it from the search list.
    expect(calls.at(-1)).toBe(`delete-keychain ${keychain}`)
    // The folder that held the decoded .p12 is gone.
    expect(readdirSync(builds)).toEqual([])
  })

  it("is the one keychain setup both signing scripts use", () => {
    for (const script of ["sign-sidecar-macos.sh", "sign-app-macos.sh"]) {
      const source = readFileSync(path.join(CI_DIR, script), "utf8")
      expect(source).toContain('source "$SCRIPT_DIR/macos-temp-keychain.sh"')
      expect(source).not.toContain("security create-keychain")
    }
  })
})
