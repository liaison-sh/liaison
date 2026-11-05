// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A seeded person has NO uploaded picture. The product's own initials disc
// (the app font on the shared avatar palette) is the look the review kept; a
// seed that uploads a drawn monogram puts a foreign typeface in every header
// stack, which is exactly what got rejected. Pinned at the source, because the
// upload path is one import away from coming back.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SEED = readFileSync(join(import.meta.dir, "seed-org.ts"), "utf-8")
/** The people factory the demo tier writes a person's profile through. */
const PEOPLE = readFileSync(join(import.meta.dir, "../../factories/people/people.ts"), "utf-8")

describe("the demo seed and people's pictures", () => {
  it("uploads no avatar image and imports no monogram generator", () => {
    for (const src of [SEED, PEOPLE]) {
      expect(src).not.toMatch(/renderDemoAvatar|demoAvatarKey|from "\.\/avatars"/)
      expect(src).not.toMatch(/putObject\(/)
      expect(src).not.toMatch(/avatarStorageKey|AVATAR_STORED_MIME/)
    }
  })

  it("clears any picture an earlier seed stored, so a reseed converges on the initials disc", () => {
    expect(SEED).toContain("writePersonProfile(orgId, person.userId")
    expect(PEOPLE).toMatch(/set\(\{ settings, avatarKey: null, avatarUrl: null \}\)/)
  })
})
