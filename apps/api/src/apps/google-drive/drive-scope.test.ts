// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * An organization's Drive connection reads only the shared drives an admin
 * chose (drive-scope.ts), on every read path: the agent's search, read and
 * import tools, federated Knowledge search, folder listing (sync and folder
 * sources), file content and metadata by id. The fake Drive below answers like
 * Google does for a `drive.readonly` token: without `driveId` a listing returns
 * the connecting account's My Drive files and every shared drive's files; a
 * by-id read returns any file the account can see. Each test puts a My Drive
 * file and a file of a shared drive nobody chose beside a chosen one.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { createGoogleDriveAdapter } from "~/apps/google-drive/adapter"
import { makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import {
  type DriveAccess,
  type DriveScope,
  driveScopeOf,
  PERSONAL_DRIVE_SCOPE,
  sharedDrivesOf,
} from "~/apps/google-drive/drive-scope"
import { driveImport, driveRead, driveSearch } from "~/apps/google-drive/tools"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"

const DOC = "text/plain"
const FOLDER = "application/vnd.google-apps.folder"

interface FakeFile {
  id: string
  name: string
  mimeType: string
  driveId?: string
  parent?: string
}

/** A My Drive file, a chosen drive's files, and a non-chosen drive's file. */
const FILES: FakeFile[] = [
  { id: "mydrive01", name: "budget personal", mimeType: DOC, parent: "folderA01" },
  { id: "chosen001", name: "budget team", mimeType: DOC, driveId: "DRIVE_A", parent: "folderA01" },
  { id: "folderA01", name: "Team folder", mimeType: FOLDER, driveId: "DRIVE_A" },
  { id: "otherb001", name: "budget other", mimeType: DOC, driveId: "DRIVE_B", parent: "folderA01" },
]

const CHOSEN: DriveScope = { kind: "sharedDrives", drives: [{ id: "DRIVE_A", name: "Team" }] }
const NONE_CHOSEN: DriveScope = { kind: "sharedDrives", drives: [] }

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** Google-like answers; records every URL so a test can say what was asked. */
function fakeDrive(): string[] {
  const calls: string[] = []
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.toString())
    const path = url.pathname.replace(/^.*\/drive\/v3/, "")
    if (path === "/drives") {
      return json({
        drives: [
          { id: "DRIVE_A", name: "Team" },
          { id: "DRIVE_B", name: "Other" },
        ],
      })
    }
    if (path === "/files") {
      const driveId = url.searchParams.get("driveId")
      const q = url.searchParams.get("q") ?? ""
      const parent = /'([A-Za-z0-9_-]+)' in parents/.exec(q)?.[1]
      const files = FILES.filter((f) => !driveId || f.driveId === driveId).filter((f) =>
        parent ? f.parent === parent : f.mimeType !== FOLDER,
      )
      return json({ files })
    }
    const byId = /^\/files\/([^/]+)(\/export)?$/.exec(path)
    const file = FILES.find((f) => f.id === byId?.[1])
    if (!file) return new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 })
    if (byId?.[2] || url.searchParams.get("alt") === "media") {
      return new Response(`content of ${file.id}`, { status: 200 })
    }
    return json({ ...file, capabilities: { canDownload: true } })
  }) as never)
  return calls
}

afterEach(() => OutboundFetchTestAccess.setFetch(null))

const access = (scope: DriveScope): DriveAccess => ({ token: "tok", readScope: scope })
const ctx = (scope: DriveScope) => ({
  tx: {} as never,
  orgId: "org-1",
  userId: "user-1",
  drive: access(scope),
})
const actor = { orgId: "org-1", userId: "user-1", scopes: [] } as unknown as KnowledgeActor

function adapterFor(scope: DriveScope) {
  const fetchers = makeDriveFetchers(async () => access(scope))
  return createGoogleDriveAdapter({
    getToken: async () => "tok",
    ...fetchers,
    getPolicy: async () => ({ broadSearchEnabled: true }),
  })
}

describe("the scope of a Drive connected account", () => {
  it("an org account shares only its chosen drives; none chosen reads nothing; a person's reads all", () => {
    expect(driveScopeOf({ ownerType: "user", metadata: null })).toEqual(PERSONAL_DRIVE_SCOPE)
    // An org connection made before shared drives existed: fail closed.
    expect(driveScopeOf({ ownerType: "org", metadata: { grantedOAuthScopes: ["x"] } })).toEqual(
      NONE_CHOSEN,
    )
    expect(
      driveScopeOf({
        ownerType: "org",
        metadata: { sharedDrives: [{ id: "DRIVE_A", name: "Team" }] },
      }),
    ).toEqual(CHOSEN)
    expect(
      sharedDrivesOf({ sharedDrives: [{ id: "x" }, "junk", { id: "DRIVE_A", name: "T" }] }),
    ).toEqual([{ id: "DRIVE_A", name: "T" }])
  })
})

