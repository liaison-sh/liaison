// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The checklist is read by a person, once, under time pressure, with a store
// review waiting. So the things it must not lose are pinned here: the two
// store headings, the redaction rule it exists to carry into a privacy form,
// every credential name the workflow actually reads, and the repository wide
// no dash rule, which applies to it like it applies to anything a human reads.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { findDashPunctuation } from "../desktop/ci/no-dash"
import { ANDROID_SIGNING_SECRETS, IOS_SIGNING_SECRETS } from "./ci/signing-marker"

const CHECKLIST_PATH = path.join(import.meta.dir, "STORE_CHECKLIST.md")
const checklist = readFileSync(CHECKLIST_PATH, "utf8")

describe("the store submission checklist", () => {
  it("covers both stores", () => {
    expect(checklist).toContain("## App Store Connect")
    expect(checklist).toContain("## Google Play")
  })

  it("names every credential the release workflow reads", () => {
    // A checklist that names a secret the workflow does not read, or misses
    // one it does, sends somebody to create the wrong thing.
    for (const name of [...IOS_SIGNING_SECRETS, ...ANDROID_SIGNING_SECRETS]) {
      expect(checklist, `${name} is not in the checklist`).toContain(name)
    }
  })

  it("carries the push redaction rule into the privacy section", () => {
    expect(checklist).toContain("redact.ts")
    expect(checklist.toLowerCase()).toContain("no required scopes")
  })

  it("states the identifiers, the deep link scheme and the single build rule", () => {
    expect(checklist).toContain("sh.liaison.mobile")
    expect(checklist).toContain("liaison")
    expect(checklist).toContain("(D13)")
  })

  it("carries no dash punctuation", () => {
    const offences = findDashPunctuation(checklist)
    expect(
      offences.map((entry) => `line ${entry.line}: ${entry.text}`),
      "dash punctuation in the checklist",
    ).toEqual([])
  })
})
