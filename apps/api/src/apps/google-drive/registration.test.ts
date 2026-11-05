// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import type { BridgeExtensionFactory } from "~/modules/apps/sandbox/bridge-extensions"
import { googleDriveAppManifest } from "./manifest-descriptor"

describe("google-drive manifest descriptor", () => {
  it("declares a bridge-extension factory that yields the drive_* host methods", () => {
    const factory = (googleDriveAppManifest as { _bridgeExtension: BridgeExtensionFactory })
      ._bridgeExtension
    expect(typeof factory).toBe("function")
    const methods = factory({
      appName: "google-drive",
      orgId: "org-1",
      userId: "user-1",
      txDb: {} as unknown as RlsClient,
      actorType: "user",
    })
    expect(Object.keys(methods).sort()).toEqual([
      "drive_chooseSharedDrives",
      "drive_export",
      "drive_import",
      "drive_onAccountDisconnected",
      "drive_read",
      "drive_search",
      "drive_sharedDrives",
      "drive_upload",
    ])
    for (const fn of Object.values(methods)) {
      expect(typeof fn).toBe("function")
    }
  })

  it("requests the drive.file write scope on the oauth2 connection (upload path)", () => {
    const scopes = (
      googleDriveAppManifest as unknown as {
        connections: { drive: { scopes: string[] } }
      }
    ).connections.drive.scopes
    expect(scopes).toContain("https://www.googleapis.com/auth/drive.file")
    // reads keep working unchanged
    expect(scopes).toContain("https://www.googleapis.com/auth/drive.readonly")
  })

  it("declares the upload tool under google-drive:files:write with TWO byte sources, only name required", () => {
    const tools = (
      googleDriveAppManifest as unknown as {
        tools: Record<
          string,
          {
            requiredScopes: string[]
            handler: string
            description: string
            params: { required?: string[]; properties: Record<string, unknown> }
          }
        >
      }
    ).tools
    expect(tools.upload).toBeDefined()
    expect(tools.upload.requiredScopes).toEqual(["google-drive:files:write"])
    expect(tools.upload.handler).toBe("driveUpload")
    // `contentBase64` is no longer required: an agent must EMIT it as tool-call
    // arguments, so a file well inside the 5 MB cap can still be unsendable
    // (a ~230 kB PDF is ~307 000 characters). sourceFileId is the way out, and
    // the schema must let a caller use it alone.
    expect(tools.upload.params.required?.sort()).toEqual(["name"])
    expect(tools.upload.params.properties.sourceFileId).toEqual({ type: "string" })
    expect(tools.upload.params.properties.contentBase64).toEqual({ type: "string" })
    // The description must STEER: a tool with two payload paths and no stated
    // preference gets the expensive one by default.
    expect(tools.upload.description).toMatch(/PREFER sourceFileId/)
    expect(tools.upload.description).toMatch(/source_not_found/)
  })

  it("no longer claims to be read-only: instructions/setup name the app-owned folder and drive.file honestly", () => {
    const m = googleDriveAppManifest as unknown as {
      agentInstructions: string
      connections: { drive: { setupGuide: { summary: string } } }
    }
    expect(m.agentInstructions).not.toMatch(/It is read-only/)
    expect(m.agentInstructions).toContain("Liaison Reports")
    expect(m.agentInstructions).toContain("drive_scope_missing")
    expect(m.connections.drive.setupGuide.summary).toContain("drive.file")
  })
})