describe("agent tools on an org connection", () => {
  it("search returns only the chosen drive's files, asked per drive", async () => {
    const calls = fakeDrive()
    const res = await driveSearch(ctx(CHOSEN), { query: "budget" })
    expect("files" in res && res.files.map((f) => f.driveFileId)).toEqual(["chosen001"])
    const list = calls.filter((u) => u.includes("/files?"))
    expect(list.length).toBe(1)
    expect(list[0]).toContain("corpora=drive")
    expect(list[0]).toContain("driveId=DRIVE_A")
  })

  it("read refuses a My Drive file and a non-chosen drive's file, reads a chosen one", async () => {
    fakeDrive()
    for (const id of ["mydrive01", "otherb001"]) {
      const res = await driveRead(ctx(CHOSEN), { driveFileId: id })
      expect(res).toMatchObject({ error: { code: "outside_shared_drives" } })
    }
    const ok = await driveRead(ctx(CHOSEN), { driveFileId: "chosen001" })
    expect(ok).toMatchObject({ driveFileId: "chosen001", content: "content of chosen001" })
  })

  it("import refuses a My Drive file and a non-chosen drive's file", async () => {
    const calls = fakeDrive()
    for (const id of ["mydrive01", "otherb001"]) {
      const res = await driveImport(ctx(CHOSEN), { driveFileId: id })
      expect(res).toMatchObject({ error: { code: "outside_shared_drives" } })
    }
    expect(calls.some((u) => u.includes("alt=media"))).toBe(false)
  })

  it("with no shared drive chosen, search and read refuse and name the fix", async () => {
    const calls = fakeDrive()
    expect(await driveSearch(ctx(NONE_CHOSEN), { query: "budget" })).toMatchObject({
      error: { code: "shared_drives_not_chosen" },
    })
    expect(await driveRead(ctx(NONE_CHOSEN), { driveFileId: "chosen001" })).toMatchObject({
      error: { code: "shared_drives_not_chosen" },
    })
    expect(calls).toEqual([])
  })

  it("a personal connection is unchanged: its own My Drive file reads", async () => {
    fakeDrive()
    const res = await driveRead(ctx(PERSONAL_DRIVE_SCOPE), { driveFileId: "mydrive01" })
    expect(res).toMatchObject({ content: "content of mydrive01" })
  })
})

describe("Knowledge paths on an org connection", () => {
  it("federated search hits only the chosen drive", async () => {
    fakeDrive()
    const res = await adapterFor(CHOSEN).searchRemote({ query: "budget", limit: 10 }, actor)
    expect(res.hits.map((h) => h.sourceEntityId)).toEqual(["chosen001"])
  })

  it("folder listing (sync, folder sources) keeps only the chosen drive's children", async () => {
    fakeDrive()
    const res = await adapterFor(CHOSEN).listFolder?.({ folderRef: "folderA01" }, actor)
    expect(res?.items.map((i) => i.externalId)).toEqual(["chosen001"])
  })

  it("file content and metadata by id refuse a My Drive file and a non-chosen drive's file", async () => {
    const calls = fakeDrive()
    const adapter = adapterFor(CHOSEN)
    for (const id of ["mydrive01", "otherb001"]) {
      expect(await adapter.fetchRemoteContent({ sourceEntityId: id }, actor, "sync")).toEqual({
        status: "unavailable",
      })
      expect(await adapter.getRemoteMetadata?.({ sourceEntityId: id }, actor)).toBeNull()
    }
    expect(calls.some((u) => u.includes("alt=media") || u.includes("/export"))).toBe(false)
    expect(
      await adapter.fetchRemoteContent({ sourceEntityId: "chosen001" }, actor, "sync"),
    ).toMatchObject({ status: "available", text: "content of chosen001" })
  })

  it("with no shared drive chosen, search errors and a folder listing throws", async () => {
    fakeDrive()
    const adapter = adapterFor(NONE_CHOSEN)
    const res = await adapter.searchRemote({ query: "budget", limit: 10 }, actor)
    expect(res.hits).toEqual([])
    expect(res.status.state).toBe("error")
    await expect(adapter.listFolder?.({ folderRef: "folderA01" }, actor)).rejects.toThrow(
      /shares no shared drive/,
    )
  })
})

describe("fetchers on several chosen drives", () => {
  it("lists each drive and carries each drive's page token in one opaque token", async () => {
    const calls: string[] = []
    OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
      const url = new URL(String(input))
      calls.push(url.toString())
      const d = url.searchParams.get("driveId") ?? ""
      const page = url.searchParams.get("pageToken")
      if (d === "DRIVE_A" && !page) {
        return json({
          files: [{ id: "a1", name: "a1", mimeType: DOC, driveId: "DRIVE_A" }],
          nextPageToken: "pA",
        })
      }
      if (d === "DRIVE_A" && page === "pA") {
        return json({ files: [{ id: "a2", name: "a2", mimeType: DOC, driveId: "DRIVE_A" }] })
      }
      // A file Google tags with another drive is dropped, whatever the listing.
      return json({
        files: [
          { id: "b1", name: "b1", mimeType: DOC, driveId: "DRIVE_B" },
          { id: "x1", name: "x1", mimeType: DOC },
        ],
      })
    }) as never)
    const scope: DriveScope = {
      kind: "sharedDrives",
      drives: [
        { id: "DRIVE_A", name: "A" },
        { id: "DRIVE_B", name: "B" },
      ],
    }
    const fetchers = makeDriveFetchers(async () => access(scope))
    const first = await fetchers.fetchDrive({ q: "trashed = false", corpora: "allDrives" })
    expect(first.files?.map((f) => f.id)).toEqual(["a1", "b1"])
    expect(first.nextPageToken).toBeString()
    const second = await fetchers.fetchDrive({
      q: "trashed = false",
      pageToken: first.nextPageToken,
    })
    expect(second.files?.map((f) => f.id)).toEqual(["a2"])
    expect(second.nextPageToken).toBeUndefined()
    // The caller's corpora never reaches Google: each call is one drive.
    expect(calls.every((u) => u.includes("corpora=drive&") || u.endsWith("corpora=drive"))).toBe(
      true,
    )
  })
})
