// SPDX-License-Identifier: FSL-1.1-ALv2
// A refusal names itself (`details.reason`), so a client can say it in its
// reader's language; the English message stays for every other client.
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { FolderScopeError } from "./collections"
import { zeroKnowledgeResponse } from "./routes"
import { KnowledgeError } from "./service"

function respond(err: unknown) {
  const app = new Hono()
  app.get("/", (c) => zeroKnowledgeResponse(c as never, err))
  return app.request("/")
}

describe("knowledge refusals", () => {
  it("carry their reason when they have one", async () => {
    const res = await respond(
      new KnowledgeError("VALIDATION", "This folder is synced.", "synced_folder"),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        message: "This folder is synced.",
        code: "VALIDATION",
        details: { reason: "synced_folder" },
      },
    })
  })

  it("leave it out when they have none, and never name a hidden row", async () => {
    const plain = await respond(new KnowledgeError("VALIDATION", "Bad input"))
    expect(await plain.json()).toEqual({ error: { message: "Bad input", code: "VALIDATION" } })
    // A forbidden row is a not found, reason or not.
    const hidden = await respond(new KnowledgeError("FORBIDDEN", "Forbidden", "anything"))
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({
      error: { message: "Knowledge item not found", code: "NOT_FOUND" },
    })
  })

  it("lacking the folder scope is named folder_scope", () => {
    expect(new FolderScopeError().reason).toBe("folder_scope")
  })
})
