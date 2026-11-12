// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { ALL_CREDENTIAL_FIELDS } from "@liaison/api-connector-core"
import manifest from "../app.manifest.json"

// The schema check of this manifest is the kernel's (apps/api
// bundled-manifests-valid.test.ts); these pin what the app means.
describe("api-connector manifest", () => {
  it("is version 2.0.0, the catalog app that replaced the in-tree one", () => {
    expect(manifest.version).toBe("2.0.2")
  })

  it("declares the connection as a platform-held API connection with the app's own scopes", () => {
    expect(manifest.connections.api.api).toEqual({
      readScope: "api-connector:read",
      writeScope: "api-connector:write",
      adminScope: "api-connector:admin",
    })
  })

  it("keeps the settings screen's and the card's tools out of the agent's catalog", () => {
    const ui = [
      "settings_connections",
      "settings_adapter_save",
      "settings_adapter_restore",
      "settings_adapter_delete",
      "settings_adapter_test",
      "customer_lookup",
    ] as const
    for (const name of ui) expect(manifest.tools[name].agentVisible).toBe(false)
    for (const name of [
      "settings_adapter_save",
      "settings_adapter_restore",
      "settings_adapter_delete",
      "settings_adapter_test",
    ] as const) {
      expect(manifest.tools[name].requiredScopes).toEqual(["api-connector:admin"])
    }
    expect(manifest.tools.customer_lookup.requiredScopes).toEqual(["api-connector:read"])
  })

  it("provisions connections and verifies them through its own handlers", () => {
    expect(manifest.provisioning.handler).toBe("provisionApiConnector")
    expect(manifest.provisioning.verify).toBe("verifyApiConnector")
  })

  it("contributes the customer card to the ticket panel and the mail banner", () => {
    expect(manifest.contributions).toEqual({
      "ticket:detail:panel": { label: "Customer", component: "TicketCustomerCard" },
      "mail:conversation:banner": { label: "Customer", component: "MailCustomerCard" },
    })
  })

  it("declares one multiInstance credentials connection carrying every auth field, all optional", () => {
    const api = manifest.connections.api
    expect(api.type).toBe("credentials")
    expect(api.multiInstance).toBe(true)
    expect(api.credentialFields.map((f: { name: string }) => f.name).sort()).toEqual(
      [...ALL_CREDENTIAL_FIELDS].sort(),
    )
    expect(api.credentialFields.every((f: { required?: boolean }) => f.required === false)).toBe(
      true,
    )
  })

  it("grants read/write to members and admin/accounts:admin to admins", () => {
    expect(manifest.roles.member.scopes).toEqual(["api-connector:read", "api-connector:write"])
    expect(manifest.roles.admin.scopes).toEqual([
      "api-connector:admin",
      "api-connector:accounts:admin",
    ])
  })

  it("keeps the adapters table reachable only through the admin scope", () => {
    expect(manifest.schema.adapters.rlsScope).toBe("admin")
  })

  it("gives every connector tool a 60 s sandbox budget (the default is 5 s)", () => {
    for (const tool of Object.values(manifest.tools) as Array<{ timeoutMs?: number }>) {
      expect(tool.timeoutMs).toBe(60_000)
    }
  })

  it("marks reads read-only taint sources and gates the write as external", () => {
    expect(manifest.tools.connector_read).toMatchObject({ readOnly: true, taintSource: true })
    expect(manifest.tools.connector_list_operations).toMatchObject({
      readOnly: true,
      taintSource: true,
    })
    expect(manifest.tools.connector_write).toMatchObject({
      gated: true,
      approvalImpact: "external",
      summarizer: "summarizeConnectorWrite",
    })
  })

  it("tells the agent to name connection records in plain text, never as mentions", () => {
    expect(manifest.agentInstructions.core).toContain(
      "in plain text, never as an @[..](..) mention",
    )
  })

  it("marks the authoring reads admin-only reads, the test call a taint source", () => {
    for (const name of [
      "connector_adapter_get",
      "connector_adapter_versions",
      "connector_adapter_reference",
      "connector_adapter_test",
    ] as const) {
      expect(manifest.tools[name]).toMatchObject({
        readOnly: true,
        requiredScopes: ["api-connector:admin"],
      })
    }
    expect(manifest.tools.connector_adapter_test.taintSource).toBe(true)
  })

  it("keeps the authoring workflow in a guide section loaded with the authoring tools", () => {
    const [section] = manifest.agentInstructions.sections
    expect(section?.tools).toContain("connector_adapter_reference")
    for (const word of ["web_search", "web_fetch", "connector_adapter_save", "request_secret"]) {
      expect(section?.text).toContain(word)
    }
    expect(manifest.agentInstructions.core).not.toContain("connector_adapter_save")
  })

  it("keeps the previous adapters in an admin-only history table", () => {
    expect(manifest.schema.adapter_versions.rlsScope).toBe("admin")
    expect(Object.keys(manifest.schema.adapter_versions.fields)).toEqual([
      "identifier",
      "adapter",
      "adapterVersion",
      "savedBy",
      "savedAt",
    ])
  })
})
