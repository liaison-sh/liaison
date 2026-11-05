// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { summarizeAddConnection } from "./summarizers"

describe("summarizeAddConnection — security-sensitive external MCP connection", () => {
  it("names the server, transport, and auth mode without ever echoing the bearer token", async () => {
    const s = await summarizeAddConnection({
      displayName: "Inventory ERP",
      httpUrl: "https://erp.example.com/mcp",
      transport: "http",
      authFlavor: "bearer",
      bearerToken: "super-secret-value",
    })
    expect(s.title).toBe(
      'Connect external MCP server "Inventory ERP" at https://erp.example.com/mcp',
    )
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Transport: http/)
    expect(joined).toMatch(/bearer token \(stored encrypted, never shown\)/)
    expect(joined).not.toMatch(/super-secret-value/)
  })

  it("flags the connection as security-sensitive in a line", async () => {
    const s = await summarizeAddConnection({
      displayName: "Public feed",
      httpUrl: "https://public.example.com",
    })
    expect(s.lines.join("\n")).toMatch(/SECURITY-SENSITIVE/)
    expect(s.lines.join("\n")).toMatch(/Auth: none/)
  })

  it("says when the connection is personal, and that it is shared otherwise", async () => {
    const personal = await summarizeAddConnection({
      displayName: "My HubSpot",
      httpUrl: "https://mcp.hubspot.example",
      ownershipScope: "personal",
    })
    expect(personal.title).toBe(
      'Connect personal external MCP server "My HubSpot" at https://mcp.hubspot.example',
    )
    expect(personal.lines.join("\n")).toMatch(/Ownership: personal/)
    const shared = await summarizeAddConnection({
      displayName: "ERP",
      httpUrl: "https://erp.example.com",
    })
    expect(shared.lines.join("\n")).toMatch(/Ownership: shared with the whole org/)
  })
})
