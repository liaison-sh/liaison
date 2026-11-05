// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A skill_read of a large app's skill unlocks the tools the skill names, not
// the whole app (skills-routines-tools.ts). That only works if the matcher
// reads the names the way the shipped skills write them: the SDK name
// (`boxtal__shipments_create`), the bare name (`campaigns_list`, `addNote`),
// in backticks or not. Checked here against every skill the repo ships, read
// from the manifests themselves.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  SKILL_PREUNLOCK_MAX_APP_TOOLS,
  skillNamesTool,
} from "~/modules/agent/tools/skills-routines-tools"
import { sdkToolName } from "~/modules/agent/tools/tool-bridge"

const REPO = path.resolve(import.meta.dir, "../../../../../..")

interface ShippedApp {
  app: string
  tools: Array<{ appName: string; toolName: string; sdkName: string }>
  skills: Array<{ name: string; body: string }>
}

function readShippedApps(): ShippedApp[] {
  const dirs = [
    ...readdirSync(path.join(REPO, "bundled-apps")).map((d) => path.join(REPO, "bundled-apps", d)),
    ...readdirSync(path.join(REPO, "apps/api/src/apps")).map((d) =>
      path.join(REPO, "apps/api/src/apps", d),
    ),
  ]
  const out: ShippedApp[] = []
  for (const dir of dirs) {
    let manifest: {
      name: string
      tools?: Record<string, unknown>
      skills?: Record<string, { body?: string }>
    }
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, "app.manifest.json"), "utf8"))
    } catch {
      continue
    }
    const app = manifest.name
    const tools = Object.keys(manifest.tools ?? {}).map((toolName) => ({
      appName: app,
      toolName,
      sdkName: sdkToolName(app, toolName),
    }))
    const skills = Object.entries(manifest.skills ?? {})
      .filter(([, s]) => typeof s.body === "string")
      .map(([name, s]) => ({ name, body: s.body as string }))
    // Skills kept as markdown beside the manifest (the tickets descriptor).
    try {
      for (const file of readdirSync(path.join(dir, "skills"))) {
        if (!file.endsWith(".md")) continue
        skills.push({
          name: file.replace(/\.md$/, ""),
          body: readFileSync(path.join(dir, "skills", file), "utf8"),
        })
      }
    } catch {}
    out.push({ app, tools, skills })
  }
  return out
}

const shipped = readShippedApps()
const large = shipped.filter(
  (a) => a.tools.length > SKILL_PREUNLOCK_MAX_APP_TOOLS && a.skills.length > 0,
)
const named = (a: ShippedApp, skill: string) => {
  const body = a.skills.find((s) => s.name === skill)?.body ?? ""
  return a.tools.filter((t) => skillNamesTool(body, t)).map((t) => t.sdkName)
}
const appOf = (name: string) => {
  const a = shipped.find((x) => x.app === name)
  if (!a) throw new Error(`no shipped app ${name}`)
  return a
}

describe("the tools a shipped skill names", () => {
  it("covers the large apps", () => {
    expect(large.map((a) => a.app).sort()).toEqual(
      expect.arrayContaining(["ads", "boxtal", "invoicing", "pennylane", "shopify", "tickets"]),
    )
  })

  it("each large app's main skill loads the tools it names, in the form it names them", () => {
    // SDK names.
    expect(named(appOf("tickets"), "draft-ticket-reply").length).toBeGreaterThanOrEqual(3)
    expect(named(appOf("boxtal"), "warranty-return-label").length).toBeGreaterThanOrEqual(9)
    // Bare names, in backticks.
    expect(named(appOf("ads"), "ads-playbook")).toEqual(
      expect.arrayContaining([
        "ads__campaigns_list",
        "ads__account_info",
        "ads__create_campaign",
        "ads__metrics_run",
      ]),
    )
    expect(named(appOf("pennylane"), "capture-vendor-bill-payable")).toContain(
      "pennylane__supplier_invoice_upload",
    )
    // A bare name in prose.
    expect(named(appOf("invoicing"), "invoicing-overview")).toContain(
      "invoicing__quote_create_and_issue",
    )
  })

  it("every tool a large app's skill spells out is matched, and only those", () => {
    for (const a of large) {
      for (const s of a.skills) {
        const got = new Set(named(a, s.name))
        for (const t of a.tools) {
          const spelled =
            new RegExp(`(^|[^A-Za-z0-9_])${t.sdkName}($|[^A-Za-z0-9_])`).test(s.body) ||
            s.body.includes(`\`${t.toolName}\``)
          if (spelled)
            expect({ skill: s.name, tool: t.sdkName, got: got.has(t.sdkName) }).toEqual({
              skill: s.name,
              tool: t.sdkName,
              got: true,
            })
          // Never a tool whose name does not occur in the body at all.
          if (got.has(t.sdkName))
            expect(s.body.includes(t.toolName) || s.body.includes(t.sdkName)).toBe(true)
        }
      }
    }
  })

  it("an ordinary word is not a tool name", () => {
    const reply = { appName: "tickets", toolName: "reply", sdkName: "tickets__reply" }
    expect(skillNamesTool("Write the reply in plain text.", reply)).toBe(false)
    expect(skillNamesTool("Needs the `tickets:tickets:reply` scope.", reply)).toBe(false)
    expect(skillNamesTool("Call `reply` once.", reply)).toBe(true)
    expect(skillNamesTool("Then tickets:reply sends it.", reply)).toBe(true)
    const dotted = {
      appName: "tickets",
      toolName: "apiKeys.create",
      sdkName: "tickets__apiKeys_create",
    }
    expect(skillNamesTool("Mint one with apiKeys.create.", dotted)).toBe(true)
    expect(skillNamesTool("Mint one with apiKeysXcreate.", dotted)).toBe(false)
  })
})
