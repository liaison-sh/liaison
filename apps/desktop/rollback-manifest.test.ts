// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The rollback.
//
// The two signature gate stops a manifest that is unsigned, half signed, or
// signed over different bytes. It cannot stop one that is perfectly signed and
// functionally broken: the build is real, Apple notarized it, the project
// signed it, and it crashes at launch. By then every installed copy has
// already updated itself.
//
// Tauri's updater compares the manifest's version against the running one and
// installs what it is told, with no notion of "newer". So the way back is to
// publish the PREVIOUS release's manifest again, unchanged: the next check on
// every machine then offers the older build and rolls forward into it.
//
// Two rules this test exists to hold. The bytes are republished exactly as
// fetched (re-signing here would mean the rollback path could mint a manifest,
// which is the one thing the gate must own), and a manifest whose own payload
// no longer verifies is refused rather than shipped a second time.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DOWNLOADS_BASE } from "./ci/downloads"
import type { RollbackIo } from "./ci/rollback-manifest"
import { rollbackManifest } from "./ci/rollback-manifest"

const FIXTURES = path.join(import.meta.dir, "ci/fixtures/updater")
const ARTIFACT = "Liaison_9.9.9_x86_64.AppImage"
const throwawayKey = readFileSync(path.join(FIXTURES, "throwaway.pub"), "utf8")

/** A manifest that still points at the private repository, which is what
 *  every release before the move to downloads.liaison.sh published. */
function githubManifest(state: string): string {
  return manifestFor(state).replace(
    `${DOWNLOADS_BASE}/desktop/9.9.8`,
    "https://github.com/liaison-sh/liaison/releases/download/desktop-v9.9.8",
  )
}

function manifestFor(state: string): string {
  return JSON.stringify(
    {
      version: "9.9.8",
      notes: "## What's new\n\n- The build before the broken one.\n",
      pub_date: "2026-09-01T00:00:00.000Z",
      platforms: {
        "linux-x86_64": {
          signature: readFileSync(path.join(FIXTURES, state, `${ARTIFACT}.sig`), "utf8").trim(),
          url: `${DOWNLOADS_BASE}/desktop/9.9.8/${ARTIFACT}`,
        },
      },
    },
    null,
    2,
  )
}

interface Recorded {
  uploaded: { tag: string; file: string; contents: string }[]
  /** What was published to the public downloads host, which is the copy an
   *  installed machine actually reads. */
  downloads: string[]
  commands: string[][]
}

