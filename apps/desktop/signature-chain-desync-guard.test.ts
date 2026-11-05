// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desync guard.
//
// Buzz shipped a release whose DMG was notarized and whose updater signature
// belonged to different bytes. Every check in its pipeline passed: the
// notarization was real, the signature was real, and they were over two
// different files. An installed copy downloaded the payload, failed the
// updater's own verification, and stopped updating.
//
// The shape that produces it is ordinary: an artifact is signed, then
// something touches it again (a rename that rewrites, a repack, a re-sign, a
// step retried by hand), and no single check compares before with after. So
// the signing step records the bytes it signed, in a sibling `.sha256`, and
// the gate re-computes and compares FIRST, before either signature is looked
// at. A mismatch there names the real problem; the same release reaching the
// updater check instead reads as a tampered artifact and sends whoever is on
// call looking for an attacker.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DOWNLOADS_BASE } from "./ci/downloads"
import {
  assertArtifactChecksumMatchesSignedInput,
  type GateIo,
  type PublishRequest,
  publishManifest,
  realIo,
} from "./ci/verify-and-publish"

const FIXTURES = path.join(import.meta.dir, "ci/fixtures/updater")
const ARTIFACT = "Liaison_9.9.9_x86_64.AppImage"
const throwawayKey = readFileSync(path.join(FIXTURES, "throwaway.pub"), "utf8")

function io(): GateIo {
  return {
    ...realIo,
    run: () => {
      throw new Error("the gate ran a command in a dry run")
    },
    writeText: () => {
      throw new Error("the gate wrote a file in a dry run")
    },
    which: () => false,
    now: () => new Date("2026-09-13T00:00:00.000Z"),
    warn: () => {},
  }
}

function request(state: string): PublishRequest {
  const archive = path.join(FIXTURES, state, ARTIFACT)
  return {
    version: "9.9.9",
    notes: "## What's new\n\n- The fixture release.\n",
    tag: "desktop-v9.9.9",
    platforms: [
      {
        key: "linux-x86_64",
        os: "linux",
        archive,
        signature: `${archive}.sig`,
        installer: archive,
        url: `${DOWNLOADS_BASE}/desktop/9.9.9/${ARTIFACT}`,
      },
    ],
  }
}

describe("assertArtifactChecksumMatchesSignedInput", () => {
  it("passes when the recorded checksum matches the artifact on disk", () => {
    const outcome = assertArtifactChecksumMatchesSignedInput(
      path.join(FIXTURES, "good", ARTIFACT),
      io(),
    )
    expect(outcome.ok).toBe(true)
  })

  it("refuses when the artifact was modified after it was signed", () => {
    const outcome = assertArtifactChecksumMatchesSignedInput(
      path.join(FIXTURES, "tampered-artifact", ARTIFACT),
      io(),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain("changed after it was signed")
  })

  it("refuses when nothing recorded what was signed", () => {
    // No `.sha256` at all: the signing step did not run, or ran somewhere the
    // artifact did not come from. Either way there is nothing to compare
    // against, and "nothing to compare" is not a pass.
    const directory = mkdtempSync(path.join(tmpdir(), "desync-"))
    const orphan = path.join(directory, ARTIFACT)
    writeFileSync(orphan, "an artifact nobody recorded")
    const outcome = assertArtifactChecksumMatchesSignedInput(orphan, io())
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain("no recorded checksum")
  })
})

describe("the gate's desync refusal", () => {
  it("names the desync rather than reading as a tampered artifact", () => {
    const result = publishManifest(request("tampered-artifact"), {
      io: io(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({
      published: false,
      reason: "the artifact does not match the bytes that were signed",
    })
  })

  it("still publishes the good fixture, so the guard is not simply refusing", () => {
    const result = publishManifest(request("good"), {
      io: io(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result.published).toBe(true)
  })
})
