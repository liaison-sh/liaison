// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { ALL_CREDENTIAL_FIELDS } from "@liaison/api-connector-core"
import { validateAppManifest } from "~/modules/apps/contract"
import manifest from "./app.manifest.json"

describe("api-connector manifest", () => {
  it("validates against the manifest schema", () => {
    const r = validateAppManifest(manifest)
    expect(r.error).toBeUndefined()
    expect(r.success).toBe(true)
  })

  it("declares one multiInstance credentials connection carrying every auth field, all optional", () => {
    const api = manifest.connections.api
    expect(api.type).toBe("credentials")
    expect(api.multiInstance).toBe(true)
    expect(api.credentialFields.map((f) => f.name).sort()).toEqual(
      [...ALL_CREDENTIAL_FIELDS].sort(),
    )
    expect(api.credentialFields.every((f) => f.required === false)).toBe(true)
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
    for (const tool of Object.values(manifest.tools)) expect(tool.timeoutMs).toBe(60_000)
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
