// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member asking "connect my Gmail" must find the Connect card. In a live walk
// a member's agent searched for it, met only an adapter tool that answers to
// "connect" and an admin-locked config tool, and told the person they needed an
// administrator. `request_secret` declares the words people use for it, so the
// request's own words load it, for a member as for an admin.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { registerSecretRequestTool } from "~/modules/agent/tools/secret-request-tools"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000000e51"
const MEMBER = {
  userId: "00000000-0000-0000-0000-000000000e52",
  scopes: ["kernel:threads:read", "kernel:threads:write", "mail:accounts:read", "mail:read"],
}

function freshFrame() {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
}

beforeAll(() => {
  registerSecretRequestTool(ORG)
  // The two tools the walk's search met instead.
  toolRegistry.set([ORG, "api-connector", "connector_adapter_save"], {
    appName: "api-connector",
    name: "connector_adapter_save",
    deferLoading: true,
    searchKeywords: ["connect", "connection", "integration", "integrate", "crm", "erp", "adapter"],
    description: "Create or replace an API connection's adapter (CRM, ERP, any HTTP API).",
    requiredScopes: ["kernel:threads:read"],
    handler: async () => ({ ok: true }),
  } as never)
  toolRegistry.set([ORG, "kernel", "config_mail"], {
    appName: "kernel",
    name: "config_mail",
    deferLoading: true,
    description: "Configure the organization's mail: shared mailboxes, the Gmail connect.",
    requiredScopes: ["kernel:org:admin"],
    handler: async () => ({ ok: true }),
  } as never)
})

afterAll(() => {
  toolRegistry.delete([ORG, "kernel", "request_secret"])
  toolRegistry.delete([ORG, "api-connector", "connector_adapter_save"])
  toolRegistry.delete([ORG, "kernel", "config_mail"])
})

describe("a member's request to connect their own mailbox finds the Connect card", () => {
  for (const query of [
    "connect my Gmail",
    "connect gmail",
    "gmail connect personal",
    "connect my mailbox",
    "sign in to my gmail account",
  ]) {
    it(`"${query}" loads kernel__request_secret for a member`, async () => {
      const frame = freshFrame()
      const res = await runContextStore.run(frame, () =>
        handleToolSearch({ query }, { orgId: ORG, userId: MEMBER.userId, scopes: MEMBER.scopes }),
      )
      const card = res.matches.find((m) => m.name === "kernel__request_secret")
      expect(card).toBeDefined()
      expect(card?.locked).toBeUndefined()
      expect(frame.discoveredTools.has("kernel__request_secret")).toBe(true)
      // The search result itself names the personal path, in the tool's synopsis.
      expect(card?.description).toContain("mode personal")
      expect(card?.description).toContain("no admin needed")
    })
  }

  it("the tool says a member connects their own account without an administrator", () => {
    const def = toolRegistry.get([ORG, "kernel", "request_secret"]) as { description: string }
    expect(def.description).toContain("mode personal")
    expect(def.description).toContain("no admin needed")
  })
})
