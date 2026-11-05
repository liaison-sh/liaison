// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Mac that signs Liaison signs other products too, and its keychain holds
// the Developer ID Application certificates of more than one Apple team. The
// signing scripts must sign as the ONE team APPLE_TEAM_ID names, by hash, and
// must never keep or ship a signature of another team. Run against stub
// `security` and `codesign` binaries: no real identity is ever touched.
import { afterEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const CI_DIR = import.meta.dir
const HELPER = path.join(CI_DIR, "macos-signing-identity.sh")

const OURS = { hash: "2222222222222222222222222222222222222222", team: "Q7F3K9P2LM" }
const OTHER = { hash: "1111111111111111111111111111111111111111", team: "T4H8N2R6SW" }
const OTHER_LINE = `  1) ${OTHER.hash} "Developer ID Application: Fabrikam (${OTHER.team})"`
const OURS_LINE = `  2) ${OURS.hash} "Developer ID Application: Avery Shaw (${OURS.team})"`
const DEV_LINE = `  3) 3333333333333333333333333333333333333333 "Apple Development: Avery Shaw (${OURS.team})"`

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stub toolbox. `security find-identity` prints the given lines.
 *  `codesign --force ... --sign <id> <path>` records the signature, and
 *  `codesign -dvv <path>` reports the team of whatever signed that path last:
 *  ours for our hash, the other team for anything else, unsigned otherwise. */
function toolbox(identities: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "signing-identity-test-"))
  scratch.push(root)
  const bin = path.join(root, "bin")
  mkdirSync(bin)
  const listing = path.join(root, "identities.txt")
  writeFileSync(
    listing,
    `${[...identities, `     ${identities.length} valid identities found`].join("\n")}\n`,
  )
  const state = path.join(root, "signatures.txt")
  writeFileSync(state, "")
  const log = path.join(root, "codesign.log")
  writeFileSync(
    path.join(bin, "security"),
    `#!/bin/bash
case "$1" in
  find-identity) cat "${listing}" ;;
esac
exit 0
`,
  )
  writeFileSync(
    path.join(bin, "codesign"),
    `#!/bin/bash
echo "$*" >> "${log}"
target="\${@: -1}"
case "$1" in
  --force)
    identity=""
    previous=""
    for argument in "$@"; do
      [ "$previous" = "--sign" ] && identity="$argument"
      previous="$argument"
    done
    echo "$target|$identity" >> "${state}"
    ;;
  -dvv)
    identity="$(grep -F "$target|" "${state}" | tail -1 | cut -d'|' -f2)"
    if [ -z "$identity" ]; then echo "$target: code object is not signed at all" >&2; exit 1; fi
    if [ "$identity" = "${OURS.hash}" ]; then
      printf 'Authority=Developer ID Application: Avery Shaw (${OURS.team})\\nAuthority=Developer ID Certification Authority\\nTeamIdentifier=${OURS.team}\\n' >&2
    else
      printf 'Authority=Developer ID Application: Fabrikam (${OTHER.team})\\nAuthority=Developer ID Certification Authority\\nTeamIdentifier=${OTHER.team}\\n' >&2
    fi
    ;;
  --display) echo "[Key] com.apple.security.cs.allow-jit" ;;
esac
exit 0
`,
  )
  for (const name of ["security", "codesign"]) chmodSync(path.join(bin, name), 0o755)
  const env = (extra: Record<string, string | undefined>) => {
    const merged: Record<string, string> = { PATH: `${bin}:${process.env.PATH}` }
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) merged[key] = value
    return merged
  }
  return {
    root,
    /** Marks <path> as already signed by <identity hash>. */
    presign: (target: string, hash: string) =>
      writeFileSync(state, `${readFileSync(state, "utf8")}${target}|${hash}\n`),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    resolve(extra: Record<string, string | undefined>) {
      const run = Bun.spawnSync(
        [
          "/bin/bash",
          "-c",
          `set -euo pipefail; KEYCHAIN_ARG=(); source "${HELPER}"; resolve_signing_identity; echo "RESULT=$SIGNING_IDENTITY"`,
        ],
        { env: env(extra) },
      )
      return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
    },
    script(script: string, args: string[], extra: Record<string, string | undefined>) {
      const run = Bun.spawnSync(["/bin/bash", path.join(CI_DIR, script), ...args], {
        env: env(extra),
      })
      return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
    },
  }
}

