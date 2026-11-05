// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasSecurityMarker, tagIsSecurityRelease } from "./release-security-marker"

let repo = ""
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    encoding: "utf8",
  })

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "release-marker-"))
  git("init", "-q")
  writeFileSync(join(repo, "f"), "x")
  git("add", "f")
  git("commit", "-q", "-m", "Security: yes")
  git("tag", "-a", "v1.0.1", "-m", "v1.0.1\n\nSecurity: yes\nFixes a thing")
  git("tag", "-a", "v1.0.2", "-m", "v1.0.2\n\nNothing special")
  git("tag", "v1.0.3")
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe("release security marker", () => {
  it("an annotated tag with a Security: yes line is a security release", () => {
    expect(tagIsSecurityRelease("v1.0.1", repo)).toBe(true)
  })

  it("an annotated tag without the line is not", () => {
    expect(tagIsSecurityRelease("v1.0.2", repo)).toBe(false)
  })

  it("a lightweight tag is not, even if the commit message says Security: yes", () => {
    expect(tagIsSecurityRelease("v1.0.3", repo)).toBe(false)
  })

  it("only an exact line counts", () => {
    expect(hasSecurityMarker("a\nSecurity: yes\r\nb")).toBe(true)
    expect(hasSecurityMarker("Security: yes, maybe")).toBe(false)
    expect(hasSecurityMarker("Not Security: yes")).toBe(false)
  })
})
