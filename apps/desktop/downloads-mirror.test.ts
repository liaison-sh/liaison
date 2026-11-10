// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mirror onto the public downloads host.
//
// The GitHub repository is private, so its release assets and its
// releases/latest/download answer 404 to every anonymous client. Nothing an
// installed copy or a customer can do fixes that, so the public surface is the
// R2 bucket behind downloads.liaison.sh and the release is copied there.
//
// One property decides whether that copy is safe, and it is the ORDER.
// latest.json is acted on by every installed machine with no human in the
// loop, and it names its payloads by url. Written before those payloads exist,
// it sends every machine that polls in the gap at a 404. So the plan is built
// as data, and this file asserts the order, the refusals, the aliases the
// download page links, the cache lifetimes, the transport (streamed from a
// file, never buffered: the disk image is past 100 MB), the cache busting read
// backs, the bounded retries, and that a credential never reaches a log.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ALIAS_PREFIX,
  ALIASES,
  aliasSource,
  DOWNLOADS_BASE,
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_KEY,
  MAX_SINGLE_PUT_BYTES,
  type ManifestShape,
  ROLLING_CACHE_CONTROL,
} from "./ci/downloads"
import {
  isRetryableStatus,
  type MirrorFile,
  type MirrorIo,
  type MirrorStep,
  manifestDifferences,
  planMirror,
  RETRY_ATTEMPTS,
  realUploader,
  redact,
  runMirror,
  TransportError,
} from "./ci/mirror-to-downloads"

const VERSION = "9.9.9"
const ARTIFACTS = [
  `Liaison_${VERSION}_aarch64.app.tar.gz`,
  `Liaison_${VERSION}_aarch64.app.tar.gz.sig`,
  `Liaison_${VERSION}_aarch64.app.tar.gz.sha256`,
  `Liaison_${VERSION}_aarch64.dmg`,
  `Liaison_${VERSION}_x86_64.exe`,
  `Liaison_${VERSION}_x86_64.exe.sig`,
  `Liaison_${VERSION}_x86_64.exe.sha256`,
  `Liaison_${VERSION}_x86_64.AppImage`,
  `Liaison_${VERSION}_x86_64.AppImage.sig`,
  `Liaison_${VERSION}_x86_64.AppImage.sha256`,
  `Liaison_${VERSION}_x86_64.deb`,
  "SHA256SUMS",
]

function files(names: string[] = ARTIFACTS, sizeOf?: (name: string) => number): MirrorFile[] {
  return names.map((name, index) => ({
    name,
    path: `/tmp/release-artifacts/${name}`,
    size: sizeOf ? sizeOf(name) : 100 + index,
  }))
}

const MANIFEST_FILE: MirrorFile = { name: "latest.json", path: "/tmp/latest.json", size: 512 }

function manifest(): ManifestShape {
  return {
    version: VERSION,
    notes: "## What's new\n\n- The fixture release.\n",
    platforms: {
      "darwin-aarch64": {
        signature: "sig-macos",
        url: `${DOWNLOADS_BASE}/desktop/${VERSION}/Liaison_${VERSION}_aarch64.app.tar.gz`,
      },
      "windows-x86_64": {
        signature: "sig-windows",
        url: `${DOWNLOADS_BASE}/desktop/${VERSION}/Liaison_${VERSION}_x86_64.exe`,
      },
      "linux-x86_64": {
        signature: "sig-linux",
        url: `${DOWNLOADS_BASE}/desktop/${VERSION}/Liaison_${VERSION}_x86_64.AppImage`,
      },
    },
  }
}

function plan(
  options: { manifest?: ManifestShape; verified?: ManifestShape; files?: MirrorFile[] } = {},
): MirrorStep[] {
  const onDisk = options.manifest ?? manifest()
  return planMirror({
    manifest: onDisk,
    verified: options.verified ?? onDisk,
    files: options.files ?? files(),
    manifestFile: MANIFEST_FILE,
  })
}

