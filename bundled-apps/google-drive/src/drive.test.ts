// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Google Drive app's handlers against a fake Drive answering `ctx.fetch`
// (test-ctx.ts): which account each call goes through, the organization
// connection's shared-drives scope, picked mode, the reports-folder upload, the
// host-side import, the picker page link and its route, the knowledge sync walk,
// provisioning and the export slot.
import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"
import { syncDriveFolder, syncPickedFiles } from "./knowledge"
import { drivePicker, pickerRemove, pickerState, savePicks } from "./picker"
import { provisionDrive } from "./provision"
import {
  driveChooseSharedDrives,
  driveSharedDrives,
  summarizeChooseSharedDrives,
} from "./shared-drives"
import { account, fakeCtx } from "./test-ctx"
import { driveImport, driveRead, driveSearch, driveUpload, exportGoogleDrive } from "./tools"

const FULL = { grantedOAuthScopes: ["https://www.googleapis.com/auth/drive.readonly"] }
const PICKED_GRANT = { grantedOAuthScopes: ["https://www.googleapis.com/auth/drive.file"] }
const DOC = "application/vnd.google-apps.document"
const SHEET = "application/vnd.google-apps.spreadsheet"
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const FOLDER = "application/vnd.google-apps.folder"

const mine = () => account({ id: "acc-me", identifier: "ana@example.com", metadata: { ...FULL } })
const org = (sharedDrives: unknown[] = []) =>
  account({
    id: "acc-org",
    identifier: "team@example.com",
    ownerType: "org",
    ownerId: null,
    metadata: { sharedDrives },
  })

const FILES: Record<
  string,
  { name: string; mimeType: string; driveId?: string; parents?: string[] }
> = {
  doc00001: { name: "Plan", mimeType: DOC, parents: ["root0001"] },
  sheet001: { name: "Leads", mimeType: SHEET, parents: ["root0001"] },
  xlsx0001: { name: "Book.xlsx", mimeType: XLSX, parents: ["root0001"] },
  pdf00001: { name: "Scan.pdf", mimeType: "application/pdf", parents: ["root0001"] },
  sub00001: { name: "Specs", mimeType: FOLDER, parents: ["root0001"] },
  team0001: { name: "Team plan", mimeType: DOC, driveId: "DRIVE_TEAM" },
  root0001: { name: "Root", mimeType: FOLDER },
}

/** A Drive answering by path: listings, metadata, exports, downloads, uploads. */
function drive(path: string, q: URLSearchParams) {
  if (path === "/files" && q.get("uploadType") === "multipart")
    return { body: { id: "new-file", webViewLink: "https://drive/new" } }
  if (path === "/files" && q.has("q") && (q.get("q") ?? "").includes("appProperties"))
    return { body: { files: [] } }
  if (path === "/files" && !q.has("q") && !q.has("corpora")) return { body: { id: "reports01" } }
  if (path === "/files") {
    const query = q.get("q") ?? ""
    const parent = /'([^']+)' in parents/.exec(query)?.[1]
    const driveId = q.get("driveId")
    const files = Object.entries(FILES)
      .filter(([, f]) => (parent ? f.parents?.includes(parent) : true))
      .filter(([, f]) => !driveId || f.driveId === driveId)
      .map(([id, f]) => ({
        id,
        ...f,
        modifiedTime: "2026-11-01T00:00:00.000Z",
        webViewLink: `https://drive/${id}`,
      }))
    return { body: { files } }
  }
  if (path === "/drives")
    return {
      body: {
        drives: [
          { id: "DRIVE_TEAM", name: "Team" },
          { id: "DRIVE_OPS", name: "Ops" },
        ],
      },
    }
  const id = /^\/files\/([^/?]+)/.exec(path)?.[1] ?? ""
  const f = FILES[id]
  if (!f) return { status: 404, body: { error: { message: "File not found" } } }
  if (path.endsWith("/export")) return { body: `exported ${id} as ${q.get("mimeType")}` }
  if (q.get("alt") === "media") return { body: `content of ${id}` }
  return {
    body: {
      id,
      ...f,
      capabilities: { canDownload: true },
      modifiedTime: "2026-11-01T00:00:00.000Z",
    },
  }
}

