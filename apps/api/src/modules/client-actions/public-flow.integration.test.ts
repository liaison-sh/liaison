// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public client action flow through the real app: the document before the
// code, the proof before a signature, one decide among parallel ones, every
// document format the page asks for, and an app's read tool that does not
// answer in time.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { putObject } from "~/infra/storage/object-storage"
import {
  actionRow,
  call,
  codeFor,
  eventsOf,
  k,
  mintTo,
  nextIp,
  proofFor,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { VIEW_TOOL_BUDGET_MS } from "./targets"

const kit = useClientActionWorld("flowdocs")

async function storedFile(bytes: Uint8Array, mimeType: string, encVersion = 0): Promise<string> {
  const id = crypto.randomUUID()
  const key = `${kit.w.orgId}/client-action-tests/${id}`
  await putObject({ key, body: bytes, contentType: mimeType })
  await sql`
    INSERT INTO ${k("files")} (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, enc_version)
    VALUES (${id}, ${kit.w.orgId}, 'kernel', 'test', ${id}, 'document.pdf', ${mimeType}, ${bytes.byteLength}, ${key}, ${encVersion})`
  return id
}

describe("client action public flow", () => {
  it("the code is refused until the document was shown", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    await call("open", { t: token }, { "x-bun-socket-ip": ip })
    const early = await call("code", { t: token }, { "x-bun-socket-ip": ip })
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: { code: "DOCUMENT_NOT_SHOWN" } })
    expect((await eventsOf(id)).map((e) => e.event)).not.toContain("code_sent")
    // The text alone is not the document shown.
    const text = await call("document", { t: token, format: "text" }, { "x-bun-socket-ip": ip })
    expect(text.status).toBe(200)
    expect((await call("code", { t: token }, { "x-bun-socket-ip": ip })).status).toBe(409)
    const shown = await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
    expect(shown.status).toBe(200)
    expect((await actionRow(id)).document_shown_at).not.toBeNull()
    expect((await call("code", { t: token }, { "x-bun-socket-ip": ip })).status).toBe(202)
  })

  it("decide with sign refuses without a valid proof and keeps the link open", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const code = await codeFor(kit, token, ip, kit.w.clientA.email)
    for (const proof of [undefined, "not-a-proof-at-all-0123456789", code]) {
      const res = await call(
        "decide",
        { t: token, proof, decision: "sign", typed_name: kit.w.clientA.name },
        { "x-bun-socket-ip": ip },
      )
      expect(res.status).toBe(401)
    }
    const r = await actionRow(id)
    expect(r.decided_at).toBeNull()
    expect(r.decision).toBeNull()
  })

  it("ten parallel decides give one success and nine conflicts", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const proof = await proofFor(kit, token, ip)
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(
          "decide",
          { t: token, proof, decision: "sign", typed_name: kit.w.clientA.name },
          { "x-bun-socket-ip": ip },
        ),
      ),
    )
    const statuses = answers.map((a) => a.status)
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s !== 200).every((s) => s === 409)).toBe(true)
    expect((await eventsOf(id)).filter((e) => e.event === "decided")).toHaveLength(1)
    expect((await actionRow(id)).decision).toBe("signed")
  })

  it("the frozen PDF streams as a download, no-store, and is logged as downloaded, not shown", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n% test document\n%%EOF\n")
    kit.view = { ...kit.view, pdfFileId: await storedFile(pdf, "application/pdf") }
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const res = await call("document", { t: token, format: "pdf" }, { "x-bun-socket-ip": ip })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("content-disposition")).toBe("attachment")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf)
    const events = (await eventsOf(id)).map((e) => e.event)
    expect(events).toContain("document_downloaded")
    expect(events).not.toContain("document_shown")
    expect((await actionRow(id)).document_shown_at).toBeNull()
  })

  it("the page list shows the document with its pages' hash; one page streams its picture", async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])
    const pictureId = await storedFile(webp, "image/webp")
    const pagesSha = "c".repeat(64)
    kit.view = {
      ...kit.view,
      sourceBlocks: null,
      pages: [
        { n: 1, pictureFileId: pictureId, sha256: "d".repeat(64), text: "Page one" },
        { n: 2, pictureFileId: crypto.randomUUID(), sha256: "e".repeat(64), text: null },
      ],
      pagesSha256: pagesSha,
    }
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const list = await call("document", { t: token, format: "pages" }, { "x-bun-socket-ip": ip })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { content: unknown[]; pages_sha256: string }
    expect(body.pages_sha256).toBe(pagesSha)
    expect(body.content).toEqual([
      { n: 1, sha256: "d".repeat(64), text: "Page one" },
      { n: 2, sha256: "e".repeat(64), text: null },
    ])
    // The list holds no file id: a picture is reached only through this action's token.
    expect(JSON.stringify(body)).not.toContain(pictureId)
    const shown = (await eventsOf(id)).find((e) => e.event === "document_shown")
    expect(shown?.meta).toMatchObject({ format: "pages", pages_sha256: pagesSha })
    const page = await call(
      "document",
      { t: token, format: "page", n: 1 },
      { "x-bun-socket-ip": ip },
    )
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toBe("image/webp")
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(webp)
    // A page with no such number is not found; a picture gone from storage answers down.
    const none = await call(
      "document",
      { t: token, format: "page", n: 9 },
      { "x-bun-socket-ip": ip },
    )
    expect(none.status).toBe(404)
    const gone = await call(
      "document",
      { t: token, format: "page", n: 2 },
      { "x-bun-socket-ip": ip },
    )
    expect(gone.status).toBe(503)
    expect(await gone.json()).toEqual({ state: "down" })
  })

  it("a file sealed for a mailbox is never served on the page", async () => {
    kit.view = {
      ...kit.view,
      pdfFileId: await storedFile(new Uint8Array([1, 2, 3]), "application/pdf", 1),
    }
    const { token } = await mintTo(kit)
    const res = await call("document", { t: token, format: "pdf" }, { "x-bun-socket-ip": nextIp() })
    expect(res.status).toBe(503)
  })

  it("a dead link returns no document in any format", async () => {
    const { id, token } = await mintTo(kit)
    await sql`UPDATE ${k("client_actions")} SET revoked_at = now(), revoke_reason = 'withdrawn' WHERE id = ${id}`
    for (const format of ["blocks", "text", "pages", "pdf"]) {
      const res = await call("document", { t: token, format }, { "x-bun-socket-ip": nextIp() })
      expect(res.status).toBe(410)
      const text = await res.text()
      expect(text).not.toContain("Les parties conviennent")
    }
  })

  it("a view tool that sleeps 10 s answers down and holds no lock: a parallel decide on another action completes", async () => {
    const slow = await mintTo(kit)
    const fast = await mintTo(kit)
    const ipFast = nextIp()
    const proof = await proofFor(kit, fast.token, ipFast)
    kit.viewDelayMs = 10_000
    const started = Date.now()
    const slowAnswer = call("open", { t: slow.token }, { "x-bun-socket-ip": nextIp() })
    // While the slow read waits, the other action's decide reads its view at once.
    await new Promise((r) => setTimeout(r, 200))
    kit.viewDelayMs = 0
    const decided = await call(
      "decide",
      { t: fast.token, proof, decision: "sign", typed_name: kit.w.clientA.name },
      { "x-bun-socket-ip": ipFast },
    )
    expect(decided.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(VIEW_TOOL_BUDGET_MS)
    const down = await slowAnswer
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ state: "down" })
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(VIEW_TOOL_BUDGET_MS - 100)
    expect(waited).toBeLessThan(10_000)
    expect((await actionRow(slow.id)).first_opened_at).toBeNull()
  }, 20_000)
})