describe("the mirror plan", () => {
  it("writes latest.json last, after every file it names and every alias", () => {
    // The whole safety property. A manifest published first is a window in
    // which every machine that polls downloads a 404 from a url the project
    // published itself.
    const steps = plan()
    const stages = steps.map((step) => step.stage)
    expect(stages.at(-1)).toBe("manifest")
    expect(steps.at(-1)?.key).toBe(MANIFEST_KEY)
    expect(stages.filter((stage) => stage === "manifest")).toHaveLength(1)
    const firstAlias = stages.indexOf("alias")
    const lastVersioned = stages.lastIndexOf("versioned")
    expect(firstAlias).toBeGreaterThan(lastVersioned)
    expect(stages.indexOf("manifest")).toBeGreaterThan(stages.lastIndexOf("alias"))
  })

  it("puts every artifact under its own version, and nothing under another", () => {
    const versioned = plan().filter((step) => step.stage === "versioned")
    expect(versioned).toHaveLength(ARTIFACTS.length)
    for (const step of versioned) {
      expect(step.key.startsWith(`desktop/${VERSION}/`)).toBe(true)
    }
    expect(versioned.map((step) => step.key.split("/").at(-1)).sort()).toEqual(
      [...ARTIFACTS].sort(),
    )
  })

  it("refuses a manifest that is not the one the two signature gate verified", () => {
    // The gate writes latest.json and this script reads it back off the same
    // runner. A file that differs is from another run or was edited between
    // the two steps, and it is the file every installed copy would act on.
    const onDisk = manifest()
    const gated = manifest()
    gated.platforms["linux-x86_64"] = {
      signature: "a-different-signature",
      url: gated.platforms["linux-x86_64"]?.url ?? "",
    }
    expect(() => plan({ manifest: onDisk, verified: gated })).toThrow(
      "not the one the two signature gate verified",
    )
    expect(() => plan({ manifest: onDisk, verified: gated })).toThrow("linux-x86_64")
  })

  it("reports every way the two manifests differ, and nothing when they agree", () => {
    expect(manifestDifferences(manifest(), manifest())).toEqual([])
    const other = manifest()
    other.version = "9.9.8"
    delete other.platforms["windows-x86_64"]
    const differences = manifestDifferences(other, manifest())
    expect(differences.join("\n")).toContain("9.9.8")
    expect(differences.join("\n")).toContain("windows-x86_64")
  })

  it("refuses release notes that were edited after the gate read them", () => {
    // The notes are the one field a human writes and they reach a customer
    // inside the update prompt, so an edit between the gate and the mirror
    // publishes copy nothing linted and nothing verified.
    const edited = manifest()
    edited.notes = "## What's new\n\n- Something else entirely.\n"
    expect(() => plan({ manifest: edited, verified: manifest() })).toThrow("release notes")
  })

  it("does not compare pub_date, which the gate stamps afresh on every run", () => {
    // The mirror re-runs the gate, so the manifest it gets back always
    // carries a later pub_date than the file on disk. Comparing it would
    // refuse every release that is fine.
    const stamped = { ...manifest(), pub_date: "2026-09-21T00:00:00.000Z" } as ManifestShape
    const later = { ...manifest(), pub_date: "2026-09-21T00:05:00.000Z" } as ManifestShape
    expect(manifestDifferences(stamped, later)).toEqual([])
  })

  it("refuses a manifest that still points at the private repository", () => {
    // github.com asset urls answer 404 to every client, so mirroring that
    // manifest would publish a dead update channel to the one host clients
    // do read.
    const broken = manifest()
    broken.platforms["linux-x86_64"] = {
      signature: "sig-linux",
      url: `https://github.com/liaison-sh/liaison/releases/download/desktop-v${VERSION}/Liaison_${VERSION}_x86_64.AppImage`,
    }
    expect(() => plan({ manifest: broken, verified: broken })).toThrow("github.com")
  })

  it("refuses a manifest naming an artifact the directory does not carry", () => {
    const short = files(ARTIFACTS.filter((name) => !name.endsWith("_x86_64.exe")))
    expect(() => plan({ files: short })).toThrow(`Liaison_${VERSION}_x86_64.exe`)
  })

  it("maps one stable alias per installer the download page links", () => {
    const aliases = plan().filter((step) => step.stage === "alias")
    const mapped = Object.fromEntries(
      aliases.map((step) => [step.key, step.source.split("/").at(-1)]),
    )
    expect(mapped).toEqual({
      [`${ALIAS_PREFIX}/Liaison-macos.dmg`]: `Liaison_${VERSION}_aarch64.dmg`,
      [`${ALIAS_PREFIX}/Liaison-windows-setup.exe`]: `Liaison_${VERSION}_x86_64.exe`,
      [`${ALIAS_PREFIX}/Liaison-linux.AppImage`]: `Liaison_${VERSION}_x86_64.AppImage`,
      [`${ALIAS_PREFIX}/Liaison-linux.deb`]: `Liaison_${VERSION}_x86_64.deb`,
    })
    // No alias for an updater archive: nothing reads one by a rolling name,
    // and one that lagged the manifest would hand an installed copy a payload
    // whose signature belongs to another release.
    for (const step of aliases) {
      expect(step.key).not.toContain(".app.tar.gz")
    }
  })

  it("cuts the macOS alias from the universal image when there is one", () => {
    // The one Liaison-macos.dmg link has to run on every Mac, so a universal
    // image wins over a thin one sitting beside it.
    const macos = ALIASES.find((spec) => spec.platform === "macos")
    if (!macos) throw new Error("no macOS alias")
    const present = new Set([`Liaison_${VERSION}_aarch64.dmg`, `Liaison_${VERSION}_universal.dmg`])
    expect(aliasSource(macos, VERSION, present)).toBe(`Liaison_${VERSION}_universal.dmg`)
  })

  it("refuses when an alias the download page links has nothing behind it", () => {
    const short = files(ARTIFACTS.filter((name) => !name.endsWith(".deb")))
    expect(() => plan({ files: short })).toThrow("Liaison-linux.deb")
  })

  it("caches a versioned file forever and the rolling ones barely at all", () => {
    for (const step of plan()) {
      expect(step.cacheControl, step.key).toBe(
        step.stage === "versioned" ? IMMUTABLE_CACHE_CONTROL : ROLLING_CACHE_CONTROL,
      )
    }
    expect(IMMUTABLE_CACHE_CONTROL).toContain("immutable")
    expect(ROLLING_CACHE_CONTROL).toContain("max-age=60")
  })

  it("names a content type per extension, so a browser downloads what it should", () => {
    const byKey = new Map(plan().map((step) => [step.key, step.contentType]))
    expect(byKey.get(MANIFEST_KEY)).toBe("application/json")
    expect(byKey.get(`desktop/${VERSION}/Liaison_${VERSION}_aarch64.dmg`)).toBe(
      "application/x-apple-diskimage",
    )
    expect(byKey.get(`desktop/${VERSION}/Liaison_${VERSION}_x86_64.exe`)).toBe(
      "application/vnd.microsoft.portable-executable",
    )
    expect(byKey.get(`desktop/${VERSION}/Liaison_${VERSION}_x86_64.deb`)).toBe(
      "application/vnd.debian.binary-package",
    )
    expect(byKey.get(`desktop/${VERSION}/Liaison_${VERSION}_aarch64.app.tar.gz`)).toBe(
      "application/gzip",
    )
    expect(byKey.get(`desktop/${VERSION}/Liaison_${VERSION}_aarch64.app.tar.gz.sig`)).toBe(
      "text/plain; charset=utf-8",
    )
  })
})

