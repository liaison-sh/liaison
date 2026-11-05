// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { workbookBytes } from "./__test-helpers__/workbook"
import { createGoogleDriveAdapter } from "./adapter"
import { XLSX_MIME } from "./drive-text"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:sources:read"],
  dimensionGrants: {},
}

describe("Google Drive Knowledge source adapter", () => {
  it("maps remote search results and shared-drive incompleteSearch to partial", async () => {
    const fetchDrive = mock(async () => ({
      files: [
        {
          id: "g1",
          name: "Company Policies",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://drive/g1",
          modifiedTime: "2026-05-01T00:00:00Z",
          owners: [{ displayName: "Alice" }],
          capabilities: { canDownload: true },
        },
      ],
      incompleteSearch: true,
      nextPageToken: "next",
    }))
    const adapter = createGoogleDriveAdapter({
      fetchDrive,
      getToken: async () => "token",
      getPolicy: async () => ({ broadSearchEnabled: true }),
    })
    const result = await adapter.searchRemote(
      { query: "policies", limit: 10, filters: {}, cursors: {} },
      actor,
    )
    expect(result.hits[0]).toMatchObject({
      source: "google-drive",
      sourceEntityId: "g1",
      title: "Company Policies",
      canFetchContent: true,
      status: "available",
    })
    expect(result.status.state).toBe("partial")
    expect(result.status.cursor).toBe("next")
  })

  it("returns unavailable reconnect status when OAuth is revoked", async () => {
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => {
        throw Object.assign(new Error("revoked"), { code: "OAUTH_REVOKED" })
      },
      getToken: async () => "token",
      getPolicy: async () => ({ broadSearchEnabled: true }),
    })
    const result = await adapter.searchRemote(
      { query: "x", limit: 10, filters: {}, cursors: {} },
      actor,
    )
    expect(result.hits).toEqual([])
    expect(result.status.state).toBe("unauthorized")
    expect(result.status.message).toMatch(/reconnect/i)
  })

  it("enforces metadata-only unsupported fetch for non-exportable files", async () => {
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => ({}),
      getToken: async () => "token",
      getMetadata: async () => ({
        id: "g2",
        name: "Locked",
        mimeType: "application/pdf",
        webViewLink: "https://drive/g2",
        capabilities: { canDownload: false },
      }),
    })
    const content = await adapter.fetchRemoteContent(
      { sourceEntityId: "g2" },
      actor,
      "agent_context",
    )
    expect(content.status).toBe("unsupported")
    expect(content.text).toBeUndefined()
  })

  it("exports a Sheet as CSV and turns an Excel workbook into CSV, so the sync imports them", async () => {
    const exported: string[] = []
    const files: Record<string, { mimeType: string }> = {
      sheet1: { mimeType: "application/vnd.google-apps.spreadsheet" },
      book1: { mimeType: XLSX_MIME },
    }
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => ({}),
      getToken: async () => "token",
      getMetadata: async ({ id }) => ({
        id,
        name: `${id}.file`,
        mimeType: files[id]!.mimeType,
        capabilities: { canDownload: true },
      }),
      exportGoogleDoc: async ({ mimeType }) => {
        exported.push(mimeType)
        return { text: "a,b\n1,2" }
      },
      downloadBytes: async () => ({
        bytes: workbookBytes([{ name: "S", rows: [["k"], ["v"]] }]),
      }),
    })
    const sheet = await adapter.fetchRemoteContent({ sourceEntityId: "sheet1" }, actor, "sync")
    expect(sheet).toMatchObject({ status: "available", text: "a,b\n1,2" })
    expect(exported).toEqual(["text/csv"])
    const book = await adapter.fetchRemoteContent({ sourceEntityId: "book1" }, actor, "sync")
    expect(book).toMatchObject({ status: "available", text: "Sheet: S\nk\nv" })
    expect(adapter.hasText?.(XLSX_MIME)).toBe(true)
    expect(adapter.hasText?.("application/pdf")).toBe(false)
  })

  it("I1: fails closed when no policy resolver is provided (no opt-in present)", async () => {
    let calls = 0
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => {
        calls++
        return { files: [] }
      },
      getToken: async () => "token",
      // No getPolicy → fail closed
    })
    const result = await adapter.searchRemote(
      { query: "policy", limit: 10, filters: {}, cursors: {} },
      actor,
    )
    expect(calls).toBe(0)
    expect(result.status.state).toBe("skipped")
  })

  it("I21: surfaces policy-fetch failure as error (operator-visible misconfiguration)", async () => {
    let calls = 0
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => {
        calls++
        return { files: [] }
      },
      getToken: async () => "token",
      getPolicy: async () => {
        throw new Error("policy lookup failed")
      },
    })
    const result = await adapter.searchRemote(
      { query: "policy", limit: 10, filters: {}, cursors: {} },
      actor,
    )
    expect(calls).toBe(0)
    expect(result.status.state).toBe("error")
    expect(result.status.message).toMatch(/policy/i)
  })

  it("I17: query sanitizer drops quotes, backslashes, and control chars; keeps spaces", async () => {
    const { sanitizeDriveQuery } = await import("./adapter")
    expect(sanitizeDriveQuery("Company Policies")).toBe("Company Policies")
    expect(sanitizeDriveQuery("a' OR title='b")).toBe("a OR title=b")
    expect(sanitizeDriveQuery("path\\to\\file")).toBe("pathtofile")
    expect(sanitizeDriveQuery("hello\x00\x1fworld")).toBe("helloworld")
    expect(sanitizeDriveQuery("  trimmed  ")).toBe("trimmed")
  })

  it("skips broad Drive search unless policy and OAuth posture explicitly allow it", async () => {
    let calls = 0
    const adapter = createGoogleDriveAdapter({
      fetchDrive: async () => {
        calls++
        return { files: [] }
      },
      getToken: async () => "token",
      getPolicy: async () => ({ connectionMode: "selected", broadSearchEnabled: false }),
    })
    const result = await adapter.searchRemote(
      { query: "policy", limit: 10, filters: {}, cursors: {} },
      actor,
    )
    expect(calls).toBe(0)
    expect(result.status.state).toBe("skipped")
  })
})
