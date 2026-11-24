// SPDX-License-Identifier: FSL-1.1-ALv2
// The import's pure parts: a file refused before any upload, a server refusal
// read as a reason, every loss sorted into a group a person reads, nothing
// counted that is not also said, and the run a reopened tab picks up again.
import { describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { ImportRun } from "~/modules/imports/import-run-store"
import {
  classifyLoss,
  missingFileItem,
  pickResumableRun,
  precheckFile,
  previewRefusal,
  refusalOfError,
  summarizeLosses,
} from "./notion-import"

const file = (name: string, bytes: number[]) => new File([new Uint8Array(bytes)], name)
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0, 0]

describe("a file refused before any upload", () => {
  it("a zip passes; a PDF, a web page and anything else are named", async () => {
    expect(await precheckFile(file("Export.zip", ZIP))).toBeNull()
    expect(await precheckFile(file("Export.pdf", [0x25, 0x50, 0x44, 0x46]))).toBe("pdf")
    expect(await precheckFile(file("Export.html", [0x3c, 0x21]))).toBe("html")
    expect(await precheckFile(file("notes.txt", [0x41]))).toBe("notZip")
    // A zip by name that is not one inside.
    expect(await precheckFile(file("Export.zip", [0x25, 0x50, 0x44, 0x46]))).toBe("notZip")
  })
})

describe("a server refusal read as a reason", () => {
  const refused = (reason?: string, code = "invalid_source", status = 400) =>
    new ApiError("English", status, code, undefined, reason ? { reason } : undefined)

  it("maps the parser's word", () => {
    expect(refusalOfError(refused("zip_encrypted"))).toBe("encrypted")
    expect(refusalOfError(refused("zip_ratio_exceeded"))).toBe("zipBomb")
    expect(refusalOfError(refused("zip_decompressed_too_large"))).toBe("zipBomb")
    expect(refusalOfError(refused("zip_nested_too_deep"))).toBe("nestedTooDeep")
    expect(refusalOfError(refused("upload_too_large"))).toBe("tooLarge")
    expect(refusalOfError(refused("invalid_zip"))).toBe("notZip")
    expect(refusalOfError(refused(undefined, "forbidden", 403))).toBe("forbidden")
    expect(refusalOfError(refused())).toBe("other")
  })

  it("a preview with nothing to create says why: an HTML export, or no pages at all", () => {
    const none = { "knowledge.document": { created: 0, skipped: 0, failed: 0 } }
    expect(previewRefusal(none, { markdown: 0, csv: 0, html: 12, other: 3 })).toBe("htmlExport")
    expect(previewRefusal(none, { markdown: 0, csv: 0, html: 0, other: 3 })).toBe("noPages")
    const some = { "knowledge.document": { created: 2, skipped: 0, failed: 0 } }
    expect(previewRefusal(some, { markdown: 2, csv: 0, html: 0, other: 0 })).toBeNull()
    // Everything already there is not a refusal: the preview names each one.
    const again = { "knowledge.document": { created: 0, skipped: 4, failed: 0 } }
    expect(previewRefusal(again, { markdown: 4, csv: 0, html: 0, other: 0 })).toBeNull()
  })
})