const ACCOUNT = "cf-account-0123456789abcdef"
const ACCESS_KEY_ID = "r2-access-key-0123456789"
const SECRET = "r2-secret-0123456789abcdef"
const CREDENTIALS = {
  accountId: ACCOUNT,
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET,
}

interface UploadRecord {
  key: string
  source: string
  size: number
  contentType: string
  cacheControl: string
}

interface ReadRecord {
  url: string
  method: string
  headers: Record<string, string>
}

/** A world with no network in it: the uploader records what it was handed,
 *  and the public host answers out of what the uploader accepted. */
function world(
  options: {
    /** Statuses to answer the upload of a matching key with, per attempt. */
    putStatuses?: { match: string; statuses: number[] }
    /** A raw throw from the transport, the shape a dropped socket takes. */
    putThrows?: { match: string; message: string }
    /** Statuses to answer the read back of a matching key with, per attempt. */
    readStatuses?: { match: string; statuses: number[] }
    /** What the host says about size. */
    length?: "present" | "range-only" | "silent"
    /** Bytes the host claims to serve, when that has to disagree. */
    servedSize?: number
    /** What a file on disk measures, for the preflight. */
    fileSize?: (file: string) => number
  } = {},
) {
  const uploads: UploadRecord[] = []
  const reads: ReadRecord[] = []
  const fileSizeCalls: string[] = []
  const stored = new Map<string, number>()
  const putAttempts = new Map<string, number>()
  const readAttempts = new Map<string, number>()
  const length = options.length ?? "present"

  const io: MirrorIo = {
    async upload(request) {
      const attempt = (putAttempts.get(request.key) ?? 0) + 1
      putAttempts.set(request.key, attempt)
      if (options.putThrows && request.key.includes(options.putThrows.match)) {
        throw new Error(options.putThrows.message)
      }
      const scripted = options.putStatuses
      if (scripted && request.key.includes(scripted.match)) {
        const status = scripted.statuses[attempt - 1]
        if (status !== undefined && status >= 400) {
          throw new TransportError(
            `${request.key}: ${status} account ${ACCOUNT}`,
            status,
            isRetryableStatus(status),
          )
        }
      }
      uploads.push({ ...request })
      stored.set(request.key, request.size)
    },
    async fetch(url, init) {
      const method = init?.method ?? "GET"
      const headers = (init?.headers ?? {}) as Record<string, string>
      reads.push({ url, method, headers })
      const key = url.replace(`${DOWNLOADS_BASE}/`, "").split("?")[0] ?? ""
      const scripted = options.readStatuses
      if (scripted && key.includes(scripted.match)) {
        const attempt = (readAttempts.get(key) ?? 0) + 1
        readAttempts.set(key, attempt)
        const status = scripted.statuses[attempt - 1]
        if (status !== undefined && status >= 400) {
          return response(status, {})
        }
      }
      const size = options.servedSize ?? stored.get(key)
      if (size === undefined) return response(404, {})
      if (method === "HEAD") {
        return response(200, length === "present" ? { "content-length": String(size) } : {})
      }
      if (headers.Range !== undefined) {
        if (length === "silent") return response(206, {})
        return response(206, { "content-range": `bytes 0-0/${size}` })
      }
      return response(200, {}, size)
    },
    fileSize(file) {
      fileSizeCalls.push(file)
      return options.fileSize
        ? options.fileSize(file)
        : (files().find((entry) => entry.path === file)?.size ?? MANIFEST_FILE.size)
    },
    log: () => {},
    sleep: async () => {},
  }
  return { uploads, reads, fileSizeCalls, io }
}

