// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison setup state`: the in-product agent's checklist, every connection of
 * the apps that are on with the command for its steps, and the server
 * surfaces, ending with what is left. Real test DB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { dirname, join } from "node:path"
import { buildSetupState, renderSetupState, type SetupStateReport } from "~/cli/setup/state"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let orgSlug: string

beforeAll(async () => {
  await acquireTestLock()
  orgSlug = `cli-setup-${crypto.randomUUID().slice(0, 12)}`
  orgId = (
    await ensureOrg({
      slug: orgSlug,
      name: "SetupStateOrg",
    })
  ).orgId
})
afterAll(releaseTestLock)

describe("liaison setup state", () => {
  test("lists the checklist, the connections with their guide command, the server, and what is left", async () => {
    const report = await buildSetupState(orgId)
    expect(report.workspace.items.map((i) => i.key)).toContain("aiKey")
    const gmail = report.connections.find((c) => c.app === "mail" && c.connection === "gmail")
    expect(gmail?.guide).toBe("liaison guide google --email <address>")
    expect(gmail?.connect).toBe("liaison connect mail/gmail --config <path>")
    expect(report.server.map((s) => s.id)).toContain("email")
    expect(report.left.some((l) => l.startsWith("server email"))).toBe(true)
    const text = renderSetupState(report).join("\n")
    expect(text).toContain("Left (about ")
    expect(text).toContain("Server (liaison guide server for the steps)")
  })
})

describe("liaison setup state: left is what the person chose", () => {
  test("unanswered: the basics only, the question is still open, the rest is a menu", async () => {
    const report = await buildSetupState(orgId)
    expect(report.left[0]).toStartWith("features: not chosen yet")
    for (const l of report.left) {
      expect(l).not.toMatch(/gitlab|database\/|api-connector|ads\/meta|social\/instagram|optional/)
    }
    const text = renderSetupState(report).join("\n")
    expect(text).toContain("You can also add (a menu to offer, not a to-do):")
  })

  test("setup.features (config apply) replaces the basics with the person's answer", async () => {
    const { setupProvisioner } = await import("~/cli/provisioners/setup")
    const { buildProvisionContext } = await import("~/cli/provisioners/types")
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    const config = {
      org: { slug: "x", name: "x" },
      setup: { features: ["support"] },
    } as unknown as import("~/cli/config/schema").ProvisioningConfig
    const plan = await setupProvisioner.plan(ctx, config)
    await setupProvisioner.apply(ctx, plan, config)
    const report = await buildSetupState(orgId)
    expect(report.workspace.features.chosen).toEqual(["support"])
    expect(report.left.some((l) => l.startsWith("features:"))).toBe(false)
    // Connect a ticket inbox, or turn the tickets app on first where it is off.
    expect(
      report.left.some((l) => /^feature support: (connect tickets\/gmail|its app is off)/.test(l)),
    ).toBe(true)
    expect(report.left.some((l) => l.startsWith("feature email"))).toBe(false)
    // No app is on in this fresh org, so the menu offers only what needs none.
    expect(report.menu.some((m) => m.id === "feature import")).toBe(true)
    await expect(
      setupProvisioner.plan(ctx, { ...config, setup: { features: ["nope"] } }),
    ).rejects.toThrow("unknown feature 'nope'")
  })
})

describe("liaison setup state: rendering", () => {
  const base = (report: Partial<SetupStateReport>): SetupStateReport => ({
    workspace: { items: [], connections: [] } as unknown as SetupStateReport["workspace"],
    connections: [],
    server: [],
    left: [],
    leftMinutes: [0, 0],
    menu: [],
    ...report,
  })

  test("nothing left says so; left items without a known time print no 0 to 0 min", () => {
    expect(renderSetupState(base({}))).toContain("Nothing left.")
    const untimed = renderSetupState(base({ left: ["workspace import: not done"] })).join("\n")
    expect(untimed).toContain("Left:\n  - workspace import: not done")
    expect(untimed).not.toContain("0 to 0 min")
    const timed = renderSetupState(base({ left: ["x"], leftMinutes: [5, 10] })).join("\n")
    expect(timed).toContain("Left (about 5 to 10 min of your own time")
  })

  test("a partly done feature on the menu says what is connected and what is left", () => {
    const text = renderSetupState(
      base({
        menu: [
          {
            id: "feature social",
            label: "Facebook Pages and Instagram",
            minutes: [12, 20],
            done: ["social/facebook"],
            open: ["social/instagram or social/instagram_unified"],
          },
        ],
      }),
    ).join("\n")
    expect(text).toContain(
      "feature social: Facebook Pages and Instagram (partly done: social/facebook connected; left: social/instagram or social/instagram_unified)",
    )
  })
})

describe("liaison setup state: stdout carries only the answer", () => {
  test("no log line and no schema-compiler warning before the output, even under the server's LOG_LEVEL", () => {
    const apiDir = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..")
    const r = spawnSync("bun", ["run", "src/cli/index.ts", "setup", "state", "--org", orgSlug], {
      cwd: apiDir,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "debug" },
      timeout: 120_000,
    })
    expect(r.status).toBe(0)
    const out = r.stdout ?? ""
    expect(out.startsWith("Workspace\n")).toBe(true)
    expect(out).not.toContain('{"level"')
    expect(`${out}${r.stderr ?? ""}`).not.toContain("unknown format")
    // Under the CLI, info and debug lines are off by default: stderr has none either.
    expect(r.stderr ?? "").not.toMatch(/"level":(20|30)\b/)
  })
})
