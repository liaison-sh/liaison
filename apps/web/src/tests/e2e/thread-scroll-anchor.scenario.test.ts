// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression: a thread whose messages carry inline image previews must stay
// pinned to the newest message when the thread first opens. Image previews,
// 512px thumbnails and cached scrollback previews all resolve asynchronously
// and grow their row heights *after* the virtualizer's initial scroll-to-
// bottom (which runs on skeleton-height estimates). Without a bottom anchor
// the viewport drifts upward — and jitters — as each image pops in. This test
// seeds a thread that overflows the viewport, ends it with real uploaded
// images, reloads (so previews genuinely re-fetch), and asserts the scroll
// container is glued to the bottom once the pictures have laid out.
//
// Storage backend (SeaweedFS) must be running — the images go through the real
// presign + PUT + confirm + thumbnail pipeline.

import zlib from "node:zlib"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

// --- Minimal solid-colour PNG encoder -------------------------------------
// A real image with genuine dimensions is required so the rendered preview is
// meaningfully taller than the loading Skeleton (h-40 = 160px). 1x1 fixtures
// wouldn't exercise the height change the anchor exists to absorb.
function crc32(buf: Buffer): number {
  let crc = ~0
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function makeSquarePng(size: number, rgb: [number, number, number]): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  const rowSize = size * 3 + 1
  const raw = Buffer.alloc(rowSize * size)
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0 // filter type: none
    for (let x = 0; x < size; x++) {
      const o = y * rowSize + 1 + x * 3
      raw[o] = rgb[0]
      raw[o + 1] = rgb[1]
      raw[o + 2] = rgb[2]
    }
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

// Three *distinct* images (different colour + size) so the server's
// content-addressed storage can't dedupe them into a single thumbnail.
const IMAGES: Array<{ name: string; mimeType: "image/png"; buffer: Buffer }> = [
  { name: "chart-a.png", mimeType: "image/png", buffer: makeSquarePng(720, [37, 99, 235]) },
  { name: "chart-b.png", mimeType: "image/png", buffer: makeSquarePng(640, [220, 38, 38]) },
  { name: "chart-c.png", mimeType: "image/png", buffer: makeSquarePng(560, [22, 163, 74]) },
]

interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return page.getByTestId("message-scroll-container").evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))
}

