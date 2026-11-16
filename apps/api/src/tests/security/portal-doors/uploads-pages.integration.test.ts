// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of an uploaded document's page pictures on the public page, through
// the real app. A page is reached only by its number inside the action the
// token names: a number past the end and a page only another action has give
// the one not-found answer, and pictures have their own hourly budget per link.
// Nothing the page answers may be kept by a cache, and no URL carries a token.

import { beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { putObject } from "~/infra/storage/object-storage"
import { clientActionPublicRoutes } from "~/modules/client-actions/public-routes"
import {
  ClientActionTargetsTestAccess,
  type ClientActionView,
} from "~/modules/client-actions/targets"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  BASE,
  call,
  k,
  mintTo,
  nextIp,
  useClientActionWorld,
} from "../../../../test-support/client-actions-kit"

const kit = useClientActionWorld("uploadpages")
/** Each action's own pages, by its target id; others answer the kit's view. */
const viewsByTarget = new Map<string, ClientActionView>()

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

async function storedPicture(): Promise<string> {
  const id = crypto.randomUUID()
  const key = `${kit.w.orgId}/client-action-tests/${id}`
  await putObject({ key, body: WEBP, contentType: "image/webp" })
  await sql.unsafe(
    insertSql("kernel.files", {
      id,
      org_id: kit.w.orgId,
      app: "kernel",
      entity_type: "test",
      entity_id: id,
      filename: "page.webp",
      mime_type: "image/webp",
      size_bytes: WEBP.byteLength,
      storage_key: key,
      enc_version: 0,
    }),
  )
  return id
}

function pagesView(pictures: string[]): ClientActionView {
  return {
    ...kit.view,
    sourceBlocks: null,
    pages: pictures.map((pictureFileId, i) => ({
      n: i + 1,
      pictureFileId,
      sha256: String(i).repeat(64),
      text: `Page ${i + 1}`,
    })),
    pagesSha256: "f".repeat(64),
  }
}

/** An action whose document has these page pictures. */
async function actionWithPages(count: number) {
  const pictures: string[] = []
  for (let i = 0; i < count; i++) pictures.push(await storedPicture())
  const targetId = crypto.randomUUID()
  viewsByTarget.set(targetId, pagesView(pictures))
  const minted = await mintTo(kit, kit.w.clientA, { targetId })
  return { ...minted, pictures }
}

const page = (token: string, n: number, ip = nextIp()) =>
  call("document", { t: token, format: "page", n }, { "x-bun-socket-ip": ip })

beforeAll(() => {
  // Registered after the kit's own target: each action reads its own pages.
  ClientActionTargetsTestAccess.set("uploadpages", "contract", ["sign", "accept"], async (req) =>
    kit.viewAnswers ? (viewsByTarget.get(req.targetId) ?? kit.view) : null,
  )
})

describe("page pictures of an uploaded document on the public page", () => {
  it("NT-64: a page past the end and a page only another action has give the one not-found answer", async () => {
    const mine = await actionWithPages(1)
    const theirs = await actionWithPages(3)
    // The other action's third page is there for its own link.
    const own = await page(theirs.token, 3)
    expect(own.status).toBe(200)

    const pastEnd = await page(mine.token, 99)
    const otherPage = await page(mine.token, 3)
    expect(pastEnd.status).toBe(404)
    expect(otherPage.status).toBe(404)
    const a = await pastEnd.text()
    const b = await otherPage.text()
    expect(b).toBe(a)
    expect(a).not.toContain(theirs.pictures[2] as string)
    // The picture's file id is never a way in: it is not a page number.
    const byId = await call(
      "document",
      { t: mine.token, format: "page", n: theirs.pictures[2] },
      { "x-bun-socket-ip": nextIp() },
    )
    expect(byId.status).toBe(400)
  })

  it("NT-64: the 1001st page picture of a link in the hour is refused, and the link's other reads keep their own budget", async () => {
    const { token } = await actionWithPages(1)
    // Each request comes from its own address, so only the link's page budget counts.
    const statuses: number[] = []
    for (let start = 0; start < 1000; start += 50) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(50, 1000 - start) }, () => page(token, 1)),
      )
      for (const res of batch) {
        statuses.push(res.status)
        await res.arrayBuffer()
      }
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(0)
    expect(statuses.every((s) => s === 200)).toBe(true)
    const over = await page(token, 1)
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: { code: "rate_limited" } })
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0)
    // The page list is not a picture: it is still answered.
    const list = await call(
      "document",
      { t: token, format: "pages" },
      { "x-bun-socket-ip": nextIp() },
    )
    expect(list.status).toBe(200)
  }, 180_000)

  it("NT-65: no answer of the page is cacheable, and a picture is image/webp that is never sniffed", async () => {
    const { id, token } = await actionWithPages(2)
    const ip = nextIp()
    const answers: Response[] = []
    for (const format of ["blocks", "text", "pages"]) {
      answers.push(await call("document", { t: token, format }, { "x-bun-socket-ip": ip }))
    }
    const picture = await page(token, 1, ip)
    expect(picture.status).toBe(200)
    expect(picture.headers.get("content-type")).toBe("image/webp")
    expect(picture.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await picture.clone().arrayBuffer())).toEqual(WEBP)
    answers.push(picture)
    answers.push(await page(token, 9, ip))
    answers.push(await call("open", { t: token }, { "x-bun-socket-ip": ip }))
    answers.push(await call("document", { t: "x".repeat(43), format: "page", n: 1 }))
    await sql`UPDATE ${k("client_actions")} SET revoked_at = now(), revoke_reason = 'withdrawn' WHERE id = ${id}`
    answers.push(await page(token, 1, nextIp()))
    for (const res of answers) {
      expect(res.headers.get("cache-control")).toBe("no-store")
      await res.arrayBuffer()
    }
  })

  it("NT-65: no route of the page holds a token in its path, and a token in a URL is not read", async () => {
    for (const route of clientActionPublicRoutes.routes) {
      expect(route.path).not.toMatch(/:[A-Za-z_]+/)
      expect(route.method === "POST" || route.method === "ALL").toBe(true)
    }
    const { token } = await actionWithPages(1)
    const inQuery = await app.request(
      `${BASE}/document?t=${encodeURIComponent(token)}&format=page&n=1`,
      { headers: { "x-bun-socket-ip": nextIp() } },
    )
    expect(inQuery.status).not.toBe(200)
    expect(inQuery.headers.get("content-type") ?? "").not.toContain("image/webp")
    const inPath = await app.request(`${BASE}/document/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bun-socket-ip": nextIp() },
      body: JSON.stringify({ format: "page", n: 1 }),
    })
    expect(inPath.status).not.toBe(200)
  })
})