describe("every loss in a group", () => {
  it("sorts the transform's and the import's words", () => {
    const w = "Onboarding"
    expect(classifyLoss({ what: "web image (https://x.example/a.png)", where: w })).toEqual({
      group: "webImage",
      where: w,
      detail: "https://x.example/a.png",
    })
    expect(classifyLoss({ what: "embed (https://v.example/1)", where: w }).group).toBe("embed")
    expect(classifyLoss({ what: "embed", where: w }).group).toBe("embed")
    expect(classifyLoss({ what: "unknown block <svg>", where: w }).detail).toBe("svg")
    expect(classifyLoss({ what: "link to a page not in the export (Old)", where: w })).toEqual({
      group: "deadLink",
      where: w,
      detail: "Old",
    })
    expect(classifyLoss({ what: "file missing from the export (a/b.pdf)", where: w }).group).toBe(
      "fileMissing",
    )
    expect(classifyLoss({ what: "file not carried (plan.pdf): boom", where: w })).toEqual({
      group: "fileNotCarried",
      where: w,
      detail: "plan.pdf",
    })
    expect(classifyLoss({ what: "relation column kept as text (Owner)", where: w }).group).toBe(
      "relationColumn",
    )
    expect(
      classifyLoss({ what: "5 rows past the first 200 are not in the table", where: w }),
    ).toEqual({ group: "rowsPast", where: w, params: { count: 5, max: 200 } })
    expect(
      classifyLoss({ what: "the database's rows are not in the export", where: w }).group,
    ).toBe("databaseRows")
    expect(classifyLoss({ what: "already imported", where: w }).group).toBe("alreadyImported")
    expect(classifyLoss({ what: "in Trash", where: w }).group).toBe("inTrash")
    expect(classifyLoss({ what: "already imported, deleted since", where: w }).group).toBe(
      "importedDeleted",
    )
    expect(classifyLoss({ what: "already imported, you cannot open it", where: w }).group).toBe(
      "importedHidden",
    )
    // Anything new is still shown, as the server said it.
    expect(classifyLoss({ what: "a new kind of loss", where: w })).toEqual({
      group: "other",
      where: w,
      detail: "a new kind of loss",
    })
  })

  it("files the runner did not read", () => {
    expect(
      missingFileItem({ path: "Big.md", reason: "the file is 2 bytes; a file over 1 MB" }),
    ).toEqual({
      group: "pageTooLarge",
      where: "Big.md",
    })
    expect(
      missingFileItem({ path: "a.png", reason: "it would take the org past its storage quota" })
        .group,
    ).toBe("storageFull")
    expect(missingFileItem({ path: "a.png", reason: "no such file in the upload" }).group).toBe(
      "fileMissing",
    )
    expect(missingFileItem({ path: "a.png", reason: "odd" })).toEqual({
      group: "other",
      where: "a.png",
      detail: "odd",
    })
  })
})

describe("nothing counted that is not said", () => {
  it("every item not listed by name is counted in the total", () => {
    const s = summarizeLosses({
      losses: [{ what: "web image (u)", where: "A" }],
      lossesNotListed: 3,
      missingFiles: [{ path: "x.png", reason: "no such file in the upload" }],
      attachmentsMissing: 4,
      errors: [{ at: "B.md", error: "bad" }],
      failed: 2,
    })
    expect(s.listed).toBe(3)
    // 3 losses past the cap, 3 files past the 1 listed, 1 failed record not listed.
    expect(s.notListed).toBe(7)
    expect(s.total).toBe(10)
    expect(s.groups.map((g) => g.group)).toEqual(["webImage", "fileMissing", "failed"])
  })

  it("an empty report is the only one with a total of 0", () => {
    const s = summarizeLosses({
      losses: [],
      lossesNotListed: 0,
      missingFiles: [],
      attachmentsMissing: 0,
      errors: [],
      failed: 0,
    })
    expect(s.total).toBe(0)
  })
})

describe("the run a reopened tab picks up", () => {
  const run = (
    over: Partial<ImportRun> & { startedBy?: string },
  ): ImportRun & { startedBy?: string } => ({
    id: "r1",
    kindSet: ["knowledge.collection", "knowledge.document"],
    sourceLabel: "builtin:notion:u:amina",
    status: "running",
    dryRun: false,
    counts: {},
    errors: [],
    report: {},
    createdAt: "2026-11-25T10:00:00Z",
    finishedAt: null,
    startedBy: "amina",
    ...over,
  })

  it("the person's newest Notion run, unless they put it away", () => {
    const mine = run({ id: "mine" })
    const shared = run({
      id: "shared",
      sourceLabel: "builtin:notion",
      createdAt: "2026-11-24T10:00:00Z",
    })
    const theirs = run({ id: "theirs", startedBy: "lucas", createdAt: "2026-11-26T10:00:00Z" })
    const other = run({ id: "other", sourceLabel: "tickets", createdAt: "2026-11-27T10:00:00Z" })
    expect(pickResumableRun([theirs, other, mine, shared], "amina", null)?.id).toBe("mine")
    expect(pickResumableRun([shared], "amina", null)?.id).toBe("shared")
    expect(pickResumableRun([mine], "amina", "mine")).toBeUndefined()
    expect(pickResumableRun([run({ dryRun: true })], "amina", null)).toBeUndefined()
    // Undone in another tab or browser: the next visit starts a new upload.
    expect(pickResumableRun([run({ status: "undone" })], "amina", null)).toBeUndefined()
  })
})