function response(status: number, headers: Record<string, string>, bytes = 0) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => `status ${status}`,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  }
}

describe("the mirror transport", () => {
  it("hands the uploader a file path and a size, never bytes", async () => {
    // The disk image is 123 MB and the updater archive 111 MB. Read into
    // memory to be uploaded they are a runner that dies, which is also why
    // the Cloudflare REST object api (100 MB, no multipart) is not the
    // transport. Nothing in the I/O surface can even return bytes.
    const big = 200 * 1024 * 1024
    const recorded = world({ fileSize: () => big })
    const steps = plan({ files: files(ARTIFACTS, () => big) })
    const withBigManifest = steps.map((step) => ({ ...step, size: big }))
    await runMirror({
      steps: withBigManifest,
      credentials: CREDENTIALS,
      io: recorded.io,
      nonce: "n",
    })
    expect(recorded.uploads.length).toBe(withBigManifest.length)
    for (const upload of recorded.uploads) {
      expect(typeof upload.source).toBe("string")
      expect(upload.source.startsWith("/")).toBe(true)
      expect(upload.size).toBe(big)
      // The uploader is handed a path and a size and nothing else: there is
      // no field on the request a caller could put bytes in.
      expect(Object.keys(upload).sort()).toEqual([
        "cacheControl",
        "contentType",
        "key",
        "size",
        "source",
      ])
    }
    // The preflight measured every source before it was sent.
    expect(recorded.fileSizeCalls.length).toBe(withBigManifest.length)
    // And the I/O surface offers no way to read bytes at all.
    expect(Object.keys(recorded.io).sort()).toEqual(["fetch", "fileSize", "log", "sleep", "upload"])
  })

  it("refuses a source that changed size, or one past what a single request carries", async () => {
    const drifted = world({ fileSize: () => 999 })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: drifted.io, nonce: "n" }),
    ).rejects.toThrow("changed after it was verified")

    const huge = MAX_SINGLE_PUT_BYTES + 1
    const enormous = world({ fileSize: () => huge })
    const steps = plan().map((step) => ({ ...step, size: huge }))
    await expect(
      runMirror({ steps, credentials: CREDENTIALS, io: enormous.io, nonce: "n" }),
    ).rejects.toThrow("multipart")
  })

  it("fails at once on a source it cannot read, without a single retry", async () => {
    // A missing or unreadable file is a local fact. Three attempts and a
    // backoff cannot change it, and the run should say so immediately rather
    // than spend the release's time proving it twice more.
    let measured = 0
    const recorded = world({
      fileSize: () => {
        measured += 1
        throw new Error("ENOENT: no such file or directory")
      },
    })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "n" }),
    ).rejects.toThrow("cannot be read")
    expect(measured).toBe(1)
    expect(recorded.uploads).toEqual([])
    expect(recorded.reads).toEqual([])
  })

  it("uploads every versioned file and reads it back publicly before any alias", async () => {
    const recorded = world()
    const steps = plan()
    await runMirror({ steps, credentials: CREDENTIALS, io: recorded.io, nonce: "n" })
    const versioned = steps.filter((step) => step.stage === "versioned").map((step) => step.key)
    const aliasKeys = steps.filter((step) => step.stage === "alias").map((step) => step.key)
    const uploaded = recorded.uploads.map((upload) => upload.key)
    expect(uploaded.slice(0, versioned.length)).toEqual(versioned)
    expect(uploaded.slice(versioned.length, versioned.length + aliasKeys.length)).toEqual(aliasKeys)
    expect(uploaded.at(-1)).toBe(MANIFEST_KEY)
    // Each object carries both headers to the host.
    for (const upload of recorded.uploads) {
      expect(upload.contentType.length).toBeGreaterThan(0)
      expect(upload.cacheControl.length).toBeGreaterThan(0)
    }
  })

  it("busts the cache on every read back, rolling and versioned alike", async () => {
    // An alias and the manifest REPLACE an object that may still be at the
    // edge, so a plain read answers with the previous release. A versioned
    // key has the opposite problem: read a moment before R2 has it, its 404
    // is NEGATIVELY cached, and every retry then re-reads the miss.
    const recorded = world()
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "run-1" })
    expect(recorded.reads.length).toBeGreaterThan(0)
    for (const read of recorded.reads) {
      expect(read.url, read.url).toContain("mirror-check=run-1-")
      // Identity, so the host reports the real length rather than a
      // compressed one or none at all.
      expect(read.headers["Accept-Encoding"]).toBe("identity")
    }
    const rolling = recorded.reads.filter(
      (read) => read.url.includes("/latest/") || read.url.includes("latest.json"),
    )
    expect(rolling.length).toBeGreaterThan(0)
    for (const read of rolling) {
      expect(read.headers["Cache-Control"]).toBe("no-cache")
    }
    for (const read of recorded.reads.filter((entry) => entry.url.includes(`/${VERSION}/`))) {
      expect(read.headers["Cache-Control"]).toBeUndefined()
    }
  })

  it("gives a retried read back a url the negative cache has never seen", async () => {
    // The race this exists for: the read back runs before R2 is consistent,
    // the edge caches that 404, and a retry on the SAME url reads the cached
    // miss rather than the object, so the release fails with the artifact
    // sitting right there.
    const archive = `desktop/${VERSION}/Liaison_${VERSION}_aarch64.app.tar.gz`
    const recorded = world({ readStatuses: { match: archive, statuses: [404] } })
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "run-2" })
    const attempts = recorded.reads.filter((read) => read.url.includes(archive))
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(attempts[0]?.url).toContain("mirror-check=run-2-1")
    expect(attempts[1]?.url).toContain("mirror-check=run-2-2")
    expect(attempts[0]?.url).not.toBe(attempts[1]?.url)
    // And the release went through: the manifest is last and it was written.
    expect(recorded.uploads.at(-1)?.key).toBe(MANIFEST_KEY)
  })

  it("does not read a missing Content-Length as a file of zero bytes", async () => {
    // Number("") is 0. A host that answers without the header would fail
    // every release with "serves 0 bytes" while serving the artifact.
    const recorded = world({ length: "range-only" })
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "n" })
    expect(recorded.reads.some((read) => read.headers.Range === "bytes=0-0")).toBe(true)

    // And with no length anywhere, the manifest is small enough to count.
    const silent = world({ length: "silent" })
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: silent.io, nonce: "n" })
    expect(silent.uploads.at(-1)?.key).toBe(MANIFEST_KEY)
  })

  it("still fails on a size the host really does disagree about", async () => {
    const recorded = world({ servedSize: 7 })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "n" }),
    ).rejects.toThrow("is not the artifact that was verified")
  })

  it("retries a 5xx a bounded number of times and gives up", async () => {
    const once = world({ putStatuses: { match: ".dmg", statuses: [503] } })
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: once.io, nonce: "n" })
    expect(once.uploads.some((upload) => upload.key.endsWith(".dmg"))).toBe(true)

    const always = world({
      putStatuses: { match: ".dmg", statuses: [503, 503, 503, 503] },
    })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: always.io, nonce: "n" }),
    ).rejects.toThrow("503")
    expect(always.uploads.every((upload) => !upload.key.endsWith(".dmg"))).toBe(true)
    expect(RETRY_ATTEMPTS).toBe(3)
  })

  it("never retries a 4xx, which is the server saying the request is wrong", async () => {
    const recorded = world({ putStatuses: { match: ".dmg", statuses: [403, 200, 200] } })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "n" }),
    ).rejects.toThrow("403")
    // One attempt, so the retried one never happened.
    expect(recorded.uploads.some((upload) => upload.key.endsWith(".dmg"))).toBe(false)
  })

  it("retries a read back that 5xxs or races R2, and gives up on a 404 that stays", async () => {
    const flaky = world({ readStatuses: { match: `${VERSION}/Liaison`, statuses: [500] } })
    await runMirror({ steps: plan(), credentials: CREDENTIALS, io: flaky.io, nonce: "n" })
    expect(flaky.uploads.at(-1)?.key).toBe(MANIFEST_KEY)

    const missing = world({
      readStatuses: { match: "latest/Liaison-macos", statuses: [404, 404, 404, 404] },
    })
    await expect(
      runMirror({ steps: plan(), credentials: CREDENTIALS, io: missing.io, nonce: "n" }),
    ).rejects.toThrow("not readable")
    expect(missing.uploads.some((upload) => upload.key === MANIFEST_KEY)).toBe(false)
  })

  it("never writes latest.json when anything before it failed", async () => {
    for (const recorded of [
      world({ putStatuses: { match: ".dmg", statuses: [403] } }),
      world({ readStatuses: { match: "AppImage", statuses: [404, 404, 404, 404] } }),
    ]) {
      await expect(
        runMirror({ steps: plan(), credentials: CREDENTIALS, io: recorded.io, nonce: "n" }),
      ).rejects.toThrow()
      expect(recorded.uploads.map((upload) => upload.key)).not.toContain(MANIFEST_KEY)
    }
  })

  it("never puts a credential in what it throws, whatever the transport said", async () => {
    // These errors land in a CI log a wider set of people can read than can
    // read the secret, and both the S3 client and the edge name the account
    // in their error text.
    const echoed = world({ putStatuses: { match: ".dmg", statuses: [403] } })
    let thrown = ""
    try {
      await runMirror({ steps: plan(), credentials: CREDENTIALS, io: echoed.io, nonce: "n" })
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    expect(thrown).toContain("403")
    expect(thrown).not.toContain(ACCOUNT)
    expect(thrown).toContain("[redacted]")

    // And a raw throw from the transport, which is the shape a dropped
    // connection or the S3 client's own error takes.
    const raw = world({
      putThrows: { match: ".dmg", message: `connect failed for account ${ACCOUNT} key ${SECRET}` },
    })
    let rawThrown = ""
    try {
      await runMirror({ steps: plan(), credentials: CREDENTIALS, io: raw.io, nonce: "n" })
    } catch (error) {
      rawThrown = error instanceof Error ? error.message : String(error)
    }
    expect(rawThrown).toContain("connect failed")
    expect(rawThrown).not.toContain(ACCOUNT)
    expect(rawThrown).not.toContain(SECRET)
  })

  it("uploads nothing at all in a dry run", async () => {
    const recorded = world()
    await runMirror({
      steps: plan(),
      credentials: { accountId: "", accessKeyId: "", secretAccessKey: "" },
      io: recorded.io,
      dryRun: true,
      nonce: "n",
    })
    expect(recorded.uploads).toEqual([])
    expect(recorded.reads).toEqual([])
  })
})

