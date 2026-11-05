// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The TEST channel (ci/channel.ts) never touches what customers download.
//
// A test build is signed with the real keys, so a test build that reached
// desktop/latest.json or desktop/<version>/ would be offered, and installed,
// on every customer's machine. That is the one thing this file exists to make
// impossible, and it asserts it three ways: the downloads layout routes a test
// version under desktop/test/ by its version alone, the mirror refuses any
// plan with a key outside its channel, and the workflow's production publish
// never runs on the test channel while the test publish never runs on a tag.
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { configuredVersion } from "./ci/artifact-names"
import {
  CHANNEL_ENV,
  channelBuild,
  checkChannel,
  productionRefusal,
  TEST_VERSION_ENV,
  tauriConfigArgs,
} from "./ci/channel"
import {
  ALIAS_PREFIX,
  DOWNLOADS_BASE,
  keyInChannel,
  MANIFEST_KEY,
  type ManifestShape,
  manifestKeyFor,
  manifestPayloadNames,
  TEST_MANIFEST_KEY,
  TEST_UPDATER_ENDPOINT,
  versionPrefix,
} from "./ci/downloads"
import { type MirrorFile, planMirror } from "./ci/mirror-to-downloads"
import { rollbackManifest } from "./ci/rollback-manifest"
import { tauriBuildCommand } from "./ci/tauri-build"
import { publishManifest } from "./ci/verify-and-publish"
import { type Job, loadDesktopReleaseWorkflow, step } from "./ci/workflow"

const TEST = "0.1.10-test.1"
const RELEASE = "0.1.10"

function manifestFor(version: string, prefix = versionPrefix(version)): ManifestShape {
  return {
    version,
    notes: "Test build.\n",
    platforms: {
      "windows-x86_64": {
        signature: "sig-windows",
        url: `${DOWNLOADS_BASE}/${prefix}/Liaison_${version}_x86_64.exe`,
      },
    },
  }
}

function filesFor(version: string): MirrorFile[] {
  return [`Liaison_${version}_x86_64.exe`, `Liaison_${version}_x86_64.exe.sig`].map((name) => ({
    name,
    path: `/tmp/release-artifacts/${name}`,
    size: 100,
  }))
}

const MANIFEST_FILE: MirrorFile = { name: "latest.json", path: "/tmp/latest.json", size: 512 }