test("[Threads] thread with inline images stays pinned to the bottom on open", async ({
  page,
  env,
  qa,
}) => {
  // 1. A thread with enough messages that the list overflows and virtualizes.
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Scroll anchor ${Date.now()}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "Kicking off the scroll-anchor thread." },
    },
  })
  expect(created.status).toBe(200)
  const threadId = created.body.data.id as string

  for (let i = 0; i < 30; i++) {
    const token = i % 2 === 0 ? qa.amina.token : qa.admin.token
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token,
      body: { content: `Filler message ${i + 1} — keeping the transcript tall.` },
    })
    expect(res.status).toBe(200)
  }

  // 2. Open the thread.
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible({ timeout: 15_000 })
  const scroller = page.getByTestId("message-scroll-container")
  await expect(scroller).toBeVisible({ timeout: 15_000 })

  // 3. Send a message carrying three real inline images and let them decode
  //    naturally. The new-message autoscroll settles the viewport at the bottom.
  await page.getByTestId("composer-plus").first().click()
  await page.getByTestId("attachment-upload-input").first().setInputFiles(IMAGES)
  // Every image staged before the send: each staged chip carries its filename
  // as its title (a tile still uploading has none), and a file still uploading
  // when the message goes out is not guaranteed to travel with it.
  const staged = page.getByTestId("composer-attachment-strip")
  for (const image of IMAGES) {
    await expect(staged.getByTitle(image.name, { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Latest revs attached.")
  await page.getByTestId("compose-send").click()

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Latest revs attached." })
    .first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const imgs = Array.from(
            document.querySelectorAll<HTMLImageElement>(
              'img[data-testid^="attachment-thumbnail-"]',
            ),
          )
          return imgs.length >= 2 && imgs.every((img) => img.complete && img.naturalHeight > 0)
        }),
      { timeout: 25_000 },
    )
    .toBe(true)
  await page.waitForTimeout(500) // settle at the bottom

  // 4. A user scroll away and back: 45px up, then down to the bottom again.
  //    Any user scroll cancels the virtualizer's own scrollToIndex retry, so
  //    from here the ONLY thing that can re-anchor the viewport is the bottom
  //    anchor under test. An upward scroll stops following at once (even
  //    inside the 80px near-bottom band), and reaching the bottom resumes it:
  //    the reader ends where the reported bug bit, following the bottom with
  //    the retry gone.
  const parkedGap = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 45
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
  })
  expect(parkedGap).toBeGreaterThan(20)
  expect(parkedGap).toBeLessThan(80)
  await page.waitForTimeout(100)
  const backAtBottomGap = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
  })
  expect(backAtBottomGap).toBeLessThanOrEqual(1)
  await page.waitForTimeout(100)

  // 5. Grow the already-decoded image rows below the fold. This is a
  //    deterministic stand-in for a late-loading preview / thumbnail / streamed
  //    block — the exact "content grows after layout while following the bottom"
  //    condition. TanStack does NOT compensate for below-viewport growth once
  //    its scrollToIndex retry is cancelled; only the bottom anchor re-pins.
  //    Without the fix the follow-gap blows past the threshold (the viewport
  //    "doesn't stay at the bottom"); with it, it snaps back to ~0.
  await page.addStyleTag({
    content: 'img[data-testid^="attachment-thumbnail-"]{max-height:700px !important}',
  })
  await page.waitForTimeout(600) // ResizeObserver + anchor settle

  // 6. Transcript overflows (so "at the bottom" is a real constraint) and the
  //    viewport is glued back to the newest message.
  const metrics = await readScrollMetrics(page)
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 200)
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  expect(distanceFromBottom).toBeLessThanOrEqual(8)
  await expect(sent.getByTestId("attachment-strip")).toBeInViewport()
})