describe("resolve_signing_identity", () => {
  it("picks the named team's Developer ID by hash, never another team's listed first", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE, DEV_LINE])
    const result = tools.resolve({ APPLE_TEAM_ID: OURS.team })
    expect(result.err).toBe("")
    expect(result.code).toBe(0)
    expect(result.out).toContain(`RESULT=${OURS.hash}\n`)
  })

  it("picks the other team only when that is the team named", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    expect(tools.resolve({ APPLE_TEAM_ID: OTHER.team }).out).toContain(`RESULT=${OTHER.hash}\n`)
  })

  it("refuses when the team has no Developer ID in the keychain", () => {
    const tools = toolbox([OTHER_LINE, DEV_LINE])
    const result = tools.resolve({ APPLE_TEAM_ID: OURS.team })
    expect(result.code).not.toBe(0)
    expect(result.out).not.toContain("RESULT=")
    expect(result.err).toContain(`No Developer ID Application identity of team ${OURS.team}`)
  })

  it("refuses to choose between two Developer IDs of the same team", () => {
    const second = `  4) 4444444444444444444444444444444444444444 "Developer ID Application: Avery Shaw (${OURS.team})"`
    const tools = toolbox([OTHER_LINE, OURS_LINE, second])
    const result = tools.resolve({ APPLE_TEAM_ID: OURS.team })
    expect(result.code).not.toBe(0)
    expect(result.out).not.toContain("RESULT=")
    expect(result.err).toContain("refusing to pick one")
  })

  it("counts one certificate listed from two keychains as one identity", () => {
    const tools = toolbox([OURS_LINE, OURS_LINE.replace("2)", "5)")])
    expect(tools.resolve({ APPLE_TEAM_ID: OURS.team }).out).toContain(`RESULT=${OURS.hash}\n`)
  })

  it("refuses without APPLE_TEAM_ID, and says why", () => {
    const tools = toolbox([OURS_LINE])
    const result = tools.resolve({})
    expect(result.code).not.toBe(0)
    expect(result.out).not.toContain("RESULT=")
    expect(result.err).toContain("APPLE_TEAM_ID is not set")
    expect(result.err).toContain("share one keychain")
  })

  it("refuses a value that is not a Team ID rather than matching it as a pattern", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    expect(tools.resolve({ APPLE_TEAM_ID: ".*" }).code).not.toBe(0)
  })
})

describe("sign-sidecar-macos.sh", () => {
  function sidecar(tools: ReturnType<typeof toolbox>) {
    const binary = path.join(tools.root, "liaison-sidecar-aarch64-apple-darwin")
    writeFileSync(binary, "not really a binary")
    return binary
  }

  it("signs with the named team's hash while another team's identity sits first", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const binary = sidecar(tools)
    const result = tools.script("sign-sidecar-macos.sh", [binary], { APPLE_TEAM_ID: OURS.team })
    expect(result.err).toBe("")
    expect(result.code).toBe(0)
    const signed = tools.calls().filter((call) => call.startsWith("--force"))
    expect(signed).toHaveLength(1)
    expect(signed[0]).toContain(`--sign ${OURS.hash} `)
    expect(result.out).toContain(`OK: signed by team ${OURS.team}`)
  })

  it("signs nothing without APPLE_TEAM_ID", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const result = tools.script("sign-sidecar-macos.sh", [sidecar(tools)], {})
    expect(result.code).not.toBe(0)
    expect(result.err).toContain("APPLE_TEAM_ID is not set")
    expect(tools.calls().filter((call) => call.startsWith("--force"))).toEqual([])
  })

  it("fails when an explicitly pinned identity belongs to another team", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const result = tools.script("sign-sidecar-macos.sh", [sidecar(tools)], {
      APPLE_TEAM_ID: OURS.team,
      SIGNING_IDENTITY: OTHER.hash,
    })
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(
      `is not signed with a Developer ID Application identity of team ${OURS.team}`,
    )
  })
})