describe("the test channel on the downloads host", () => {
  it("routes a test version under desktop/test/ by its version alone", () => {
    expect(versionPrefix(TEST)).toBe(`desktop/test/${TEST}`)
    expect(manifestKeyFor(TEST)).toBe(TEST_MANIFEST_KEY)
    expect(TEST_MANIFEST_KEY).toBe("desktop/test/latest.json")
    expect(TEST_UPDATER_ENDPOINT).toBe("https://downloads.liaison.sh/desktop/test/latest.json")
    // A release is exactly where it always was.
    expect(versionPrefix(RELEASE)).toBe(`desktop/${RELEASE}`)
    expect(manifestKeyFor(RELEASE)).toBe(MANIFEST_KEY)
    expect(MANIFEST_KEY).toBe("desktop/latest.json")
    // Nothing that is not a test version can name the test directory.
    expect(() => versionPrefix("test")).toThrow()
    expect(() => versionPrefix("test/0.1.10")).toThrow()
  })

  it("plans a test build with no key a customer's copy reads", () => {
    const steps = planMirror({
      manifest: manifestFor(TEST),
      verified: manifestFor(TEST),
      files: filesFor(TEST),
      manifestFile: MANIFEST_FILE,
    })
    expect(steps.length).toBeGreaterThan(0)
    for (const { key } of steps) {
      expect(key.startsWith("desktop/test/"), key).toBe(true)
      expect(key).not.toBe(MANIFEST_KEY)
      expect(key.startsWith(`${ALIAS_PREFIX}/`), key).toBe(false)
      expect(key.startsWith(`desktop/${TEST}/`), key).toBe(false)
    }
    expect(steps.at(-1)?.key).toBe(TEST_MANIFEST_KEY)
    // No stable download links: those are the customers' download page.
    expect(steps.filter((entry) => entry.stage === "alias")).toHaveLength(0)
  })

  it("refuses a test manifest whose urls point anywhere but desktop/test/", () => {
    const stray = manifestFor(TEST, `desktop/${TEST}`)
    expect(() => manifestPayloadNames(stray)).toThrow(/not under/)
    expect(() =>
      planMirror({
        manifest: stray,
        verified: stray,
        files: filesFor(TEST),
        manifestFile: MANIFEST_FILE,
      }),
    ).toThrow()
  })

  it("keeps every key of a release outside desktop/test/", () => {
    expect(keyInChannel(`desktop/${RELEASE}/x.exe`, RELEASE)).toBe(true)
    expect(keyInChannel(MANIFEST_KEY, RELEASE)).toBe(true)
    expect(keyInChannel(TEST_MANIFEST_KEY, RELEASE)).toBe(false)
    expect(keyInChannel(TEST_MANIFEST_KEY, TEST)).toBe(true)
    expect(keyInChannel(MANIFEST_KEY, TEST)).toBe(false)
    expect(keyInChannel(`desktop/${TEST}/x.exe`, TEST)).toBe(false)
  })

  it("orders test versions below the release they lead to, and above the one before", () => {
    // tauri's updater offers an update when the manifest's version is GREATER
    // (semver, the same rules as Bun's): a test build is offered the next
    // test build, and the numbers stay numeric (test.10 after test.2).
    const order = ["0.1.9", "0.1.10-test.1", "0.1.10-test.2", "0.1.10-test.10", "0.1.10"]
    for (let index = 1; index < order.length; index += 1) {
      expect(
        Bun.semver.order(order[index - 1] as string, order[index] as string),
        `${order[index - 1]} < ${order[index]}`,
      ).toBe(-1)
    }
  })
})