describe("manifest", () => {
  it("is the catalog app, version 2.0.1, with its pages, sources and provisioning", () => {
    expect(manifest.name).toBe("google-drive")
    expect(manifest.version).toBe("2.0.1")
    // The platform's Picker widget: no page script, a drive.file token only.
    expect(manifest.pages.picker.source).toBeUndefined()
    expect(manifest.pages.picker.widget).toEqual({
      kind: "google-picker",
      connection: "drive",
      route: "savePicks",
      tokenScopes: ["https://www.googleapis.com/auth/drive.file"],
    })
    expect(Object.keys(manifest.knowledgeSources).sort()).toEqual(["folder", "picked"])
    expect(manifest.connections.drive.oauthClient).toEqual({ key: "google-drive:drive" })
    expect(manifest.provisioning.handler).toBe("provisionDrive")
  })
})

describe("search and read", () => {
  it("a person's own Drive: search and read go through their account", async () => {
    const f = fakeCtx({ accounts: [org([{ id: "DRIVE_TEAM", name: "Team" }]), mine()], drive })
    const out = (await driveSearch({ query: "plan" }, f.ctx)) as {
      files: Array<{ driveFileId: string }>
    }
    expect(out.files.length).toBeGreaterThan(0)
    expect(f.calls[0]?.account).toBe("acc-me")
    expect(new URL(f.calls[0]!.url).searchParams.get("q")).toContain("fullText contains 'plan'")
    const read = (await driveRead({ driveFileId: "doc00001" }, f.ctx)) as {
      content: string
      contentMimeType: string
    }
    expect(read).toMatchObject({
      content: "exported doc00001 as text/plain",
      contentMimeType: "text/plain",
    })
    const sheet = (await driveRead({ driveFileId: "sheet001" }, f.ctx)) as { content: string }
    expect(sheet.content).toBe("exported sheet001 as text/csv")
  })

  it("a workbook is converted host-side; a PDF is refused with the way to import it", async () => {
    const f = fakeCtx({ accounts: [mine()], drive })
    await driveRead({ driveFileId: "xlsx0001" }, f.ctx)
    expect(f.calls.at(-1)?.convert).toBe("xlsx-text")
    const pdf = (await driveRead({ driveFileId: "pdf00001" }, f.ctx)) as { error: { code: string } }
    expect(pdf.error.code).toBe("not_readable_as_text")
  })

  it("an org connection reads only its chosen shared drives, and nothing before one is chosen", async () => {
    const none = fakeCtx({ accounts: [org()], drive })
    expect(await driveSearch({ query: "plan" }, none.ctx)).toMatchObject({
      error: { code: "shared_drives_not_chosen" },
    })
    expect(none.calls).toEqual([])
    const f = fakeCtx({ accounts: [org([{ id: "DRIVE_TEAM", name: "Team" }])], drive })
    const out = (await driveSearch({ query: "plan" }, f.ctx)) as {
      files: Array<{ driveFileId: string }>
    }
    expect(out.files.map((x) => x.driveFileId)).toEqual(["team0001"])
    expect(new URL(f.calls[0]!.url).searchParams.get("driveId")).toBe("DRIVE_TEAM")
    expect(await driveRead({ driveFileId: "doc00001" }, f.ctx)).toMatchObject({
      error: { code: "outside_shared_drives" },
    })
  })

  it("picked mode: the picked items answer the search whatever the words", async () => {
    const picked = account({
      id: "acc-p",
      identifier: "me@gmail.com",
      metadata: { ...PICKED_GRANT, pickedItems: [{ id: "doc00001", name: "Plan", mimeType: DOC }] },
    })
    const f = fakeCtx({ accounts: [picked], drive })
    const out = (await driveSearch({ query: "" }, f.ctx)) as {
      mode: string
      files: unknown[]
      hint: string
    }
    expect(out.mode).toBe("picked")
    expect(out.files).toEqual([{ driveFileId: "doc00001", name: "Plan", mimeType: DOC }])
    expect(out.hint).toContain("google-drive__drive_picker")
  })

  it("not connected: said, never guessed", async () => {
    expect(await driveSearch({ query: "x" }, fakeCtx({}).ctx)).toMatchObject({
      error: { code: "not_connected" },
    })
  })
})

