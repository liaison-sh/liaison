// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/quickstart.sh's channel handling, with `docker` and `curl` replaced by
// shims on PATH, in a copy of the deploy directory: it writes deploy/.env next to
// itself.
import { afterEach, describe, expect, it } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DEPLOY = import.meta.dir
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "quickstart-"))
  dirs.push(root)
  const deploy = join(root, "deploy")
  const bin = join(root, "bin")
  mkdirSync(deploy)
  mkdirSync(bin)
  for (const f of ["quickstart.sh", "docker-compose.yml", ".env.example"]) {
    copyFileSync(join(DEPLOY, f), join(deploy, f))
  }
  const log = join(root, "docker.log")
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  pull*) [ -z "\${FAIL_PULL:-}" ] || exit 1 ;;
  *logs*) echo "Liaison setup token: the-token" ;;
esac
exit 0
`,
  )
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
echo '{"status":"ok","dependencies":{"db":"ok","redis":"ok"}}'
`,
  )
  chmodSync(join(bin, "docker"), 0o755)
  chmodSync(join(bin, "curl"), 0o755)
  const run = (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync(["bash", join(deploy, "quickstart.sh"), ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: proc.exitCode, stderr: proc.stderr.toString() }
  }
  const envValue = (key: string) =>
    new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(join(deploy, ".env"), "utf8"))?.[1]
  const docker = () => readFileSync(log, "utf8")
  return { run, envValue, docker }
}

describe("quickstart.sh --channel", () => {
  it("defaults to the release channel and its image", () => {
    const s = sandbox()
    expect(s.run([]).code).toBe(0)
    expect(s.docker()).toContain("pull ghcr.io/mathieufro/liaison:latest")
    expect(s.envValue("LIAISON_RELEASE_CHANNEL")).toBe("release")
    expect(s.envValue("LIAISON_IMAGE")).toBe("ghcr.io/mathieufro/liaison:latest")
  })

  it("--channel nightly picks the nightly image and sets the variable", () => {
    const s = sandbox()
    expect(s.run(["--channel", "nightly"]).code).toBe(0)
    expect(s.docker()).toContain("pull ghcr.io/mathieufro/liaison:nightly")
    expect(s.docker()).not.toContain("liaison:latest")
    expect(s.envValue("LIAISON_RELEASE_CHANNEL")).toBe("nightly")
    expect(s.envValue("LIAISON_IMAGE")).toBe("ghcr.io/mathieufro/liaison:nightly")
  })

  it("a plain rerun keeps the channel in deploy/.env, so it never moves a nightly back", () => {
    const s = sandbox()
    expect(s.run(["--channel", "nightly"]).code).toBe(0)
    expect(s.run([]).code).toBe(0)
    expect(s.docker()).not.toContain("liaison:latest")
    expect(s.envValue("LIAISON_RELEASE_CHANNEL")).toBe("nightly")
  })

  it("falls back to the local build when the channel's image is unreachable", () => {
    const s = sandbox()
    expect(s.run(["--channel", "nightly"], { FAIL_PULL: "1" }).code).toBe(0)
    expect(s.docker()).toContain("build -t liaison:local")
    expect(s.envValue("LIAISON_IMAGE")).toBe("liaison:local")
    expect(s.envValue("LIAISON_RELEASE_CHANNEL")).toBe("nightly")
  })

  it("refuses an unknown channel", () => {
    const s = sandbox()
    const r = s.run(["--channel", "beta"])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("unknown channel: beta")
  })
})
