// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * google-drive/tools.ts — host-side agent-tool logic. The Drive HTTP layer is
 * exercised through the SSRF-safe outbound helper's test seam (the pattern
 * drive-rest.test.ts uses); the Drive connection (token + read scope) is injected via `ctx.drive`,
 * so these tests need no connection-service or DB plumbing.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { workbookBytes } from "./__test-helpers__/workbook"
import { PERSONAL_DRIVE_SCOPE } from "./drive-scope"
import { XLSX_MIME } from "./drive-text"
import {
  DRIVE_PICKED_HINT,
  DRIVE_PICKED_NONE_HINT,
  DRIVE_SEARCH_EMPTY_HINT,
  driveExport,
  driveImport,
  driveRead,
  driveSearch,
  driveUpload,
  UPLOAD_SIZE_CAP_BYTES,
} from "./tools"

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
})

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  OutboundFetchTestAccess.setFetch((async (url: string | URL | Request) =>
    handler(String(url))) as never)
}

const ctxBase = { tx: {} as never, orgId: "org-1", userId: "user-1" }
/** A personal Drive connection: reads what its grant reads. */
const PERSONAL = { token: "tok", readScope: PERSONAL_DRIVE_SCOPE }

/** Like stubFetch but records every (url, init) pair for request-shape asserts. */
function recordingStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  OutboundFetchTestAccess.setFetch((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as never)
  return calls
}

describe("driveSearch", () => {
  it("returns not_connected when the org has no Drive token", async () => {
    const res = await driveSearch({ ...ctxBase, drive: null }, { query: "report" })
    expect("error" in res && res.error.code).toBe("not_connected")
  })

  it("maps Drive API results to file hits", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            files: [
              { id: "d1", name: "Q3 Report.pdf", mimeType: "application/pdf" },
              { id: "d2", name: "Notes", mimeType: "application/vnd.google-apps.document" },
            ],
          }),
          { status: 200 },
        ),
    )
    const res = await driveSearch({ ...ctxBase, drive: PERSONAL }, { query: "report" })
    expect("files" in res).toBe(true)
    if (!("files" in res)) throw new Error("expected files")
    expect(res.files).toHaveLength(2)
    expect(res.files[0]).toMatchObject({ driveFileId: "d1", name: "Q3 Report.pdf" })
  })

  it("an empty result points the agent to the picker before it says the file does not exist", async () => {
    stubFetch(async () => new Response(JSON.stringify({ files: [] }), { status: 200 }))
    const res = await driveSearch({ ...ctxBase, drive: PERSONAL }, { query: "budget" })
    if (!("files" in res)) throw new Error("expected files")
    expect(res.files).toEqual([])
    expect(res.hint).toBe(DRIVE_SEARCH_EMPTY_HINT)
    expect(res.hint).toContain("kernel__drive_picker")
  })

  it("returns an empty list for a blank query without calling Drive", async () => {
    stubFetch(async () => {
      throw new Error("should not fetch")
    })
    const res = await driveSearch({ ...ctxBase, drive: PERSONAL }, { query: "   " })
    expect("files" in res && res.files).toEqual([])
  })
})