describe("import and upload", () => {
  it("import: the host downloads the file onto the person's own import row, with the account's token", async () => {
    const f = fakeCtx({ accounts: [mine()], drive })
    const out = (await driveImport({ driveFileId: "pdf00001" }, f.ctx)) as {
      fileId: string
      nextStep: string
    }
    expect(out.fileId).toBe("file-1")
    expect(out.nextStep).toContain('attachments:["file-1"]')
    expect(f.rows[0]).toEqual({
      entity: "imports",
      data: {
        owner_type: "user",
        owner_id: "user-1",
        drive_file_id: "pdf00001",
        filename: "Scan.pdf",
      },
    })
    expect(f.imports[0]).toMatchObject({
      targetApp: "google-drive",
      targetEntityType: "import",
      targetEntityId: "row-1",
      auth: { connection: "drive", account: "acc-me", scheme: "bearer" },
    })
    expect(String(f.imports[0]?.url)).toContain("/files/pdf00001?alt=media")
    expect(await driveImport({ driveFileId: "doc00001" }, f.ctx)).toMatchObject({
      error: { code: "not_downloadable" },
    })
  })

  it("upload by reference: one multipart/related request into the app's reports folder", async () => {
    const f = fakeCtx({ accounts: [mine()], drive })
    const out = await driveUpload(
      { name: "Report.pdf", mimeType: "application/pdf", sourceFileId: "kfile-1" },
      f.ctx,
    )
    expect(out).toEqual({
      fileId: "new-file",
      name: "Report.pdf",
      webViewLink: "https://drive/new",
      folderId: "reports01",
    })
    const created = f.calls.find((c) => c.method === "POST" && !c.url.includes("upload"))
    expect(JSON.parse(String(created?.body))).toMatchObject({
      name: "Liaison Reports",
      appProperties: { liaisonReports: "1" },
    })
    const upload = f.calls.find((c) => c.url.includes("/upload/drive/v3/files"))
    expect(upload?.body).toEqual({
      related: true,
      multipart: [
        {
          name: "metadata",
          value: JSON.stringify({
            name: "Report.pdf",
            mimeType: "application/pdf",
            parents: ["reports01"],
          }),
          contentType: "application/json; charset=UTF-8",
        },
        { name: "media", fileId: "kfile-1", contentType: "application/pdf" },
      ],
    })
  })

  it("upload refusals are named: both sources, bad base64, an org connection, a full Drive", async () => {
    const f = fakeCtx({ accounts: [mine()], drive })
    expect(
      await driveUpload({ name: "x", sourceFileId: "a", contentBase64: "AA==" }, f.ctx),
    ).toMatchObject({
      error: { code: "invalid_params" },
    })
    expect(await driveUpload({ name: "x", contentBase64: "%%%" }, f.ctx)).toMatchObject({
      error: { code: "invalid_params" },
    })
    const o = fakeCtx({ accounts: [org([{ id: "DRIVE_TEAM", name: "Team" }])], drive })
    expect(await driveUpload({ name: "x", contentBase64: "AA==" }, o.ctx)).toMatchObject({
      error: { code: "org_drive_upload_unsupported" },
    })
    const full = fakeCtx({
      accounts: [mine()],
      drive: (path, q, call) =>
        call.url.includes("/upload/")
          ? {
              status: 403,
              body: { error: { message: "full", errors: [{ reason: "storageQuotaExceeded" }] } },
            }
          : drive(path, q),
    })
    expect(await driveUpload({ name: "x", contentBase64: "AA==" }, full.ctx)).toMatchObject({
      error: { code: "drive_storage_full" },
    })
  })
})

