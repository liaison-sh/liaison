// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `slack import` caches each file under `<cache dir>/<file id>`, and the file id
 * is read from the export's day files: data written outside the company (an
 * export handed over by another workspace, an acquired company, a customer).
 * A crafted id must not name a path outside the cache: neither the download
 * (an arbitrary write, with bytes the author hosts on files.slack.com) nor the
 * read that re-hosts the cached bytes as an attachment (an arbitrary read of
 * the importing machine's files into the org).
 *
 * Real database, as import.people.test.ts; the downloader and the object
 * store are injected, so nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { runSlackImport } from "~/cli/slack/import"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function inside(dir: string, p: string): boolean {
  const rel = relative(resolve(dir), resolve(p))
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/")
}

describe("slack import: file ids from the export", () => {
  test("a file id cannot read or write outside the files cache", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const slug = `slack-paths-${tag}`
    await ensureOrg({ slug, name: "SlackPathsOrg" })

    // <root>/export (the archive), <root>/cache (the files cache), and a file
    // beside them standing for anything else the importing process can read.
    const root = mkdtempSync(join(tmpdir(), "slack-paths-"))
    tmpDirs.push(root)
    const exportDir = join(root, "export")
    const cacheDir = join(root, "cache")
    mkdirSync(exportDir)
    const secretBytes = `SECRET-${tag}`
    writeFileSync(join(root, `secret-${tag}`), secretBytes)

    writeFileSync(
      join(exportDir, "users.json"),
      JSON.stringify([{ id: "UOUT", name: "outsider", profile: { real_name: "Outsider" } }]),
    )
    writeFileSync(
      join(exportDir, "channels.json"),
      JSON.stringify([{ id: "C1", name: "general", created: 1_600_000_000, members: ["UOUT"] }]),
    )
    mkdirSync(join(exportDir, "general"))
    const url = "https://files.slack.com/files-pri/T1-F1/download/x.txt?t=xoxe-test"
    writeFileSync(
      join(exportDir, "general", "2025-01-01.json"),
      JSON.stringify([
        {
          type: "message",
          user: "UOUT",
          ts: "1735689600.000100",
          text: "read one",
          // Already "cached" (the path exists), so the importer reads it straight away.
          files: [{ id: `../secret-${tag}`, name: "notes.txt", url_private_download: url }],
        },
        {
          type: "message",
          user: "UOUT",
          ts: "1735689601.000100",
          text: "write one",
          files: [{ id: `../written-${tag}`, name: "notes.txt", url_private_download: url }],
        },
      ]),
    )
    const userMapPath = join(exportDir, "user-map.json")
    writeFileSync(userMapPath, "{}")

    const downloadTargets: string[] = []
    const stored: Buffer[] = []
    const r = await runSlackImport({
      exportDir,
      orgSlug: slug,
      userMapPath,
      filesCacheDir: cacheDir,
      downloadFile: async (_url, destPath) => {
        downloadTargets.push(destPath)
        return { bytes: 0 }
      },
      putObject: (async (args: { body: Buffer | Uint8Array | string }) => {
        stored.push(Buffer.from(args.body as Buffer))
      }) as never,
    })
    expect(r.report.errors).toEqual([])

    // Nothing outside the cache is ever a download destination, and nothing
    // outside it is ever read into the org's object store.
    expect({
      downloadsOutsideCache: downloadTargets.filter((p) => !inside(cacheDir, p)).length,
      outsideFileReadIntoOrg: stored.some((b) => b.toString("utf8") === secretBytes),
    }).toEqual({ downloadsOutsideCache: 0, outsideFileReadIntoOrg: false })
  })
})
