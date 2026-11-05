// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node answers session import requests (S40, S42): it pulls the request,
// runs it through the shell's one-shot import sidecar (`node_import`), and
// puts the answer back; a refusal travels as its code, never a message.
import { describe, expect, it, vi } from "vitest"
import { createImportRequests } from "./import-requests"

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const SDK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

const LISTING = {
  rows: [
    {
      sdkSessionId: SDK,
      folderName: "code",
      cwdSubdir: "app",
      title: "Fix the login",
      firstPrompt: "fix it",
      branch: "main",
      lastModified: "2026-10-16T10:00:00.000Z",
      createdAt: null,
      sizeBytes: 1200,
      from: "vscode",
      liveNow: false,
    },
  ],
  truncated: false,
}

function harness(
  pulled: { op: unknown; claim: string } | null,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async () =>
    LISTING,
) {
  const get = vi.fn(async (_id: string) => pulled)
  const put = vi.fn(async (_id: string, _claim: string, _result: unknown) => {})
  const shell = vi.fn(invoke)
  const handle = createImportRequests({ http: { get, put }, invoke: shell })
  return { get, put, shell, handle }
}

describe("the node's answer to an import request (S40, S42)", () => {
  it("S40: an import request is pulled, run through node_import and answered; a pull that lost the claim answers nothing", async () => {
    const h = harness({ op: { kind: "list" }, claim: "claim-1" })
    await h.handle(ID)
    expect(h.get).toHaveBeenCalledWith(ID)
    expect(h.shell).toHaveBeenCalledWith("node_import", { op: { kind: "list" } })
    expect(h.put).toHaveBeenCalledWith(ID, "claim-1", { ok: true, data: LISTING })

    const lost = harness(null)
    await lost.handle(ID)
    expect(lost.shell).not.toHaveBeenCalled()
    expect(lost.put).not.toHaveBeenCalled()
  })

  it("S42: a check op goes to the shell as pulled, and the shell's refusal code is the answer", async () => {
    const op = { kind: "check", sdkSessionId: SDK, folderName: "code", cwdSubdir: "app" }
    const h = harness({ op, claim: "claim-2" }, async () => {
      throw "FOLDER_NOT_SHARED"
    })
    await h.handle(ID)
    expect(h.shell).toHaveBeenCalledWith("node_import", { op })
    expect(h.put).toHaveBeenCalledWith(ID, "claim-2", { ok: false, code: "FOLDER_NOT_SHARED" })
  })

  it("S42: an op the shared schema refuses never reaches the shell and is answered failed", async () => {
    const h = harness({
      op: { kind: "check", sdkSessionId: "../x", folderName: "code" },
      claim: "c",
    })
    await h.handle(ID)
    expect(h.shell).not.toHaveBeenCalled()
    expect(h.put).toHaveBeenCalledWith(ID, "c", { ok: false, code: "failed" })
  })

  it("S42: an error that is not a code (a message, an object) is answered failed, never passed on", async () => {
    const h = harness({ op: { kind: "list" }, claim: "c" }, async () => {
      throw new Error("ENOENT: /Users/owner/.claude/projects/x.jsonl")
    })
    await h.handle(ID)
    expect(h.put).toHaveBeenCalledWith(ID, "c", { ok: false, code: "failed" })
  })

  it("a request id that is not a uuid is not pulled", async () => {
    const h = harness({ op: { kind: "list" }, claim: "c" })
    await h.handle("x/../y")
    expect(h.get).not.toHaveBeenCalled()
    expect(h.put).not.toHaveBeenCalled()
  })
})