describe("redaction", () => {
  it("removes every credential it is given, and leaves short strings alone", () => {
    expect(redact(`fail ${SECRET} here`, [SECRET])).toBe("fail [redacted] here")
    // A short "secret" would redact ordinary words out of a message.
    expect(redact("a b c", ["b"])).toBe("a b c")
    expect(redact("nothing to do", [""])).toBe("nothing to do")
  })

  it("removes a presigned url, which is itself a credential", () => {
    // Anybody holding one can write that object until it expires, and it is
    // exactly what a fetch failure puts in its message.
    const url =
      "https://acct.r2.cloudflarestorage.com/liaison-downloads/desktop/latest.json" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20260921" +
      "&X-Amz-Signature=deadbeefcafe0123456789abcdef"
    const cleaned = redact(`PUT ${url} failed`, [])
    expect(cleaned).not.toContain("X-Amz-Signature=deadbeefcafe0123456789abcdef")
    expect(cleaned).not.toContain("r2.cloudflarestorage.com")
    expect(cleaned).toContain("[redacted url]")
    // And a bare signature parameter that reached the text some other way.
    expect(redact("signature X-Amz-Signature=abc123def456 seen", [])).toContain(
      "X-Amz-Signature=[redacted]",
    )
  })
})

describe("the real uploader", () => {
  // The transport itself, against a server on the loopback address. Nothing
  // above this point would notice if the PUT went out chunked, carried the
  // wrong length, or dropped the headers on the floor: those are properties
  // of the request Bun actually sends, so the request is read off the wire.
  const scratch = mkdtempSync(path.join(tmpdir(), "liaison-uploader-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it("sends a multi megabyte body whole, with both headers and a real length", async () => {
    const received: {
      method: string
      pathname: string
      headers: Record<string, string>
      bytes: number
    }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const headers: Record<string, string> = {}
        for (const [name, value] of request.headers) headers[name] = value
        const body = await request.arrayBuffer()
        received.push({
          method: request.method,
          pathname: url.pathname,
          headers,
          bytes: body.byteLength,
        })
        return new Response("", { status: 200 })
      },
    })
    try {
      // Past the 100 MB of the REST object api is not something to write to
      // disk in a test; six megabytes is enough to prove the body is streamed
      // whole with a real Content-Length rather than chunked.
      const source = path.join(scratch, "Liaison_9.9.9_aarch64.dmg")
      const size = 6 * 1024 * 1024
      writeFileSync(source, Buffer.alloc(size, 7))
      const upload = realUploader(CREDENTIALS, `http://127.0.0.1:${server.port}`)
      await upload({
        key: `desktop/${VERSION}/Liaison_${VERSION}_aarch64.dmg`,
        source,
        size,
        contentType: "application/x-apple-diskimage",
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      })
      expect(received).toHaveLength(1)
      const request = received[0]
      expect(request?.method).toBe("PUT")
      expect(request?.pathname).toBe(
        `/liaison-downloads/desktop/${VERSION}/Liaison_${VERSION}_aarch64.dmg`,
      )
      // The whole file arrived, once.
      expect(request?.bytes).toBe(size)
      expect(request?.headers["content-length"]).toBe(String(size))
      // Not chunked: a chunked body has no length, and R2 rejects an
      // unsigned chunked PUT.
      expect(request?.headers["transfer-encoding"]).toBeUndefined()
      // Both headers, which is the whole reason this is a presigned PUT and
      // not S3Client.write (that one sends Content-Type and nothing else).
      expect(request?.headers["content-type"]).toBe("application/x-apple-diskimage")
      expect(request?.headers["cache-control"]).toBe(IMMUTABLE_CACHE_CONTROL)
      // And it is signed.
      expect(request?.headers.authorization ?? "").toBe("")
    } finally {
      server.stop(true)
    }
  }, 30_000)

  it("refuses a status the host returns, and says which key", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("denied", { status: 403 }),
    })
    try {
      const source = path.join(scratch, "small.json")
      writeFileSync(source, "{}\n")
      const upload = realUploader(CREDENTIALS, `http://127.0.0.1:${server.port}`)
      await expect(
        upload({
          key: MANIFEST_KEY,
          source,
          size: 3,
          contentType: "application/json",
          cacheControl: ROLLING_CACHE_CONTROL,
        }),
      ).rejects.toThrow("403")
    } finally {
      server.stop(true)
    }
  }, 30_000)
})
