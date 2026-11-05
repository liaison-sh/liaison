// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `slack import` reads each channel's day files from `<export>/<channel name>`,
 * and the channel name comes from the export's channels.json: data written
 * outside the company. A name that leaves the export (`../<dir>`, an absolute
 * path) must read nothing; the channel is reported as having no folder.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSlackImport } from "~/cli/slack/import"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe("slack import: channel names from the export", () => {
  test("a channel name cannot read day files outside the export", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const slug = `slack-chan-${tag}`
    await ensureOrg({ slug, name: "SlackChanOrg" })

    const root = mkdtempSync(join(tmpdir(), "slack-chan-"))
    tmpDirs.push(root)
    const exportDir = join(root, "export")
    mkdirSync(exportDir)
    // A directory beside the export: anything else the importing process can read.
    const outside = join(root, `outside-${tag}`)
    mkdirSync(outside)
    writeFileSync(
      join(outside, "data.json"),
      JSON.stringify([{ type: "message", user: "UOUT", ts: "1735689600.000100", text: "OUTSIDE" }]),
    )
    writeFileSync(
      join(exportDir, "users.json"),
      JSON.stringify([{ id: "UOUT", name: "outsider", profile: { real_name: "Outsider" } }]),
    )
    writeFileSync(
      join(exportDir, "channels.json"),
      JSON.stringify([
        { id: "C1", name: `../outside-${tag}`, created: 1_600_000_000, members: ["UOUT"] },
      ]),
    )
    const userMapPath = join(exportDir, "user-map.json")
    writeFileSync(userMapPath, "{}")

    const r = await runSlackImport({
      exportDir,
      orgSlug: slug,
      userMapPath,
      dryRun: true,
      skipFiles: true,
    })
    expect(r.report.totalMessagesImported).toBe(0)
    expect(r.report.channelsWithoutFolder).toContain(`../outside-${tag}`)
  })
})