// Regression (walk 2, desktop): sending a message WITH files made the message
// list vanish for a frame and come back scrolled to the TOP of the history.
// The new message's attachment previews are resources; reading one while it
// loaded suspended the tab's <Suspense> in MainPanel, which pulled the whole
// thread out of the document and put it back, and a scroller re-inserted into
// the document starts at scrollTop 0. The trace below samples the scroller on
// every animation frame from the keypress on: it must be the same node on
// every frame, never missing, and end glued to the bottom with the new message
// in view.
test("[Threads] sending with files keeps the same list pinned to the bottom", async ({
  page,
  env,
  qa,
}) => {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Send with files ${Date.now()}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "History starts here." },
    },
  })
  expect(created.status).toBe(200)
  const threadId = created.body.data.id as string
  for (let i = 0; i < 40; i++) {
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token: i % 2 === 0 ? qa.amina.token : qa.admin.token,
      body: { content: `History line ${i + 1}, long enough to make the channel scroll.` },
    })
    expect(res.status).toBe(200)
  }

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible({ timeout: 15_000 })
  const scroller = page.getByTestId("message-scroll-container")
  await expect(scroller).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => {
      const m = await readScrollMetrics(page)
      return m.scrollHeight - m.scrollTop - m.clientHeight
    })
    .toBeLessThanOrEqual(8)

  // Distinct bytes per run: a preview already in the session cache resolves
  // without a network round trip, which is exactly the race that made the
  // walk see this 3 times in 5.
  const seed = Date.now() % 200
  await page.getByTestId("composer-plus").first().click()
  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles([
      {
        name: "walk-shot.png",
        mimeType: "image/png",
        buffer: makeSquarePng(480, [seed, 120, 200]),
      },
      {
        name: "walk-brief.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(`%PDF-1.4\n% send with files ${seed}\n`),
      },
    ])
  const staged = page.getByTestId("composer-attachment-strip")
  for (const name of ["walk-shot.png", "walk-brief.pdf"]) {
    await expect(staged.getByTitle(name, { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Files for the walk")

  await page.evaluate(() => {
    type Sample = { node: number | null; top: number; gap: number; h: number; c: number }
    const w = window as unknown as { __trace: Sample[]; __traceStop: boolean }
    w.__trace = []
    w.__traceStop = false
    const ids = new WeakMap<Element, number>()
    let next = 1
    const tick = () => {
      if (w.__traceStop) return
      const el = document.querySelector('[data-testid="message-scroll-container"]')
      if (!el?.isConnected) {
        w.__trace.push({ node: null, top: -1, gap: -1, h: -1, c: -1 })
      } else {
        if (!ids.has(el)) ids.set(el, next++)
        w.__trace.push({
          node: ids.get(el) ?? null,
          top: Math.round(el.scrollTop),
          gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          h: el.scrollHeight,
          c: el.clientHeight,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.keyboard.press("Enter")

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Files for the walk" })
    .first()
  await expect(sent.getByTestId("attachment-strip")).toBeVisible({ timeout: 20_000 })
  await expect(sent.getByTestId(/^attachment-thumbnail-/).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.waitForTimeout(1_500)
  const trace = await page.evaluate(() => {
    const w = window as unknown as {
      __trace: Array<{ node: number | null; top: number; gap: number; h: number; c: number }>
      __traceStop: boolean
    }
    w.__traceStop = true
    return w.__trace
  })

  // node:scrollTop/distance-to-bottom (scrollHeight, clientHeight), deduplicated.
  const summary = trace
    .map((s) => (s.node === null ? "NULL" : `${s.node}:${s.top}/${s.gap}(${s.h},${s.c})`))
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
  expect(trace.length, summary.join(" ")).toBeGreaterThan(10)
  // One scroller, the same node, in the document on every frame.
  expect(trace.filter((s) => s.node === null).length, summary.join(" ")).toBe(0)
  expect(new Set(trace.map((s) => s.node)).size, summary.join(" ")).toBe(1)
  // Never thrown back to the top of the history.
  expect(Math.min(...trace.map((s) => s.top)), summary.join(" ")).toBeGreaterThan(100)
  const last = trace[trace.length - 1]!
  expect(last.gap, summary.join(" ")).toBeLessThanOrEqual(8)
  await expect(sent).toBeInViewport()
})

// Regression (walk 2): staging a file grows the composer by a row of chips
// (~74px) and takes that height from the message list, with no content change
// and no scroll event, so a reader at the bottom lost the last 74px of the
// conversation under the composer. Removing the file must give it back.
test("[Threads] a reader at the bottom stays there as the composer grows and shrinks", async ({
  page,
  env,
  qa,
}) => {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Composer growth ${Date.now()}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "History starts here." },
    },
  })
  expect(created.status).toBe(200)
  const threadId = created.body.data.id as string
  for (let i = 0; i < 30; i++) {
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token: i % 2 === 0 ? qa.amina.token : qa.admin.token,
      body: { content: `History line ${i + 1}, long enough to make the channel scroll.` },
    })
    expect(res.status).toBe(200)
  }

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible({ timeout: 15_000 })
  const gap = async () => {
    const m = await readScrollMetrics(page)
    return m.scrollHeight - m.scrollTop - m.clientHeight
  }
  await expect.poll(gap).toBeLessThanOrEqual(8)
  const before = await readScrollMetrics(page)

  await page.getByTestId("composer-plus").first().click()
  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles({
      name: "grow.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% composer growth\n"),
    })
  await expect(
    page.getByTestId("composer-attachment-strip").getByTitle("grow.pdf", { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  // The list really did lose height to the composer, and still shows its end.
  await expect
    .poll(async () => (await readScrollMetrics(page)).clientHeight)
    .toBeLessThan(before.clientHeight - 30)
  await expect.poll(gap).toBeLessThanOrEqual(8)
  await expect(
    page.getByTestId(/^message-row/).filter({ hasText: "History line 30," }),
  ).toBeInViewport({ ratio: 1 })

  await page
    .getByTestId(/^composer-attachment-remove-/)
    .first()
    .click()
  await expect(page.getByTestId("composer-attachment-strip")).toHaveCount(0)
  await expect
    .poll(async () => (await readScrollMetrics(page)).clientHeight)
    .toBeGreaterThan(before.clientHeight - 8)
  await expect.poll(gap).toBeLessThanOrEqual(8)
})

// Regression (walk 3): content that grows at the bottom (the composer taking a
// row of staged files, then the sent message with its attachments) showed
// 55-180px of new content below the fold for one frame before the list
// re-pinned: the re-pin ran in a ResizeObserver or a requestAnimationFrame,
// after the frame had already laid the growth out. Sampled on every animation
// frame, the distance to the bottom must be 0 on every frame from the pick to
// the settled send.
test("[Threads] growth at the bottom is pinned on the same frame", async ({ page, env, qa }) => {
  const created = await api(env.serverUrl, "/api/threads", {
    token: qa.admin.token,
    body: {
      forceCreate: true,
      title: `Same frame pin ${Date.now()}`,
      participantIds: [qa.admin.id, qa.amina.id],
      initialMessage: { content: "History starts here." },
    },
  })
  expect(created.status).toBe(200)
  const threadId = created.body.data.id as string
  for (let i = 0; i < 40; i++) {
    const res = await api(env.serverUrl, `/api/threads/${threadId}/messages`, {
      token: i % 2 === 0 ? qa.amina.token : qa.admin.token,
      body: { content: `History line ${i + 1}, long enough to make the channel scroll.` },
    })
    expect(res.status).toBe(200)
  }

  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  await expect(page.getByTestId("compose-editor")).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => {
      const m = await readScrollMetrics(page)
      return m.scrollHeight - m.scrollTop - m.clientHeight
    })
    .toBeLessThanOrEqual(1)
  await page.waitForTimeout(500)

  await page.evaluate(() => {
    type Sample = { gap: number; h: number; c: number }
    const w = window as unknown as { __frames: Sample[]; __framesStop: boolean }
    w.__frames = []
    w.__framesStop = false
    const tick = () => {
      if (w.__framesStop) return
      const el = document.querySelector('[data-testid="message-scroll-container"]')
      if (el) {
        w.__frames.push({
          gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          h: el.scrollHeight,
          c: el.clientHeight,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const seed = Date.now() % 200
  await page.getByTestId("composer-plus").first().click()
  await page
    .getByTestId("attachment-upload-input")
    .first()
    .setInputFiles([
      {
        name: "frame-shot.png",
        mimeType: "image/png",
        buffer: makeSquarePng(420, [seed, 80, 160]),
      },
      {
        name: "frame-brief.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(`%PDF-1.4\n% same frame ${seed}\n`),
      },
    ])
  const staged = page.getByTestId("composer-attachment-strip")
  for (const name of ["frame-shot.png", "frame-brief.pdf"]) {
    await expect(staged.getByTitle(name, { exact: true })).toBeVisible({ timeout: 20_000 })
  }
  await page.getByTestId("compose-editor").click()
  await page.keyboard.type("Same frame")
  await page.keyboard.press("Enter")

  const sent = page
    .getByTestId(/^message-row/)
    .filter({ hasText: "Same frame" })
    .first()
  await expect(sent.getByTestId(/^attachment-thumbnail-/).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.waitForTimeout(1_000)
  const frames = await page.evaluate(() => {
    const w = window as unknown as {
      __frames: Array<{ gap: number; h: number; c: number }>
      __framesStop: boolean
    }
    w.__framesStop = true
    return w.__frames
  })
  const summary = frames
    .map((s) => `${s.gap}(${s.h},${s.c})`)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
    .join(" ")
  expect(frames.length, summary).toBeGreaterThan(10)
  // The composer grew and the list grew: the growth really happened.
  expect(new Set(frames.map((s) => s.c)).size, summary).toBeGreaterThan(1)
  expect(new Set(frames.map((s) => s.h)).size, summary).toBeGreaterThan(1)
  expect(Math.max(...frames.map((s) => s.gap)), summary).toBeLessThanOrEqual(1)
  await expect(sent).toBeInViewport()
})