describe("shared drives", () => {
  it("an admin lists what the org account can share and chooses by name; the folders sync again", async () => {
    const f = fakeCtx({
      accounts: [org()],
      drive,
      sources: [
        {
          id: "s-org",
          ownerUserId: null,
          config: { account: "team@example.com" },
          sourceAccount: null,
        },
      ],
    })
    const listed = (await driveSharedDrives({}, f.ctx)) as { available: { available: unknown[] } }
    expect(listed.available.available).toEqual([
      { id: "DRIVE_TEAM", name: "Team", chosen: false },
      { id: "DRIVE_OPS", name: "Ops", chosen: false },
    ])
    const out = await driveChooseSharedDrives({ drives: ["team"] }, f.ctx)
    expect(out).toMatchObject({
      changed: true,
      account: { sharedDrives: [{ id: "DRIVE_TEAM", name: "Team" }] },
    })
    expect(f.metadataWrites).toEqual([
      { id: "acc-org", patch: { sharedDrives: [{ id: "DRIVE_TEAM", name: "Team" }] } },
    ])
    expect(f.sourceOps.filter((o) => o.op === "sync")).toEqual([{ op: "sync", id: "s-org" }])
    expect(await driveChooseSharedDrives({ drives: ["Elsewhere"] }, f.ctx)).toMatchObject({
      error: { code: "not_a_member" },
    })
  })

  it("a member who does not manage the org connection cannot choose", async () => {
    const f = fakeCtx({ accounts: [{ ...org(), canManage: false }], drive })
    expect(await driveChooseSharedDrives({ drives: ["Team"] }, f.ctx)).toMatchObject({
      error: { code: "forbidden" },
    })
    expect(f.metadataWrites).toEqual([])
  })

  it("the approval card names the drives", async () => {
    expect(
      await summarizeChooseSharedDrives({ drives: ["Team"], account: "team@example.com" }),
    ).toMatchObject({
      title: "Share 1 shared drive with the team",
      subtitle: "Drive connection: team@example.com",
    })
  })

  it("provisioning: a dry run writes nothing, an apply chooses", async () => {
    const f = fakeCtx({ accounts: [org()], drive })
    const dry = await provisionDrive(
      { config: { sharedDrives: [{ drives: ["Team", "Ops"] }] }, dryRun: true },
      f.ctx,
    )
    expect(dry.changed).toEqual(["sharedDrives team@example.com: Team, Ops"])
    expect(f.metadataWrites).toEqual([])
    await provisionDrive({ config: { sharedDrives: [{ drives: ["Team"] }] }, dryRun: false }, f.ctx)
    expect(f.metadataWrites).toHaveLength(1)
  })
})

describe("the picker", () => {
  const picked = () =>
    account({
      id: "acc-p",
      identifier: "me@gmail.com",
      metadata: { ...PICKED_GRANT, pickedItems: [] },
    })

  it("drive_picker answers a page handle for the picked-mode account, with the Picker's key", async () => {
    const f = fakeCtx({
      accounts: [picked()],
      config: { pickerApiKey: "key-123", pickerAppId: "1234567" },
    })
    const out = (await drivePicker({}, f.ctx)) as { page: { handle: string } }
    expect(out.page.handle).toMatch(/^lpg_/)
    expect(f.links).toEqual([
      { page: "picker", params: { account: "acc-p", apiKey: "key-123", appId: "1234567" } },
    ])
  })

  it("drive_picker: full mode needs no picking; an unset Picker says where to set it", async () => {
    const full = fakeCtx({ accounts: [mine()], config: { pickerApiKey: "k", pickerAppId: "1" } })
    expect(await drivePicker({}, full.ctx)).toMatchObject({
      message: expect.stringContaining("nothing to pick"),
    })
    const unset = fakeCtx({ accounts: [picked()] })
    expect(await drivePicker({}, unset.ctx)).toMatchObject({
      error: { code: "picker_not_configured" },
    })
    expect(unset.links).toEqual([])
  })

  it("the page's route saves the picks on the account and syncs them into Knowledge", async () => {
    const f = fakeCtx({ accounts: [picked()] })
    const out = await savePicks(
      {
        body: { add: [{ id: "doc00001", name: "Plan", mimeType: DOC }] },
        params: { account: "acc-p" },
        page: "picker",
      },
      f.ctx,
    )
    expect(out).toEqual({
      picked: [{ id: "doc00001", name: "Plan", mimeType: DOC }],
      sourceId: "source-1",
    })
    expect(f.metadataWrites[0]?.patch).toEqual({
      pickedItems: [{ id: "doc00001", name: "Plan", mimeType: DOC }],
    })
    expect(f.sourceOps.map((o) => o.op)).toEqual(["ensure", "sync"])
    expect(f.sourceOps[0]).toMatchObject({
      kind: "picked",
      ref: "liaison-picked-items",
      account: "me@gmail.com",
      scope: "personal",
    })
    // The body is the browser's: a malformed one changes nothing.
    expect(
      await savePicks(
        { body: { add: [{ id: "x" }] }, params: { account: "acc-p" }, page: "picker" },
        f.ctx,
      ),
    ).toMatchObject({
      error: { code: "invalid_body" },
    })
    // Another person's account (not in the run's list) is refused.
    expect(
      await savePicks(
        {
          body: { add: [{ id: "doc00001", name: "Plan", mimeType: DOC }] },
          params: { account: "acc-x" },
          page: "picker",
        },
        f.ctx,
      ),
    ).toMatchObject({ error: { code: "not_found" } })
    await pickerRemove({ account: "acc-p", itemId: "doc00001" }, f.ctx)
    expect(f.metadataWrites.at(-1)?.patch).toEqual({ pickedItems: [] })
    const state = (await pickerState({}, f.ctx)) as {
      pickerConfigured: boolean
      accounts: Array<{ mode: string }>
    }
    expect(state).toMatchObject({ pickerConfigured: false, accounts: [{ mode: "picked" }] })
  })
})

