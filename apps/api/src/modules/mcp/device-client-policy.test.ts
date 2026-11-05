// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DESKTOP_DEVICE_CLIENT_ID, deviceClientDecision } from "./device-client-policy"

describe("mcp device client policy", () => {
  it("admits the desktop app on an instance whose list only names the CLI", () => {
    // Production's own configuration on 2026-09-23.
    expect(deviceClientDecision(new Set(["mcp-cli"]), DESKTOP_DEVICE_CLIENT_ID)).toBe("allowed")
  })

  it("still refuses a client nobody listed", () => {
    expect(deviceClientDecision(new Set(["mcp-cli"]), "something-else")).toBe("unregistered")
  })

  it("admits nobody, the desktop included, while the flow is switched off", () => {
    expect(deviceClientDecision(new Set(), DESKTOP_DEVICE_CLIENT_ID)).toBe("flow-disabled")
    expect(deviceClientDecision(new Set(), "mcp-cli")).toBe("flow-disabled")
  })

  it("keeps the listed clients and the wildcard", () => {
    expect(deviceClientDecision(new Set(["mcp-cli"]), "mcp-cli")).toBe("allowed")
    expect(deviceClientDecision(new Set(["*"]), "anything")).toBe("allowed")
  })

  it("names the same client id the desktop shell initiates with", async () => {
    const sidecar = await Bun.file(
      new URL("../../../../desktop/src-tauri/src/sidecar.rs", import.meta.url),
    ).text()
    expect(sidecar).toContain(
      `pub const DESKTOP_DEVICE_CLIENT_ID: &str = "${DESKTOP_DEVICE_CLIENT_ID}";`,
    )
  })
})