describe("driveUpload", () => {
  const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  const CONTENT = Buffer.from("fake pptx bytes")
  const CONTENT_B64 = CONTENT.toString("base64")

  it("returns not_connected without a Drive token", async () => {
    const res = await driveUpload(
      { ...ctxBase, drive: null },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("not_connected")
  })

  it("rejects missing name/contentBase64", async () => {
    const a = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "", contentBase64: CONTENT_B64 },
    )
    expect("error" in a && a.error.code).toBe("invalid_params")
    const b = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: "" },
    )
    expect("error" in b && b.error.code).toBe("invalid_params")
  })

  // ── upload BY REFERENCE (sourceFileId) ────────────────────────────────────
  // The point of this path is that the CALLER never holds the bytes. An agent
  // must emit contentBase64 as tool-call arguments, and a ~230 kB PDF is
  // ~307 000 characters — which is how a quarterly report once ended up
  // undeliverable to Drive while sitting far inside the 5 MB cap.
  /** Minimal RlsClient stand-in: one `execute` returning the rows we choose. */
  const txWith = (rows: unknown[]) => ({ execute: async () => rows }) as never

  it("rejects a call with NEITHER contentBase64 nor sourceFileId", async () => {
    const res = await driveUpload({ ...ctxBase, drive: PERSONAL }, { name: "r.pdf" })
    expect("error" in res && res.error.code).toBe("invalid_params")
    expect("error" in res && res.error.message).toMatch(/sourceFileId/)
  })

  it("rejects a call carrying BOTH byte sources rather than picking one", async () => {
    const calls = recordingStub(() => {
      throw new Error("should not fetch")
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      {
        name: "r.pdf",
        contentBase64: CONTENT_B64,
        sourceFileId: "11111111-1111-1111-1111-111111111111",
      },
    )
    expect("error" in res && res.error.code).toBe("invalid_params")
    expect(calls).toHaveLength(0)
  })

  it("returns source_not_found (and never calls Drive) for a kernel file the caller cannot see", async () => {
    const calls = recordingStub(() => {
      throw new Error("should not fetch")
    })
    const res = await driveUpload(
      { ...ctxBase, tx: txWith([]), drive: PERSONAL },
      { name: "r.pdf", sourceFileId: "11111111-1111-1111-1111-111111111111" },
    )
    expect("error" in res && res.error.code).toBe("source_not_found")
    // The message must tell the caller how to stage a file, not just that it failed.
    expect("error" in res && res.error.message).toMatch(/upload-url/)
    expect(calls).toHaveLength(0)
  })

  it("refuses an oversized kernel file on its recorded size, before touching object storage", async () => {
    const calls = recordingStub(() => {
      throw new Error("should not fetch")
    })
    const res = await driveUpload(
      {
        ...ctxBase,
        tx: txWith([
          {
            filename: "huge.pdf",
            mimeType: "application/pdf",
            storageKey: "k",
            sizeBytes: UPLOAD_SIZE_CAP_BYTES + 1,
          },
        ]),
        drive: PERSONAL,
      },
      { name: "huge.pdf", sourceFileId: "11111111-1111-1111-1111-111111111111" },
    )
    expect("error" in res && res.error.code).toBe("file_too_large")
    expect(calls).toHaveLength(0)
  })

  it("rejects invalid base64 without calling Drive", async () => {
    const calls = recordingStub(() => {
      throw new Error("should not fetch")
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: "not*base64!" },
    )
    expect("error" in res && res.error.code).toBe("invalid_params")
    expect(calls).toHaveLength(0)
  })

  it("refuses a payload above the 5 MB decoded cap with an explicit error, before any network call", async () => {
    const calls = recordingStub(() => {
      throw new Error("should not fetch")
    })
    const big = Buffer.alloc(UPLOAD_SIZE_CAP_BYTES + 3).toString("base64")
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "big.pptx", contentBase64: big },
    )
    expect("error" in res && res.error.code).toBe("file_too_large")
    expect("error" in res && res.error.message).toMatch(/5 MB/)
    expect(calls).toHaveLength(0)
  })

  it("creates the app-owned 'Liaison Reports' folder on first upload and sends a well-formed multipart files.create", async () => {
    const calls = recordingStub((url, init) => {
      if (url.includes("uploadType=multipart")) {
        return new Response(
          JSON.stringify({ id: "up1", webViewLink: "https://drive.google.com/file/d/up1/view" }),
          { status: 200 },
        )
      }
      if (init?.method === "POST") {
        // metadata-only folder create
        return new Response(JSON.stringify({ id: "fold1" }), { status: 200 })
      }
      // folder lookup: none yet
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      {
        name: "2023.08_PdH - Monthly review.pptx",
        mimeType: PPTX_MIME,
        contentBase64: CONTENT_B64,
      },
    )
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.fileId).toBe("up1")
    expect(res.webViewLink).toContain("drive.google.com")
    expect(res.folderId).toBe("fold1")

    // call 1: lookup, call 2: folder create, call 3: multipart upload
    expect(calls).toHaveLength(3)
    const lookupQ = decodeURIComponent(calls[0].url).replace(/\+/g, " ")
    // the lookup MUST NOT filter on the folder name: a folder an older version
    // of the app created under a different display name must still be found
    expect(lookupQ).not.toContain("name = '")
    // it filters on the app tag instead — the token also carries
    // drive.readonly, so a bare name match could be a user's own folder
    expect(lookupQ).toContain("appProperties has { key='liaisonReports' and value='1' }")
    const folderBody = JSON.parse(String(calls[1].init?.body))
    expect(folderBody).toMatchObject({
      name: "Liaison Reports",
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { liaisonReports: "1" },
    })
    const upload = calls[2]
    expect(upload.url).toContain("uploadType=multipart")
    const contentType =
      new Headers(upload.init?.headers as ConstructorParameters<typeof Headers>[0]).get(
        "content-type",
      ) ?? ""
    expect(contentType).toMatch(/^multipart\/related; boundary=/)
    const boundary = contentType.split("boundary=")[1]
    const raw = Buffer.from(upload.init?.body as Buffer)
    const text = raw.toString("latin1")
    // part 1: JSON metadata with the app-owned folder as parent
    expect(text).toContain(`--${boundary}\r\nContent-Type: application/json`)
    const metaJson = JSON.parse(text.split("\r\n\r\n")[1].split(`\r\n--${boundary}`)[0])
    expect(metaJson).toEqual({
      name: "2023.08_PdH - Monthly review.pptx",
      mimeType: PPTX_MIME,
      parents: ["fold1"],
    })
    // part 2: the DECODED bytes, verbatim
    expect(raw.includes(CONTENT)).toBe(true)
    // closing delimiter
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })

  it("reuses the existing app-owned folder (no second create)", async () => {
    const calls = recordingStub((url) => {
      if (url.includes("uploadType=multipart")) {
        return new Response(JSON.stringify({ id: "up2" }), { status: 200 })
      }
      return new Response(JSON.stringify({ files: [{ id: "fexist", name: "Liaison Reports" }] }), {
        status: 200,
      })
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    if ("error" in res) throw new Error("unexpected error")
    expect(res.folderId).toBe("fexist")
    // lookup + upload only — no folder create call
    expect(calls).toHaveLength(2)
    const metaJson = String(
      calls[1].init?.body && Buffer.from(calls[1].init.body as Buffer).toString("latin1"),
    )
    expect(metaJson).toContain('"parents":["fexist"]')
  })

  it("ignores a same-named USER folder (no app tag) — the tagged lookup misses, a fresh tagged folder is created", async () => {
    // Simulate real Drive semantics: the user has their own 'Liaison Reports'
    // folder, which only matches a query WITHOUT the appProperties filter.
    const calls = recordingStub((url, init) => {
      if (url.includes("uploadType=multipart")) {
        return new Response(JSON.stringify({ id: "up3" }), { status: 200 })
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "fresh-tagged" }), { status: 200 })
      }
      const q = decodeURIComponent(url).replace(/\+/g, " ")
      const files = q.includes("appProperties has")
        ? [] // the user's folder carries no app tag
        : [{ id: "user-folder", name: "Liaison Reports" }]
      return new Response(JSON.stringify({ files }), { status: 200 })
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.folderId).toBe("fresh-tagged")
    expect(calls).toHaveLength(3) // lookup + tagged create + upload
  })

  it("recreates the folder and retries ONCE when files.create rejects the parent with 404", async () => {
    let uploadAttempts = 0
    const calls = recordingStub((url, init) => {
      if (url.includes("uploadType=multipart")) {
        uploadAttempts += 1
        if (uploadAttempts === 1) {
          // stale parent (deleted since lookup, or a foreign id)
          return new Response(
            '{"error":{"errors":[{"reason":"notFound","message":"File not found: stale"}]}}',
            { status: 404 },
          )
        }
        return new Response(JSON.stringify({ id: "up-retry" }), { status: 200 })
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "fnew" }), { status: 200 })
      }
      return new Response(JSON.stringify({ files: [{ id: "fstale", name: "Liaison Reports" }] }), {
        status: 200,
      })
    })
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.fileId).toBe("up-retry")
    expect(res.folderId).toBe("fnew")
    expect(uploadAttempts).toBe(2)
    // lookup + failed upload + folder recreate + retried upload
    expect(calls).toHaveLength(4)
  })

  it("returns drive_scope_missing verbatim on a Drive 403 (connection consented before drive.file)", async () => {
    recordingStub(() => new Response('{"error":{"message":"insufficient scope"}}', { status: 403 }))
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("drive_scope_missing")
    expect("error" in res && res.error.message).toMatch(/drive\.file/)
  })

  it("maps 403 reason insufficientScopes to drive_scope_missing", async () => {
    recordingStub(
      () =>
        new Response(
          '{"error":{"errors":[{"reason":"insufficientScopes","message":"Insufficient Permission"}]}}',
          { status: 403 },
        ),
    )
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("drive_scope_missing")
  })

  it("maps 403 reason storageQuotaExceeded to drive_storage_full (NOT a reconnect ask)", async () => {
    recordingStub(
      () =>
        new Response(
          '{"error":{"errors":[{"reason":"storageQuotaExceeded","message":"The user\'s Drive storage quota has been exceeded."}]}}',
          { status: 403 },
        ),
    )
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("drive_storage_full")
    expect("error" in res && res.error.message).not.toMatch(/reconnect Google Drive/)
  })

  it("maps 403 reason userRateLimitExceeded to drive_rate_limited", async () => {
    recordingStub(
      () =>
        new Response(
          '{"error":{"errors":[{"reason":"userRateLimitExceeded","message":"User rate limit exceeded"}]}}',
          { status: 403 },
        ),
    )
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("drive_rate_limited")
  })

  it("maps any other 403 reason to drive_permission_denied carrying the reason verbatim", async () => {
    recordingStub(
      () =>
        new Response(
          '{"error":{"errors":[{"reason":"insufficientFilePermissions","message":"The user does not have sufficient permissions"}]}}',
          { status: 403 },
        ),
    )
    const res = await driveUpload(
      { ...ctxBase, drive: PERSONAL },
      { name: "r.pptx", contentBase64: CONTENT_B64 },
    )
    expect("error" in res && res.error.code).toBe("drive_permission_denied")
    expect("error" in res && res.error.message).toContain("insufficientFilePermissions")
  })
})

