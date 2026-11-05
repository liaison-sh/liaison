// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared by the desktop and phone chat-media scenarios: a real picture to
// attach (a 1x1 PNG proves nothing about a preview's size or crop) and a
// conversation whose messages carry person mentions mid-sentence.
import { deflateSync } from "node:zlib"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect } from "../fixtures/test"

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A deterministic landscape picture: a sky-to-sea gradient with a sun, so a
 *  crop, a stretch or a blank tile is obvious in a screenshot. */
export function scenePng(width = 480, height = 320): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const sunX = width * 0.7
  const sunY = height * 0.35
  const sunR = Math.min(width, height) * 0.14
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    const horizon = y > height * 0.62
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3
      const inSun = (x - sunX) ** 2 + (y - sunY) ** 2 < sunR ** 2
      const t = y / height
      const [r, g, b] = inSun
        ? [250, 204, 21]
        : horizon
          ? [20, Math.round(90 + 60 * t), Math.round(140 + 60 * t)]
          : [Math.round(90 + 120 * t), Math.round(140 + 60 * t), 230]
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  })
  await page.waitForTimeout(ms)
}

/** A group conversation where people mention each other mid-sentence, the
 *  shape of the message that broke on the iPhone. Returns the thread id. */
export async function seedMentionThread(
  env: WorkerEnv,
  qa: {
    admin: { id: string; token: string }
    amina: { id: string; token: string }
    lucas: { id: string; token: string }
  },
): Promise<string> {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: "Project access",
      participantIds: [qa.amina.id, qa.lucas.id, qa.admin.id],
      initialMessage: { content: "Can everyone see the Projects tab now?" },
    },
  })
  expect(created.status).toBe(200)
  const threadId = created.body.data.id as string
  const send = async (token: string, content: string) => {
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token,
      body: { content },
    })
    expect(res.status).toBe(200)
  }
  await send(
    qa.amina.token,
    `I still don't see projects in the menu. @[Lucas Pereira](user:${qa.lucas.id}) my agent does have access to the project, I just can't reach the interface.`,
  )
  await send(
    qa.lucas.token,
    `Refresh the page to pick up the new menu @[Amina Cherif](user:${qa.amina.id})`,
  )
  return threadId
}