// The bundle walk uses BSD find's `-perm +111`, so it runs where the script runs.
describe.skipIf(process.platform !== "darwin")("sign-app-macos.sh", () => {
  function bundle(tools: ReturnType<typeof toolbox>) {
    const app = path.join(tools.root, "Liaison.app")
    const macos = path.join(app, "Contents", "MacOS")
    const frameworks = path.join(app, "Contents", "Frameworks")
    mkdirSync(macos, { recursive: true })
    mkdirSync(frameworks, { recursive: true })
    const files = {
      shell: path.join(macos, "liaison-desktop"),
      sidecar: path.join(macos, "liaison-sidecar"),
      foreign: path.join(frameworks, "libvendored.dylib"),
      ours: path.join(macos, "helper"),
    }
    for (const file of Object.values(files)) writeFileSync(file, "not really a binary")
    for (const file of [files.shell, files.sidecar, files.ours]) chmodSync(file, 0o755)
    tools.presign(files.foreign, OTHER.hash)
    tools.presign(files.ours, OURS.hash)
    return { app, ...files }
  }

  it("re-signs a nested binary another team signed, keeps ours, and asserts the team", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const app = bundle(tools)
    const result = tools.script("sign-app-macos.sh", [app.app, "--no-notarize"], {
      APPLE_TEAM_ID: OURS.team,
    })
    expect(result.err).toBe("")
    expect(result.code).toBe(0)
    const signed = tools.calls().filter((call) => call.startsWith("--force"))
    expect(signed.some((call) => call.endsWith(app.foreign))).toBe(true)
    expect(signed.every((call) => call.includes(`--sign ${OURS.hash} `))).toBe(true)
    expect(signed.some((call) => call.endsWith(app.ours))).toBe(false)
    expect(result.out).toContain("keeping the existing signature (Developer ID, team")
    // The embedded sidecar was not ours, so it went back through its own script.
    expect(
      signed.some(
        (call) => call.endsWith(app.sidecar) && call.includes("entitlements-sidecar.plist"),
      ),
    ).toBe(true)
    expect(result.out).toContain(`OK: signed by team ${OURS.team}: ${app.app}`)
    expect(result.out).toContain(`OK: signed by team ${OURS.team}: ${app.sidecar}`)
  })

  it("signs nothing without APPLE_TEAM_ID", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const app = bundle(tools)
    const result = tools.script("sign-app-macos.sh", [app.app, "--no-notarize"], {})
    expect(result.code).not.toBe(0)
    expect(result.err).toContain("APPLE_TEAM_ID is not set")
    expect(tools.calls().filter((call) => call.startsWith("--force"))).toEqual([])
  })
})

describe("make-dmg.sh", () => {
  it("refuses an app signed by another team before making an image", () => {
    const tools = toolbox([OTHER_LINE, OURS_LINE])
    const app = path.join(tools.root, "Liaison.app")
    mkdirSync(app)
    tools.presign(app, OTHER.hash)
    const result = tools.script(
      "make-dmg.sh",
      [app, path.join(tools.root, "out"), "--no-notarize"],
      {
        APPLE_TEAM_ID: OURS.team,
      },
    )
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`is not signed by team ${OURS.team}, refusing to package it`)
  })

  it("refuses without APPLE_TEAM_ID", () => {
    const tools = toolbox([OURS_LINE])
    const app = path.join(tools.root, "Liaison.app")
    mkdirSync(app)
    tools.presign(app, OURS.hash)
    const result = tools.script(
      "make-dmg.sh",
      [app, path.join(tools.root, "out"), "--no-notarize"],
      {},
    )
    expect(result.code).not.toBe(0)
    expect(result.err).toContain("APPLE_TEAM_ID is not set")
  })

  // 2026-10-30: an image holding only the app gets the app opened in place,
  // read only, where the updater can never replace it. The real hdiutil runs
  // here, so this one needs a Mac.
  it.skipIf(process.platform !== "darwin")(
    "puts an Applications link beside the app in the image",
    () => {
      const tools = toolbox([OURS_LINE])
      const app = path.join(tools.root, "Liaison.app")
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
      writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>9.9.9</string>
<key>CFBundleExecutable</key><string>liaison-desktop</string>
</dict></plist>
`,
      )
      writeFileSync(path.join(app, "Contents", "MacOS", "liaison-desktop"), "not a binary")
      tools.presign(app, OURS.hash)
      // The arch comes from lipo, which would refuse a fake executable.
      const lipo = path.join(tools.root, "bin", "lipo")
      writeFileSync(lipo, "#!/bin/bash\necho 'x86_64 arm64'\n")
      chmodSync(lipo, 0o755)
      const out = path.join(tools.root, "out")
      // TMPDIR passed through: on this Mac it is on an external volume, which
      // is where a mount point used to break the script.
      const result = tools.script("make-dmg.sh", [app, out, "--no-notarize"], {
        APPLE_TEAM_ID: OURS.team,
        TMPDIR: process.env.TMPDIR,
      })
      expect(result.err).not.toContain("refusing")
      expect(result.code).toBe(0)
      const image = path.join(out, "Liaison_9.9.9_universal.dmg")
      // On the system volume: hdiutil will not mount on an external one.
      const mount = mkdtempSync("/tmp/dmg-mount-test-")
      scratch.push(mount)
      const attach = Bun.spawnSync([
        "hdiutil",
        "attach",
        image,
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mount,
        "-quiet",
      ])
      expect(attach.exitCode).toBe(0)
      try {
        expect(readlinkSync(path.join(mount, "Applications"))).toBe("/Applications")
        expect(existsSync(path.join(mount, "Liaison.app", "Contents", "Info.plist"))).toBe(true)
      } finally {
        Bun.spawnSync(["hdiutil", "detach", mount, "-quiet"])
      }
    },
    60_000,
  )
})