describe("driveImport", () => {
  it("returns not_connected without a Drive token", async () => {
    const res = await driveImport({ ...ctxBase, drive: null }, { driveFileId: "d1" })
    expect("error" in res && res.error.code).toBe("not_connected")
  })

  it("rejects a missing driveFileId", async () => {
    const res = await driveImport({ ...ctxBase, drive: PERSONAL }, { driveFileId: "" })
    expect("error" in res && res.error.code).toBe("invalid_params")
  })

  it("rejects a native Google Doc with an export hint", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "d2",
            name: "Notes",
            mimeType: "application/vnd.google-apps.document",
          }),
          { status: 200 },
        ),
    )
    const res = await driveImport({ ...ctxBase, drive: PERSONAL }, { driveFileId: "d2" })
    expect("error" in res && res.error.code).toBe("not_downloadable")
  })

  it("rejects an executable Drive file via the denylist", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "d3", name: "payload.exe", mimeType: "application/x-msdownload" }),
          { status: 200 },
        ),
    )
    const res = await driveImport({ ...ctxBase, drive: PERSONAL }, { driveFileId: "d3" })
    expect("error" in res && res.error.code).toBe("unsafe_file_type")
  })

  // I-TEST-1: Drive import quota boundary — not unit-tested at this layer.
  //
  // driveImport's quota and per-file-size guards (DriveImportError with
  // "storage_quota_exceeded" / "file_too_large") fire inside withPrivilegedDb,
  // after a successful Drive download, against loadOrgSettings and
  // currentOrgUsageBytes. Neither dependency is injectable from this test
  // context (the module exposes no DB seam, and the codes are an unexported,
  // inline union on the private DriveImportError class — there is no constant to
  // assert against). Stubbing the whole withPrivilegedDb call would require a
  // top-level Bun module mock that is not composable with the function-level
  // stubFetch pattern these tests use.
  //
  // The quota/size guards are exercised against a real DB at the service layer
  // (files service.test.ts: "throws STORAGE_QUOTA_EXCEEDED" / "throws
  // FILE_TOO_LARGE"). The earlier placeholder tests here asserted local string
  // literals against themselves (tautologies that exercised no production code)
  // and were removed — they provided false confidence, not regression cover.

  it("returns unsafe_file_type for a PDF renamed to exe (denylist hits on extension)", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "d-bad", name: "report.exe", mimeType: "application/pdf" }),
          { status: 200 },
        ),
    )
    // isBlockedFileType checks the filename extension, not only the mimeType,
    // so a PDF that is renamed .exe is correctly blocked.
    const res = await driveImport({ ...ctxBase, drive: PERSONAL }, { driveFileId: "d-bad" })
    expect("error" in res && res.error.code).toBe("unsafe_file_type")
  })
})

