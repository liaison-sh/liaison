// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A TOOL'S OWN WORDS TELL THE AGENT TO SAY. A walk caught the agent stating
// things nothing had shown it and writing what nobody asked for, each traced to a
// tool description or result. A false statement starts here far more often than in
// the model, so the words are pinned: each line names the claim it led to.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../../../..")

function tool(manifestPath: string, name: string): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath, "app.manifest.json"), "utf8"))
  return manifest.tools[name].description
}

describe("a tool's description does not hand the agent a false statement", () => {
  test('mail listAccounts: not "no mailbox is connected to the organisation"', () => {
    const text = tool("apps/api/src/apps/mail", "listAccounts")
    expect(text).not.toContain("connected to this org")
    expect(text).toContain("this person can use")
  })

  test('invoicing drafts_create: not "I cannot backdate a document"', () => {
    const text = tool("bundled-apps/invoicing", "drafts_create")
    expect(text).toContain("`issued_at`")
    expect(text).toContain("never say a date cannot be set")
  })

  test('boxtal get_documents: not "a live signed URL"', () => {
    expect(tool("bundled-apps/boxtal", "get_documents")).not.toContain("signed")
  })
})

describe("a tool's description does not invite a write nobody asked for", () => {
  test("boxtal import_label_document: only to attach to a reply", () => {
    const text = tool("bundled-apps/boxtal", "import_label_document")
    expect(text).toContain("only to ATTACH it")
    expect(text).toContain("get_documents is enough")
  })

  test("a contact note with no wording is asked for, and goes in the discussion", () => {
    const kernel = readFileSync(
      join(ROOT, "apps/api/src/modules/agent/tools/kernel-tools.ts"),
      "utf8",
    )
    expect(kernel).toContain("never compose it from what you found")
    expect(tool("apps/api/src/apps/api-connector", "connector_write")).toContain(
      "goes in that contact's discussion",
    )
  })
})