describe("the channel a build is asked for", () => {
  it("is production when nothing is set, as on a tag push", () => {
    expect(channelBuild({})).toEqual({ channel: "production" })
    expect(channelBuild({ [CHANNEL_ENV]: "", [TEST_VERSION_ENV]: "" })).toEqual({
      channel: "production",
    })
    expect(tauriConfigArgs({ channel: "production" })).toEqual([])
  })

  it("refuses anything that is not exactly production or a well formed test build", () => {
    expect(() => channelBuild({ [CHANNEL_ENV]: "tset", [TEST_VERSION_ENV]: TEST })).toThrow()
    expect(() => channelBuild({ [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: "0.1.10" })).toThrow()
    expect(() => channelBuild({ [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: "" })).toThrow()
    expect(() => channelBuild({ [CHANNEL_ENV]: "", [TEST_VERSION_ENV]: TEST })).toThrow()
    expect(checkChannel({ channel: "test", version: TEST }, "true")).toMatch(/dry_run=false/)
    expect(checkChannel({ channel: "test", version: TEST }, "false")).toBeNull()
  })

  it("accepts the channel exactly as typed, never a trimmed look alike", () => {
    // The re-review's blocker: " test" was trimmed into the test channel by
    // the scripts while the workflow, comparing the raw input, took the
    // PRODUCTION publish. A build stamped as a test and published as a
    // release. Anything but exactly "" or "test" now fails the run.
    for (const channel of [" test", "test ", "Test", "test\n", " "]) {
      expect(
        () => channelBuild({ [CHANNEL_ENV]: channel, [TEST_VERSION_ENV]: TEST }),
        JSON.stringify(channel),
      ).toThrow()
    }
    expect(() => channelBuild({ [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: ` ${TEST}` })).toThrow()
    expect(() => channelBuild({ [CHANNEL_ENV]: "", [TEST_VERSION_ENV]: " " })).toThrow()
  })

  it("hands tauri build the channel's config, in the command it actually spawns", () => {
    const env = { [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: TEST }
    const command = tauriBuildCommand(["--bundles", "nsis"], env)
    expect(command.slice(0, 5)).toEqual(["bunx", "tauri", "build", "--bundles", "nsis"])
    expect(command.slice(5)).toEqual(tauriConfigArgs(channelBuild(env)))
    expect(tauriBuildCommand(["--bundles", "nsis"], {})).toEqual([
      "bunx",
      "tauri",
      "build",
      "--bundles",
      "nsis",
    ])
    // And that command is the one the script runs.
    const source = readFileSync(path.join(import.meta.dir, "ci/tauri-build.ts"), "utf8")
    const main = source.slice(source.indexOf("if (import.meta.main)"))
    expect(main).toContain("const command = tauriBuildCommand(process.argv.slice(2), process.env)")
    expect(main).toContain("Bun.spawn(command,")
    expect(main.match(/Bun\.spawn\(/g)).toHaveLength(1)
  })

  it("stamps the version and points the updater at the test manifest, by a config merge", () => {
    const build = channelBuild({ [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: TEST })
    const args = tauriConfigArgs(build)
    expect(args[0]).toBe("--config")
    expect(JSON.parse(args[1] as string)).toEqual({
      version: TEST,
      plugins: { updater: { endpoints: [TEST_UPDATER_ENDPOINT] } },
    })
    // Every artifact name follows the stamped version, not the file on disk.
    const root = mkdtempSync(path.join(tmpdir(), "liaison-channel-"))
    const conf = path.join(root, "src-tauri")
    mkdirSync(conf)
    writeFileSync(path.join(conf, "tauri.conf.json"), JSON.stringify({ version: "0.1.9" }))
    expect(configuredVersion(root, {})).toBe("0.1.9")
    expect(configuredVersion(root, { [CHANNEL_ENV]: "test", [TEST_VERSION_ENV]: TEST })).toBe(TEST)
  })
})

describe("the release workflow keeps the channels apart", () => {
  const workflow = loadDesktopReleaseWorkflow()
  const job = (name: string) => workflow.jobs[name] as Job & { permissions?: unknown }
  const unwrap = (value: string | undefined) =>
    (value ?? "").replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "")

  it("never runs the production publish or its mirror on the test channel", () => {
    const publish = job("publish-manifest") as unknown as { if?: string }
    expect(unwrap(publish.if)).toContain("inputs.channel == ''")
    const mirror = step(
      job("publish-manifest").steps,
      "Mirror the release to the public downloads host",
    )
    expect(unwrap(mirror.if)).toContain("inputs.channel == ''")
  })

  it("runs the production publish only when the channel is EXACTLY empty", () => {
    // `!= 'test'` let " test" through. Equality with '' holds on a tag push
    // too: there the input is null, and GitHub compares null and '' equal.
    const publish = job("publish-manifest") as unknown as { if?: string }
    expect(unwrap(publish.if)).toBe("!inputs.dry_run && inputs.channel == ''")
    for (const name of ["build-macos", "build-windows", "build-linux"]) {
      const build = job(name) as unknown as { if?: string }
      expect(unwrap(build.if).startsWith("(!inputs.dry_run && inputs.channel == '')"), name).toBe(
        true,
      )
    }
    // And the job refuses for itself, from what it downloaded, before the
    // gate: whatever the condition above ever becomes.
    const steps = job("publish-manifest").steps
    const refuse = step(steps, "Refuse anything but a production build")
    expect(refuse.run ?? "").toContain(
      "apps/desktop/ci/channel.ts production-only --artifacts release-artifacts",
    )
    const names = steps.map((entry) => entry.name)
    expect(names.indexOf("Refuse anything but a production build")).toBeGreaterThan(
      names.indexOf("Download the platform artifacts"),
    )
    expect(names.indexOf("Refuse anything but a production build")).toBeLessThan(
      names.indexOf("Describe the release to publish"),
    )
  })

  it("runs the test publish on the test channel only, never on a tag push", () => {
    const test = job("publish-test-channel") as unknown as { if?: string }
    expect(unwrap(test.if)).toContain("inputs.channel == 'test'")
    expect(unwrap(test.if)).toContain("!inputs.dry_run")
    // No GitHub release for a build with no tag, and no write token at all.
    expect(job("publish-test-channel").permissions).toEqual({ contents: "read" })
    const runs = job("publish-test-channel")
      .steps.map((entry) => entry.run ?? "")
      .join("\n")
    expect(runs).toContain("verify-and-publish.ts --request publish-request.json --dry-run")
    expect(runs).toContain("apps/desktop/ci/mirror-to-downloads.ts")
    expect(runs).not.toContain("gh release")
  })

  it("hands every job the channel from the dispatch inputs alone", () => {
    const env = (workflow as unknown as { env?: Record<string, string> }).env ?? {}
    expect(env[CHANNEL_ENV]).toBe(`$${"{{"} inputs.channel }}`)
    expect(env[TEST_VERSION_ENV]).toBe(`$${"{{"} inputs.version }}`)
  })
})

describe("the production publish refuses a test build on its own", () => {
  it("refuses a channel that is not exactly empty, and any test stamped artifact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "liaison-prod-only-"))
    mkdirSync(path.join(dir, "liaison-desktop-windows"))
    writeFileSync(path.join(dir, "liaison-desktop-windows", `Liaison_${RELEASE}_x86_64.exe`), "")
    expect(productionRefusal({}, dir)).toBeNull()
    expect(productionRefusal({ [CHANNEL_ENV]: "" }, dir)).toBeNull()
    expect(productionRefusal({ [CHANNEL_ENV]: " test" }, dir)).toMatch(/channel/)
    expect(productionRefusal({ [TEST_VERSION_ENV]: TEST }, dir)).toMatch(/version/)
    writeFileSync(path.join(dir, "liaison-desktop-windows", `Liaison_${TEST}_x86_64.exe`), "")
    expect(productionRefusal({}, dir)).toMatch(new RegExp(TEST.replaceAll(".", "\\.")))
  })

  it("never publishes a test version as a release, nor rolls back onto one", async () => {
    const published = publishManifest(
      {
        version: TEST,
        notes: "Test build.\n",
        tag: `desktop-v${TEST}`,
        platforms: [
          {
            key: "windows-x86_64",
            os: "windows",
            archive: "/nonexistent.exe",
            signature: "/nonexistent.exe.sig",
            installer: "/nonexistent.exe",
            url: `${DOWNLOADS_BASE}/${versionPrefix(TEST)}/Liaison_${TEST}_x86_64.exe`,
          },
        ],
      } as unknown as Parameters<typeof publishManifest>[0],
      { dryRun: false, publicKey: "unused" },
    )
    expect(published.published).toBe(false)
    expect(published.published ? "" : published.reason).toMatch(/test build/)
    const rolled = await rollbackManifest(
      { tag: "desktop-v0.1.9", reason: "drill" },
      {
        publicKey: "unused",
        io: {
          run: () => ({ code: 0, stdout: "{}", stderr: "" }),
          fetchAsset: () => JSON.stringify(manifestFor(TEST)),
          fetchUrl: () => Buffer.from(""),
          upload: () => {},
          publishManifestToDownloads: async () => {},
          now: () => new Date(0),
          log: () => {},
        } as unknown as Parameters<typeof rollbackManifest>[1] extends infer O
          ? O extends { io?: infer I }
            ? I
            : never
          : never,
      },
    )
    expect(rolled.rolledBack).toBe(false)
    expect(rolled.rolledBack ? "" : rolled.reason).toMatch(/test build/)
  })
})