function io(options: {
  state: string
  manifest?: string
  knownTags?: string[]
  /** What `gh release view --json tagName` answers with no tag: the release
   *  GitHub serves as `releases/latest`, which is what the updater endpoint
   *  resolves. */
  latestTag?: string
  /** What `gh release list --limit 1` answers: the most recently CREATED
   *  release, drafts and pre-releases included. The two differ the moment
   *  anybody drafts a release, and only the first one is read by an installed
   *  copy. */
  listTag?: string
}): RollbackIo & { recorded: Recorded } {
  const recorded: Recorded = { uploaded: [], downloads: [], commands: [] }
  const known = options.knownTags ?? ["desktop-v9.9.8"]
  return {
    recorded,
    run(command) {
      recorded.commands.push(command)
      if (command[1] === "release" && command[2] === "view") {
        const tag = command[3] ?? ""
        // No tag: GitHub answers with the release it serves as `latest`.
        if (tag.startsWith("--")) {
          return {
            code: 0,
            stdout: JSON.stringify({ tagName: options.latestTag ?? "desktop-v9.9.9" }),
            stderr: "",
          }
        }
        if (!known.includes(tag)) {
          return { code: 1, stdout: "", stderr: "release not found" }
        }
        return { code: 0, stdout: JSON.stringify({ tagName: tag }), stderr: "" }
      }
      if (command[1] === "release" && command[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([{ tagName: options.listTag ?? "desktop-v9.9.9" }]),
          stderr: "",
        }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
    fetchAsset(tag, name) {
      if (name !== "latest.json") return undefined
      if (!known.includes(tag)) return undefined
      return options.manifest ?? manifestFor(options.state)
    },
    fetchUrl(_url) {
      return readFileSync(path.join(FIXTURES, options.state, ARTIFACT))
    },
    upload(tag, file, contents) {
      recorded.uploaded.push({ tag, file, contents })
    },
    async publishManifestToDownloads(contents) {
      recorded.downloads.push(contents)
    },
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    log: () => {},
  }
}

describe("the rollback", () => {
  it("re-publishes the named prior tag's latest.json content unchanged", async () => {
    const world = io({ state: "good" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "the 9.9.9 build crashes at launch" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result.rolledBack).toBe(true)
    const manifest = world.recorded.uploaded.find((entry) => entry.file === "latest.json")
    expect(manifest?.contents).toBe(manifestFor("good"))
    expect(manifest?.tag).toBe("desktop-v9.9.9")
  })

  it("lands on the release the updater endpoint reads, not the newest draft", async () => {
    // `gh release list --limit 1` answers with the most recently CREATED
    // release, and that includes drafts and pre-releases. The updater endpoint
    // resolves GitHub's `latest`, which is a different release the moment
    // anybody drafts one: a rollback uploaded onto the draft changes nothing on
    // a single customer machine, and the outage continues while the log says
    // the rollback succeeded.
    const world = io({
      state: "good",
      latestTag: "desktop-v9.9.9",
      listTag: "desktop-v9.9.10-rc1",
    })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "the 9.9.9 build crashes at launch" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({ rolledBack: true, onto: "desktop-v9.9.9" })
    for (const entry of world.recorded.uploaded) {
      expect(entry.tag).toBe("desktop-v9.9.9")
    }
    // And it asks the right question: nothing in the rollback lists releases.
    expect(world.recorded.commands.some((command) => command[2] === "list")).toBe(false)
    expect(
      world.recorded.commands.some(
        (command) => command[2] === "view" && (command[3] ?? "").startsWith("--"),
      ),
    ).toBe(true)
  })

  it("republishes to the downloads host, which is the copy clients read", async () => {
    // The GitHub repository is private, so its release assets answer 404 to
    // every installed copy. A rollback that reached only the release asset
    // would log a success and leave every machine on the broken build.
    const world = io({ state: "good" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "the 9.9.9 build crashes at launch" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result.rolledBack).toBe(true)
    expect(world.recorded.downloads).toEqual([manifestFor("good")])
  })

  it("refuses a prior manifest that points anywhere but the downloads host", async () => {
    // Every release before the move published github.com urls. Republishing
    // one would swap a broken build for an update channel that 404s on every
    // platform, and the log would call it a rollback.
    const world = io({ state: "good", manifest: githubManifest("good") })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "rolling back" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({
      rolledBack: false,
      reason: "the prior manifest does not point at the downloads host",
    })
    expect(world.recorded.uploaded).toEqual([])
    expect(world.recorded.downloads).toEqual([])
  })

  it("records why, beside the manifest, without touching the manifest", async () => {
    const world = io({ state: "good" })
    await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "the 9.9.9 build crashes at launch" },
      { io: world, publicKey: throwawayKey },
    )
    const record = world.recorded.uploaded.find((entry) => entry.file !== "latest.json")
    expect(record?.contents).toContain("the 9.9.9 build crashes at launch")
    expect(record?.contents).toContain("desktop-v9.9.8")
    expect(record?.contents).toContain("2026-09-13T12:00:00.000Z")
  })

  it("refuses a tag that does not exist, and uploads nothing", async () => {
    const world = io({ state: "good" })
    const result = await rollbackManifest(
      { tag: "desktop-v0.0.0-does-not-exist", reason: "typo" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({ rolledBack: false, reason: "tag not found" })
    expect(world.recorded.uploaded).toEqual([])
  })

  it("refuses a rollback with no reason given", async () => {
    const world = io({ state: "good" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "  " },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({ rolledBack: false, reason: "no reason given" })
    expect(world.recorded.uploaded).toEqual([])
  })

  it("refuses to republish a manifest whose own payload no longer verifies", async () => {
    // The manifest is intact and its artifact is not: rolling back into a
    // corrupt build is a second outage, not a recovery.
    const world = io({ state: "tampered-artifact" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "rolling back" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({
      rolledBack: false,
      reason: "the prior manifest's payload does not verify",
    })
    expect(world.recorded.uploaded).toEqual([])
  })

  it("refuses a manifest signed by a key this build does not trust", async () => {
    const world = io({ state: "wrong-key" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "rolling back" },
      { io: world, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({
      rolledBack: false,
      reason: "the prior manifest's payload does not verify",
    })
  })

  it("refuses a release that carries no manifest at all", async () => {
    const world = io({ state: "good", manifest: undefined, knownTags: ["desktop-v9.9.8"] })
    const empty: RollbackIo = { ...world, fetchAsset: () => undefined }
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "rolling back" },
      { io: empty, publicKey: throwawayKey },
    )
    expect(result).toMatchObject({ rolledBack: false, reason: "no latest.json on that release" })
  })

  it("uploads nothing in a dry run, and still says what it would do", async () => {
    const world = io({ state: "good" })
    const result = await rollbackManifest(
      { tag: "desktop-v9.9.8", reason: "rehearsing" },
      { io: world, publicKey: throwawayKey, dryRun: true },
    )
    expect(result).toMatchObject({ rolledBack: true })
    expect(world.recorded.uploaded).toEqual([])
    expect(result.rolledBack === true && result.manifest).toBe(manifestFor("good"))
    expect(world.recorded.downloads).toEqual([])
  })
})