describe("driveSearch in picked mode", () => {
  const GOWIN = { id: "gowin-xlsx-1", name: "Gowin Sample Request Form.xlsx", mimeType: XLSX_MIME }
  const picked = { items: [GOWIN] }

  it("lists the picked files whatever words the agent tried", async () => {
    const calls = recordingStub(async () => new Response(JSON.stringify({ files: [] })))
    const res = await driveSearch({ ...ctxBase, drive: PERSONAL, picked }, { query: "CV" })
    if ("error" in res) throw new Error(res.error.message)
    expect(res.mode).toBe("picked")
    expect(res.files).toEqual([])
    expect(res.pickedFiles).toEqual([
      { driveFileId: GOWIN.id, name: GOWIN.name, mimeType: XLSX_MIME },
    ])
    expect(res.hint).toBe(DRIVE_PICKED_HINT)
    // Drive's own search still runs: a picked folder's files are found through it.
    expect(calls).toHaveLength(1)
  })

  it("matches a picked file by a word of its name, and an empty query lists them all", async () => {
    stubFetch(async () => new Response(JSON.stringify({ files: [] })))
    const named = await driveSearch(
      { ...ctxBase, drive: PERSONAL, picked },
      { query: "sample request" },
    )
    if ("error" in named) throw new Error(named.error.message)
    expect(named.files.map((f) => f.driveFileId)).toEqual([GOWIN.id])

    const calls = recordingStub(async () => new Response(JSON.stringify({ files: [] })))
    const all = await driveSearch({ ...ctxBase, drive: PERSONAL, picked }, { query: " " })
    if ("error" in all) throw new Error(all.error.message)
    expect(all.files.map((f) => f.driveFileId)).toEqual([GOWIN.id])
    expect(all.pickedFiles).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it("keeps the picked list when Drive's own search fails, and says it failed", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }))
    const res = await driveSearch({ ...ctxBase, drive: PERSONAL, picked }, { query: "gowin" })
    if ("error" in res) throw new Error(res.error.message)
    expect(res.files.map((f) => f.driveFileId)).toEqual([GOWIN.id])
    expect(res.hint).toContain("Drive's own search failed")
  })

  it("says nothing is picked yet when the list is empty", async () => {
    stubFetch(async () => new Response(JSON.stringify({ files: [] })))
    const res = await driveSearch(
      { ...ctxBase, drive: PERSONAL, picked: { items: [] } },
      { query: "budget" },
    )
    if ("error" in res) throw new Error(res.error.message)
    expect(res.hint).toBe(DRIVE_PICKED_NONE_HINT)
  })
})

