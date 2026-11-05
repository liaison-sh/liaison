// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every approval the demo seed writes carries a payload its tool ACCEPTS.
//
// An approval's payload is the tool call Approve runs. The seed used to write
// descriptive look-alikes (`body` for `textBody`, `to` as a string, a ticket
// SUBJECT, a discount's `percentage` and `endsInDays`), which the tool refused
// as unrecognised parameters: Approve failed with `handler_ambiguous` and the
// edit form opened empty or refused to save. This holds each seeded payload to
// the REAL parameter schema of the tool it targets, through the same
// `validateParamsForTool` a live call goes through (unknown parameters,
// required ones, types and enums), so a schema change or a seed edit that
// drifts fails here instead of on a visitor's Approve.
import { beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { validateParamsForTool } from "~/modules/apps/execute-tool"
import { APPROVAL_SPECS, type ApprovalRefs } from "~/seed/tiers/demo/approval-specs"

const REPO = path.resolve(import.meta.dir, "../../../../..")
const ORG = "6d1f3c4e-0000-4000-8000-00000000a001"

type ToolEntry = Parameters<typeof validateParamsForTool>[0]

interface Manifest {
  tools: Record<string, { params?: unknown; handler?: string; requiredScopes: string[] }>
  bulk?: Record<string, unknown>
}

/** Where an app's manifest lives: the kernel-hosted apps, else the bundled ones. */
function manifestOf(app: string): Manifest {
  for (const dir of [`apps/api/src/apps/${app}`, `bundled-apps/${app}`]) {
    try {
      return JSON.parse(readFileSync(path.join(REPO, dir, "app.manifest.json"), "utf8"))
    } catch {}
  }
  throw new Error(`no manifest for app ${app}`)
}

/** Every reference resolves to a well-formed id, so only the payload's SHAPE is under test. */
let counter = 0
function uuid(): string {
  counter += 1
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`
}
const refs: ApprovalRefs = {
  ticket: () => uuid(),
  skill: () => uuid(),
  mailAccount: () => uuid(),
  mailConversation: () => uuid(),
  contact: () => uuid(),
  commerce: () => uuid(),
  placeholder: () => uuid(),
  at: (hours) => new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000).toISOString(),
}

/** The tool a seeded approval targets, as the registry would hold it. */
function toolFor(toolName: string): ToolEntry {
  const [app, name] = toolName.split(":") as [string, string]
  if (app === "kernel") {
    const tool = toolRegistry.get([ORG, "kernel", name])
    if (!tool) throw new Error(`kernel tool ${name} is not registered`)
    return tool
  }
  const manifest = manifestOf(app)
  const declared = manifest.tools[name]
  if (declared) {
    // A manifest tool: validated by its declared JSON schema, exactly as a
    // registered manifest handler is.
    return {
      handler: { bundlePath: "manifest", exportName: declared.handler ?? name },
      params: declared.params,
    } as unknown as ToolEntry
  }
  // A bulk agent tool, derived from the manifest's `bulk` block.
  registerBulkAgentTools({
    orgId: ORG,
    appName: app,
    bulk: (manifest.bulk ?? {}) as Parameters<typeof registerBulkAgentTools>[0]["bulk"],
    tools: manifest.tools as Parameters<typeof registerBulkAgentTools>[0]["tools"],
  })
  const bulk = toolRegistry.get([ORG, app, name])
  if (!bulk) throw new Error(`no tool ${toolName} in the ${app} manifest`)
  return bulk
}

describe("the demo seed's approval payloads", () => {
  beforeAll(async () => {
    await registerKernelAgentTools(ORG)
  })

  it("covers a real set of approvals", () => {
    expect(APPROVAL_SPECS.length).toBeGreaterThanOrEqual(10)
  })

  for (const spec of APPROVAL_SPECS) {
    it(`${spec.key} (${spec.toolName}) validates against the tool's own schema`, () => {
      const [app, name] = spec.toolName.split(":") as [string, string]
      const payload = spec.payload(refs)
      expect(() =>
        validateParamsForTool(toolFor(spec.toolName), ORG, app, name, payload),
      ).not.toThrow()
    })
  }

  it("refuses a payload with a parameter the tool does not have, so the check has teeth", () => {
    const tool = toolFor("mail:compose")
    expect(() =>
      validateParamsForTool(tool, ORG, "mail", "compose", {
        accountId: uuid(),
        to: ["someone@example.com"],
        subject: "s",
        body: "the old seed's field name",
      }),
    ).toThrow(/not a recognised parameter/)
    expect(() =>
      validateParamsForTool(
        toolFor("shopify:discounts_create"),
        ORG,
        "shopify",
        "discounts_create",
        {
          code: "X",
          percentage: 15,
        },
      ),
    ).toThrow()
  })

  it("names the real recipient only as data: no seeded mail is addressed outside .example", () => {
    for (const spec of APPROVAL_SPECS) {
      if (!spec.toolName.startsWith("mail:")) continue
      const to = (spec.payload(refs).to as string[] | undefined) ?? []
      for (const address of to) expect(address.endsWith(".example")).toBe(true)
    }
  })
})