describe("knowledge sources", () => {
  it("a folder syncs depth first: its text files, its subfolders as folders, then a prune", async () => {
    const f = fakeCtx({ accounts: [mine()], drive })
    const first = await syncDriveFolder(
      {
        sourceId: "s1",
        kind: "folder",
        config: { ref: "root0001" },
        cursor: null,
        scope: "personal",
      },
      f.ctx,
    )
    expect(first.documents?.upsert?.map((d) => d.externalId).sort()).toEqual([
      "doc00001",
      "sheet001",
      "xlsx0001",
    ])
    expect(first.folders?.upsert).toEqual([
      { externalId: "sub00001", name: "Specs", parentExternalId: null },
    ])
    expect(first.done).toBe(false)
    expect(first.nextCursor).toEqual({ stack: [{ id: "sub00001", parent: "sub00001" }] })
    const second = await syncDriveFolder(
      {
        sourceId: "s1",
        kind: "folder",
        config: { ref: "root0001" },
        cursor: first.nextCursor,
        scope: "personal",
      },
      f.ctx,
    )
    expect(second).toMatchObject({ done: true, prune: true, nextCursor: null })
  })

  it("an org folder with no shared drive chosen is hidden (pruned), with no Drive call", async () => {
    const f = fakeCtx({ accounts: [org()], drive })
    const out = await syncDriveFolder(
      {
        sourceId: "s2",
        kind: "folder",
        config: { ref: "root0001" },
        cursor: null,
        scope: "organization",
      },
      f.ctx,
    )
    expect(out).toEqual({ done: true, prune: true, nextCursor: null })
    expect(f.calls).toEqual([])
  })

  it("the picked files sync as documents, a picked folder is walked", async () => {
    const p = account({
      id: "acc-p",
      identifier: "me@gmail.com",
      metadata: {
        ...PICKED_GRANT,
        pickedItems: [
          { id: "doc00001", name: "Plan", mimeType: DOC },
          { id: "root0001", name: "Root", mimeType: FOLDER },
        ],
      },
    })
    const f = fakeCtx({ accounts: [p], drive })
    const out = await syncPickedFiles(
      {
        sourceId: "s3",
        kind: "picked",
        config: { account: "me@gmail.com" },
        cursor: null,
        scope: "personal",
      },
      f.ctx,
    )
    expect(out.documents?.upsert?.map((d) => d.externalId)).toEqual(["doc00001"])
    expect(out.folders?.upsert).toEqual([
      { externalId: "root0001", name: "Root", parentExternalId: null },
    ])
    expect(out.nextCursor).toEqual({ stack: [{ id: "root0001", parent: "root0001" }] })
  })
})

describe("export", () => {
  it("lists the Drive accounts the caller sees, as JSON or CSV", async () => {
    const f = fakeCtx({ accounts: [mine()] })
    expect(await exportGoogleDrive({}, f.ctx)).toEqual([
      {
        id: "acc-me",
        connectionName: "drive",
        identifier: "ana@example.com",
        displayName: "",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])
    expect(await exportGoogleDrive({ format: "csv" }, f.ctx)).toBe(
      "id,connectionName,identifier,displayName,status,createdAt\nacc-me,drive,ana@example.com,,active,2026-01-01T00:00:00.000Z\n",
    )
  })
})
