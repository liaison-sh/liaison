// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  isFolderSourceCapable,
  isTextMime,
  type KnowledgeFolderItem,
  type KnowledgeSourceAdapter,
} from "~/apps/knowledge/source-protocol"

describe("KnowledgeSourceAdapter — folder-source extension (T-2)", () => {
  it("permits an adapter to declare listFolder + pickFolder", () => {
    const a: KnowledgeSourceAdapter = {
      source: "test",
      searchRemote: async () => ({
        hits: [],
        status: { source: "test", state: "complete", retryable: false },
      }),
      listFolder: async () => ({ items: [] }),
      pickFolder: async () => ({ folderRef: "x", displayName: "X" }),
    }
    expect(typeof a.listFolder).toBe("function")
    expect(typeof a.pickFolder).toBe("function")
  })

  it("KnowledgeFolderItem types both folders and files with required parentExternalId", () => {
    const f: KnowledgeFolderItem = {
      kind: "folder",
      externalId: "1",
      name: "docs",
      parentExternalId: "root",
    }
    const x: KnowledgeFolderItem = {
      kind: "file",
      externalId: "2",
      name: "README.md",
      parentExternalId: "1",
      mimeType: "text/markdown",
      modifiedAt: "2026-05-24T00:00:00Z",
    }
    expect(f.kind).toBe("folder")
    expect(x.kind).toBe("file")
    expect(x.parentExternalId).toBe("1")
  })

  it("isFolderSourceCapable reports true only when listFolder is declared", () => {
    const without: KnowledgeSourceAdapter = {
      source: "noop",
      searchRemote: async () => ({
        hits: [],
        status: { source: "noop", state: "complete", retryable: false },
      }),
    }
    const withList: KnowledgeSourceAdapter = {
      ...without,
      listFolder: async () => ({ items: [] }),
    }
    expect(isFolderSourceCapable(without)).toBe(false)
    expect(isFolderSourceCapable(withList)).toBe(true)
  })

  it("isTextMime classifies common text MIME types", () => {
    expect(isTextMime("text/markdown")).toBe(true)
    expect(isTextMime("text/plain")).toBe(true)
    expect(isTextMime("application/json")).toBe(true)
    expect(isTextMime("application/x-markdown")).toBe(true)
    expect(isTextMime("application/yaml")).toBe(true)
    expect(isTextMime("application/pdf")).toBe(false)
    expect(isTextMime("image/png")).toBe(false)
    expect(isTextMime("application/vnd.google-apps.document")).toBe(false)
    expect(isTextMime(undefined)).toBe(false)
  })
})
