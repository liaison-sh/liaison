// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SECURITY.md is the disclosure path and the support promise of a public
// repository, so it must stay true to what the repository ships: the reporting
// link is this repository's security page (and the issue chooser sends people
// to the same place), and every deliverable that gets security fixes, the
// server image, the desktop app and the mobile app, says which version does.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const policy = read("SECURITY.md")
const supported = policy.split(/^## /m).find((s) => s.startsWith("Supported versions")) ?? ""

describe("SECURITY.md", () => {
  it("sends reports to this repository's private reporting page, as the issue chooser does", () => {
    const url = "https://github.com/mathieufro/liaison/security"
    expect(policy).toContain(`(${url})`)
    expect(read(".github/ISSUE_TEMPLATE/config.yml")).toContain(`url: ${url}`)
    expect(policy).toMatch(/Report a vulnerability/)
  })

  it("names the server release line the release workflow publishes", () => {
    const workflow = read(".github/workflows/release.yml")
    expect(workflow).toContain('- "v[0-9]+.[0-9]+.[0-9]+"')
    expect(workflow).toContain("IMAGE: ghcr.io/mathieufro/liaison")
    expect(supported).toContain("ghcr.io/mathieufro/liaison")
    expect(supported).toMatch(/`vX\.Y\.Z`/)
    // Fixes land on main first, which is also all there is before a first release.
    expect(supported).toMatch(/`main`/)
  })

  it("says which desktop and mobile versions get fixes", () => {
    if (existsSync(join(ROOT, "apps/desktop"))) expect(supported).toMatch(/desktop app/i)
    if (existsSync(join(ROOT, "apps/mobile"))) expect(supported).toMatch(/mobile app/i)
  })
})
