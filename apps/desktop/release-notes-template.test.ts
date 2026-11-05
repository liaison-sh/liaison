// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The release notes template is customer copy: it becomes the `notes` field of
// the updater manifest, and the updater shows that text inside the app. So it
// carries the same rule the rest of the customer-visible surface does, no dash
// punctuation, and it carries it HERE rather than in a reviewer's memory at
// release time, when the template is copied and filled in a hurry.
//
// The lint is over the template because the template is what gets copied: a
// dash in the shipped example is a dash in every release that starts from it.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { findDashPunctuation } from "./ci/no-dash"

const TEMPLATE = path.join(import.meta.dir, "ci", "RELEASE_NOTES_TEMPLATE.md")
const template = readFileSync(TEMPLATE, "utf8")

// The rule itself lives in ci/no-dash.ts, where the publish gate reads it too:
// a clean template is worth little if the notes actually shipped are pasted in
// at release time and linted by nothing.

describe("the desktop release notes template", () => {
  it("carries no dash punctuation", () => {
    const offenders = findDashPunctuation(template)
    expect(offenders.map((entry) => `${entry.line}: ${entry.text}`)).toEqual([])
  })

  it("is the shape the updater manifest's notes field expects", () => {
    expect(template).toContain("## What's new")
    expect(template).toMatch(/^- /m)
  })

  it("is plain ASCII, because the manifest is read by an updater and by eye", () => {
    const nonAscii = [...template].filter((character) => character.charCodeAt(0) > 127)
    expect(nonAscii).toEqual([])
  })

  it("says where the text ends up, so nobody treats it as an internal changelog", () => {
    expect(template.toLowerCase()).toContain("updater")
  })

  it("names no version of its own: the version comes from the tag", () => {
    // A template with a real version in it ships that version forever.
    expect(template).not.toMatch(/\b\d+\.\d+\.\d+\b/)
  })
})

// THE SHIPPED NOTES, under the same rules, when they exist: this is the text a
// customer reads in the update prompt, and the template's lint is worth
// nothing if the file actually published is checked by nobody.
const NOTES = path.join(import.meta.dir, "ci", "RELEASE_NOTES.md")

describe("the desktop release notes to ship", () => {
  const notes = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : null
  const when = notes === null ? it.skip : it

  when("carry no dash punctuation", () => {
    const offenders = findDashPunctuation(notes as string)
    expect(offenders.map((entry) => `${entry.line}: ${entry.text}`)).toEqual([])
  })

  when("are the shape the updater manifest's notes field expects", () => {
    expect(notes).toContain("## What's new")
    expect(notes).toMatch(/^- /m)
  })

  when("are plain ASCII", () => {
    const nonAscii = [...(notes as string)].filter((character) => character.charCodeAt(0) > 127)
    expect(nonAscii).toEqual([])
  })

  when("carry none of the template's own instructions", () => {
    expect(notes).not.toContain("Copy this file")
    expect(notes).not.toMatch(/^> /m)
  })

  when("name no version of their own: the version comes from the tag", () => {
    expect(notes).not.toMatch(/[0-9]+[.][0-9]+[.][0-9]+/)
  })
})