describe("driveRead", () => {
  it("reads an Excel workbook as CSV, sheet by sheet", async () => {
    const bytes = workbookBytes([
      {
        name: "Request",
        rows: [
          ["Field", "Value"],
          ["Part", "GW1N-9"],
        ],
      },
    ])
    stubFetch(async (url) => {
      if (url.includes("alt=media")) return new Response(bytes, { status: 200 })
      return new Response(
        JSON.stringify({
          id: "gowin-xlsx-1",
          name: "Gowin Sample Request Form.xlsx",
          mimeType: XLSX_MIME,
          capabilities: { canDownload: true },
        }),
        { status: 200 },
      )
    })
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "gowin-xlsx-1" })
    if ("error" in res) throw new Error(`unexpected error: ${res.error.message}`)
    expect(res.contentMimeType).toBe("text/csv")
    expect(res.content).toBe("Sheet: Request\nField,Value\nPart,GW1N-9")
  })

  it("returns not_connected without a Drive token", async () => {
    const res = await driveRead({ ...ctxBase, drive: null }, { driveFileId: "d1" })
    expect("error" in res && res.error.code).toBe("not_connected")
  })

  it("rejects a missing driveFileId", async () => {
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "" })
    expect("error" in res && res.error.code).toBe("invalid_params")
  })

  it("exports a native Google Sheet as CSV content (rows the agent can parse)", async () => {
    const csv =
      "Shop,Email\nNorthwind Audio,buyer@northwind.example\nCascade Synth,hi@cascade.example\n"
    stubFetch(async (url) => {
      if (url.includes("/export")) {
        // The export call must request text/csv for a spreadsheet.
        expect(url).toContain("mimeType=text%2Fcsv")
        return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } })
      }
      // metadata call
      return new Response(
        JSON.stringify({
          id: "sheet-1",
          name: "Dealer Prospects 2026",
          mimeType: "application/vnd.google-apps.spreadsheet",
          capabilities: { canDownload: true },
        }),
        { status: 200 },
      )
    })
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "sheet-1" })
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.contentMimeType).toBe("text/csv")
    expect(res.content).toContain("Northwind Audio,buyer@northwind.example")
    expect(res.content).toContain("Cascade Synth,hi@cascade.example")
    expect(res.name).toBe("Dealer Prospects 2026")
  })

  it("exports a native Google Doc as plain text", async () => {
    stubFetch(async (url) => {
      if (url.includes("/export")) {
        expect(url).toContain("mimeType=text%2Fplain")
        return new Response("Hello body", { status: 200 })
      }
      return new Response(
        JSON.stringify({
          id: "doc-1",
          name: "Notes",
          mimeType: "application/vnd.google-apps.document",
        }),
        { status: 200 },
      )
    })
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "doc-1" })
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.content).toBe("Hello body")
    expect(res.contentMimeType).toBe("text/plain")
  })

  it("rejects a binary file (PDF) as not_readable_as_text", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "pdf-1", name: "Manual.pdf", mimeType: "application/pdf" }),
          { status: 200 },
        ),
    )
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "pdf-1" })
    expect("error" in res && res.error.code).toBe("not_readable_as_text")
  })

  it("downloads a plain-text file's content", async () => {
    stubFetch(async (url) => {
      if (url.includes("alt=media")) {
        return new Response("line1\nline2", { status: 200 })
      }
      return new Response(
        JSON.stringify({
          id: "txt-1",
          name: "notes.txt",
          mimeType: "text/plain",
          capabilities: { canDownload: true },
        }),
        { status: 200 },
      )
    })
    const res = await driveRead({ ...ctxBase, drive: PERSONAL }, { driveFileId: "txt-1" })
    if ("error" in res) throw new Error(`unexpected error: ${res.error.code}`)
    expect(res.content).toBe("line1\nline2")
  })
})

describe("driveExport", () => {
  const accountRows = [
    {
      id: "a1",
      connection_name: "drive",
      identifier: "user@example.com",
      display_name: "User",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
    },
  ]

  it("serializes connected accounts as JSON rows", async () => {
    const ctx = {
      tx: { execute: async () => accountRows } as never,
      orgId: "o",
      userId: "u",
      drive: null,
    }
    const res = (await driveExport(ctx, { format: "json" })) as Array<Record<string, string>>
    expect(res[0]).toMatchObject({
      id: "a1",
      connectionName: "drive",
      identifier: "user@example.com",
    })
  })

  it("serializes connected accounts as CSV", async () => {
    const ctx = {
      tx: { execute: async () => accountRows } as never,
      orgId: "o",
      userId: "u",
      drive: null,
    }
    const res = (await driveExport(ctx, { format: "csv" })) as string
    expect(res).toContain("id,connectionName,identifier")
    expect(res).toContain("a1,drive,user@example.com")
  })
})
