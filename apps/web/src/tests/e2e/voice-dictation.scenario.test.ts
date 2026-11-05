// SPDX-License-Identifier: FSL-1.1-ALv2
//
// VOICE DICTATION THROUGH THE REAL SURFACE (P1 T9: S1, S2, S6). Chromium's
// fake microphone plays a real spontaneous-speech recording (an AMI Meeting
// Corpus clip, CC BY 4.0, apps/api/src/modules/assist/__fixtures__/dictation)
// into each composer: the mic is pressed, the take recorded for six seconds
// and stopped, and the real server transcribes it on the org's OpenRouter
// transcription model and cleans it up on the org's Auto model. On the ticket
// reply, a thread, a coding session, a task comment and a new mail:
//  * the mic sits immediately left of the surface's Send;
//  * while the take records, the control row is the recorder line (discard,
//    dot and timer, live waveform, stop where Send was, stop focused), then
//    "Transcribing…" with Send held back;
//  * the text inserted at the caret is exactly the `cleaned` the server
//    answered (read off the network response), after the text already there,
//    and the focus is back in the field;
//  * one Ctrl/Cmd+Z puts the field back as it was;
//  * discard and Escape drop a take and upload nothing.
// The recording line is photographed on the thread and the ticket reply,
// light and dark, into PW_SHOT_DIR (the phone's is threads-phone's).
// The org's only provider key is OpenRouter's (the live env carries no other),
// so the clean-up is the side call an OpenRouter-only org runs on its Auto
// model. Paid (well under a cent a take): live only, against the real
// OpenRouter: PLAYWRIGHT_LIVE_LLM=1 PLAYWRIGHT_REAL_OPENROUTER=1.
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import type { Locator, Page, Response } from "@playwright/test"
import { openAgentConversation } from "./agent-bootstrap"
import { expect, loginAs, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import { REAL_OPENROUTER, REAL_OPENROUTER_SKIP_REASON } from "./helpers/live-llm"
import { seedMailBaseline } from "./helpers/mail-fixtures"
import { createChannelViaUi, uniqueChannelName } from "./helpers/new-conversation"
import { seedProjectWithTasks } from "./helpers/projects-seed"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"
import { SHOT_DIR } from "./helpers/shot-dir"

const FAKE_AUDIO = resolve(__dirname, "fixtures", "dictation-en.wav")
/** The chat model the OpenRouter-only org adds and makes its Auto (the clean-up runs on it). */
const AUTO_UPSTREAM_ID = "google/gemini-3.1-flash-lite"
const BEFORE = "Hello "
/** How long each take records: the clip's first sentences. */
const TAKE_MS = 6_000

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_AUDIO}`,
    ],
  },
})

interface Transcribed {
  raw: string
  cleaned: string
  model: string
  cleanModel: string | null
}

/** One composer surface: how to reach it, its field, and how its text reads. */
interface Surface {
  name: string
  open: (page: Page) => Promise<void>
  /** The field written in (a contentEditable, or a textarea). */
  field: (page: Page) => Locator
  /** The surface's own mic, so another composer on screen never answers for it. */
  mic: (page: Page) => Locator
  /** The surface's own recorder line. */
  recorder: (page: Page) => Locator
  /** What names the surface's Send: its test id, or its accessible name. */
  send: string
  /** Photograph the recording line here, light and dark (`<shot>-light.png`, `-dark.png`). */
  shot?: string
  /** What is photographed (default: the composer card around the recorder). */
  card?: (page: Page) => Locator
  /** A dialog's footer: the primary action is hidden while the recorder takes the
   *  footer over, and the wand stays in view with the field. */
  footer?: { primary: (page: Page) => Locator; wand: (page: Page) => Locator }
  /** Leave the surface (a dialog closes), so the next one can be reached. */
  close?: (page: Page) => Promise<void>
  textarea?: true
}

/** The field's text, as a person reads it (no-break spaces as spaces). */
async function textOf(surface: Surface, page: Page): Promise<string> {
  const field = surface.field(page)
  const text = surface.textarea ? await field.inputValue() : await field.innerText()
  return text.replace(/ /g, " ").replace(/\n+$/, "")
}

function isTranscribe(res: Response): boolean {
  return res.request().method() === "POST" && res.url().includes("/api/assist/transcribe")
}

/** The mic is the element immediately before the surface's Send. */
async function expectMicBeforeSend(surface: Surface, page: Page): Promise<void> {
  const next = await surface.mic(page).evaluate((el) => {
    const sib = el.nextElementSibling
    return sib?.getAttribute("data-testid") ?? sib?.getAttribute("aria-label") ?? null
  })
  expect(next).toBe(surface.send)
}

/** Photograph `card`, in the light theme and in the dark one (`<name>-<theme>.png`). */
async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme)
    // The waveform reads its colours per frame: let a few bars paint in this theme.
    await page.waitForTimeout(400)
    await card.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` })
  }
}

/** The composer card around a recorder line. */
const cardOf = (recorder: Locator): Locator =>
  recorder.locator("xpath=ancestor::*[@data-composer-dock][1]")

/** One take: press the mic, record, stop; the server's answer once the text is in. */
async function dictate(surface: Surface, page: Page): Promise<Transcribed> {
  const mic = surface.mic(page)
  await mic.click()
  const recorder = surface.recorder(page)
  await expect(recorder).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
  // The row gave way to the recorder line; stop holds the focus.
  await expect(mic).toBeHidden()
  const stop = recorder.getByTestId("voice-dictation-stop")
  await expect(stop).toBeFocused()
  await expect(stop).toHaveAccessibleName("Stop and insert")
  await expect(recorder.getByTestId("voice-dictation-discard")).toBeVisible()
  await expect(recorder.getByTestId("voice-dictation-waveform")).toBeVisible()
  if (surface.footer) {
    // The footer is the recorder line now; the wand stays with the field.
    await expect(surface.footer.primary(page)).toBeHidden()
    await expect(surface.footer.wand(page)).toBeVisible()
    const [line, wand] = await Promise.all([
      recorder.boundingBox(),
      surface.footer.wand(page).boundingBox(),
    ])
    if (!line || !wand) throw new Error("the dialog is not laid out")
    expect(line.y).toBeGreaterThan(wand.y + wand.height - 1)
  }
  await page.waitForTimeout(TAKE_MS)
  // A LIVE waveform: the canvas holds painted bars by now.
  const painted = await recorder
    .getByTestId("voice-dictation-waveform")
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL().length)
  expect(painted).toBeGreaterThan(1_000)
  if (surface.shot) {
    await shoot(page, surface.card?.(page) ?? cardOf(recorder), `${surface.shot}-recording`)
  }
  // The route's own request budget (TRANSCRIBE_REQUEST_TIMEOUT_MS, 120 s): the
  // transcription model's provider has taken up to ~45 s a call at times.
  const answered = page.waitForResponse(isTranscribe, { timeout: 125_000 })
  await stop.click()
  await expect(recorder.getByTestId("voice-dictation-label")).toHaveText("Transcribing…")
  await expect(recorder.getByTestId("voice-dictation-pending")).toBeDisabled()
  const res = await answered
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data: Transcribed }
  await expect(recorder).toHaveCount(0, { timeout: 30_000 })
  await expect(mic).toBeVisible()
  await expect(surface.field(page)).toBeFocused()
  if (surface.footer) await expect(surface.footer.primary(page)).toBeVisible()
  return body.data
}

/** Discard (and Escape) drop a take: nothing is uploaded, the field is unchanged. */
async function dropTakes(surface: Surface, page: Page): Promise<void> {
  let uploads = 0
  const count = (req: { method: () => string; url: () => string }) => {
    if (req.method() === "POST" && req.url().includes("/api/assist/transcribe")) uploads += 1
  }
  page.on("request", count)
  const before = await textOf(surface, page)
  const recorder = surface.recorder(page)
  await surface.mic(page).click()
  await expect(recorder).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
  await page.waitForTimeout(1_000)
  await recorder.getByTestId("voice-dictation-discard").click()
  await expect(recorder).toHaveCount(0)
  await surface.mic(page).click()
  await expect(recorder).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
  await page.waitForTimeout(1_000)
  await page.keyboard.press("Escape")
  await expect(recorder).toHaveCount(0)
  await page.waitForTimeout(500)
  page.off("request", count)
  expect(uploads).toBe(0)
  expect(await textOf(surface, page)).toBe(before)
}

/** The field holds exactly `BEFORE`, the caret at its end. */
async function startWithHello(surface: Surface, page: Page): Promise<void> {
  const field = surface.field(page)
  await field.click()
  await expect(field).toBeFocused()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
  await page.keyboard.type(BEFORE)
  await expect.poll(() => textOf(surface, page)).toBe(BEFORE)
}

test.describe("voice dictation on every composer (live)", () => {
  test.describe.configure({ mode: "serial" })

  test("[VD1] each surface records in the recorder line, inserts the cleaned transcript at the caret and undoes in one step", async ({
    page,
    env,
    qa,
    world,
  }) => {
    test.skip(!REAL_OPENROUTER, REAL_OPENROUTER_SKIP_REASON)
    test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY not set: live dictation skipped")
    test.setTimeout(20 * 60_000)

    const orgId = world.org.id
    const stamp = Date.now()
    const ks = `${env.schemaPrefix}kernel`
    await seedModelPricingAndCredits(env, orgId, { included: "50.00000000" })

    // The OpenRouter-only org's chat model, added and made Auto as its admin does.
    const added = await api(env.serverUrl, "/api/settings/ai/openrouter/models", {
      token: qa.admin.token,
      body: { upstreamId: AUTO_UPSTREAM_ID },
    })
    expect([201, 409]).toContain(added.status)
    const auto = await api(env.serverUrl, "/api/settings/ai/models", {
      method: "PATCH",
      token: qa.admin.token,
      body: { autoModelKey: `openrouter/${AUTO_UPSTREAM_ID}` },
    })
    expect(auto.status).toBe(200)

    // Ticket reply.
    await grantTicketsScopes(env, orgId, qa.admin.id, [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:approve",
    ])
    const inbox = await seedInbox(env, orgId, {
      name: `Dictation inbox ${stamp}`,
      emailAddress: `dictation-${stamp}@e2e.test`,
      isDefault: true,
    })
    const ticket = await seedTicket(env, orgId, {
      subject: `Dictation ticket ${stamp}`,
      sourceInboxId: inbox.id,
    })
    // Task comment.
    const project = await seedProjectWithTasks(env, qa.admin.token, {
      name: `Dictation ${stamp}`,
      tasks: [{ title: `Dictate a comment ${stamp}` }],
    })
    const taskId = project.tasks[0]?.id
    if (!taskId) throw new Error("the seeded project has no task")
    // Mail compose: a connected account.
    await seedMailBaseline(env, world.admin.id, orgId)
    // Coding session: one the admin owns, finished, so its composer resumes it.
    const [agent] = await env.db.sql.unsafe<{ id: string }[]>(
      `SELECT id FROM "${ks}".agents WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
      [orgId],
    )
    const [session] = await env.db.sql.unsafe<{ id: string }[]>(
      `INSERT INTO "${ks}".node_sessions
         (org_id, owner_user_id, agent_id, source, config_kind, title, prompt, model, level,
          status, folder_name, folder_path, ended_at)
       VALUES ($1, $2, $3, 'app', 'owner', $4, 'Fix the build', 'claude-haiku-4-5', 'strict',
               'done', 'code', '/tmp/dictation-e2e', now())
       RETURNING id`,
      [orgId, qa.admin.id, agent?.id ?? randomUUID(), `Dictation session ${stamp}`],
    )
    if (!session) throw new Error("the session row was not created")

    const base = `http://localhost:${env.ports[1]}`
    let threadUrl = ""
    const active = (page: Page) => page.locator('[data-tab-active="true"]')
    const surfaces: Surface[] = [
      {
        name: "ticket reply",
        open: async (page) => {
          await page.goto(`${base}/tickets/${ticket.id}`)
          await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 15_000 })
        },
        field: (page) => page.getByTestId("tickets-composer-body"),
        mic: (page) => page.getByTestId("tickets-composer").getByTestId("voice-dictation-button"),
        recorder: (page) =>
          page.getByTestId("tickets-composer").getByTestId("voice-dictation-recorder"),
        send: "tickets-composer-submit",
        shot: "recorder-ticket-reply-desktop",
      },
      {
        name: "new ticket dialog",
        open: async (page) => {
          await page.goto(`${base}/tickets`)
          await page.getByTestId("tickets-new-ticket-button").click()
          await expect(page.getByTestId("tickets-new-dialog")).toBeVisible({ timeout: 15_000 })
        },
        field: (page) => page.getByTestId("tickets-new-body"),
        mic: (page) => page.getByTestId("tickets-new-dialog").getByTestId("voice-dictation-button"),
        recorder: (page) =>
          page.getByTestId("tickets-new-dialog").getByTestId("voice-dictation-recorder"),
        send: "tickets-new-submit",
        shot: "desktop-new-ticket-dialog",
        card: (page) => page.getByTestId("tickets-new-dialog"),
        footer: {
          primary: (page) => page.getByTestId("tickets-new-submit"),
          wand: (page) => page.getByTestId("tickets-new-dialog").getByTestId("magic-wand"),
        },
        close: async (page) => {
          await page.getByTestId("tickets-new-cancel").click()
          await expect(page.getByTestId("tickets-new-dialog")).toHaveCount(0)
        },
        textarea: true,
      },
      {
        name: "thread compose",
        open: async (page) => {
          await createChannelViaUi(page, uniqueChannelName("Dictation"))
          threadUrl = page.url()
        },
        field: (page) => active(page).getByTestId("compose-editor"),
        mic: (page) => active(page).getByTestId("voice-dictation-button"),
        recorder: (page) => active(page).getByTestId("voice-dictation-recorder"),
        send: "compose-send",
        shot: "recorder-thread-desktop",
      },
      {
        name: "session composer",
        open: async (page) => {
          await page.goto(`${base}/sessions/${session.id}`)
          await expect(active(page).getByTestId("session-composer-field")).toBeVisible({
            timeout: 15_000,
          })
        },
        field: (page) => active(page).getByTestId("session-composer-field").locator("textarea"),
        mic: (page) =>
          active(page).getByTestId("session-composer").getByTestId("voice-dictation-button"),
        recorder: (page) =>
          active(page).getByTestId("session-composer").getByTestId("voice-dictation-recorder"),
        send: "Send",
        textarea: true,
      },
      {
        name: "task comment",
        open: async (page) => {
          await page.goto(`${base}/projects/tasks/${taskId}`)
          await expect(active(page).getByTestId("task-discussion.composer")).toBeVisible({
            timeout: 15_000,
          })
        },
        field: (page) => active(page).getByTestId("task-discussion.composer"),
        mic: (page) =>
          active(page)
            .getByTestId("task-discussion.dropzone")
            .getByTestId("voice-dictation-button"),
        recorder: (page) =>
          active(page)
            .getByTestId("task-discussion.dropzone")
            .getByTestId("voice-dictation-recorder"),
        send: "task-discussion.send",
      },
      {
        name: "mail compose",
        open: async (page) => {
          await page.getByTestId("activity-mail").click()
          await page.waitForURL(/\/mail$/, { timeout: 15_000 })
          await page.getByTestId("mail-compose-btn").click()
          await page.waitForURL(/\/mail\/compose$/, { timeout: 10_000 })
          await expect(page.getByTestId("mail-compose")).toBeVisible()
          await page.getByTestId("mail-compose-to").fill(`dictation-${stamp}@e2e.test`)
        },
        field: (page) => page.getByTestId("mail-compose-editor").locator("[contenteditable]"),
        mic: (page) => page.getByTestId("mail-compose").getByTestId("voice-dictation-button"),
        recorder: (page) =>
          page.getByTestId("mail-compose").getByTestId("voice-dictation-recorder"),
        send: "mail-compose-send",
      },
    ]

    await loginAs(page, env, qa.admin.email, "12345678")

    for (const surface of surfaces) {
      await test.step(surface.name, async () => {
        await surface.open(page)
        await expect(surface.mic(page)).toBeVisible({ timeout: 15_000 })
        await expectMicBeforeSend(surface, page)

        // The cleaned text lands after "Hello ", one undo removes it.
        await startWithHello(surface, page)
        if (surface.shot && surface.card)
          await shoot(page, surface.card(page), `${surface.shot}-idle`)
        const take = await dictate(surface, page)
        expect(take.model).toMatch(/^openrouter\//)
        expect(take.cleanModel).toBe(`openrouter/${AUTO_UPSTREAM_ID}`)
        expect(take.cleaned.length).toBeGreaterThan(0)
        await expect.poll(() => textOf(surface, page)).toBe(`${BEFORE}${take.cleaned}`)
        await page.keyboard.press("ControlOrMeta+z")
        await expect.poll(() => textOf(surface, page)).toBe(BEFORE)

        // Discard and Escape: nothing uploaded, nothing inserted.
        await dropTakes(surface, page)
        await surface.close?.(page)
      })
    }

    // The task comment's formatting toolbar in its ~340 px column: every tool
    // it shows is inside the row (the rest are in its "more" menu).
    await test.step("task comment toolbar: nothing clipped", async () => {
      await page.goto(`${base}/projects/tasks/${taskId}`)
      const dropzone = active(page).getByTestId("task-discussion.dropzone")
      const comment = dropzone.getByTestId("task-discussion.composer")
      await expect(comment).toBeVisible({ timeout: 15_000 })
      await comment.click()
      const toolbar = dropzone.getByTestId("rich-editor.toolbar")
      await expect(toolbar).toBeVisible()
      const bar = await toolbar.boundingBox()
      if (!bar) throw new Error("the toolbar is not laid out")
      // The row measures itself once shown: wait for its settled layout.
      if (bar.width < 400) await expect(toolbar.getByTestId("rich-editor.more")).toBeVisible()
      const tools = toolbar.locator(
        '[data-testid^="rich-editor.tool-"], [data-testid="rich-editor.more"]',
      )
      const count = await tools.count()
      expect(count).toBeGreaterThan(0)
      for (let i = 0; i < count; i++) {
        const box = await tools.nth(i).boundingBox()
        if (!box) throw new Error("a tool is not laid out")
        expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5)
      }
      await shoot(page, dropzone, "desktop-task-comment-toolbar")
    })

    // "No speech heard": a silent microphone. The line keeps its geometry
    // (discard, timer, stop disabled), the notice in the waveform's place.
    await test.step("no speech: the recorder line keeps its geometry", async () => {
      await page.goto(threadUrl)
      const field = active(page).getByTestId("compose-editor")
      await expect(field).toBeVisible({ timeout: 15_000 })
      await page.evaluate(() => {
        const silent = () => {
          const ctx = new AudioContext()
          const dest = ctx.createMediaStreamDestination()
          const gain = ctx.createGain()
          gain.gain.value = 0
          const osc = ctx.createOscillator()
          osc.connect(gain).connect(dest)
          osc.start()
          return Promise.resolve(dest.stream)
        }
        navigator.mediaDevices.getUserMedia = silent
      })
      const recorder = active(page).getByTestId("voice-dictation-recorder")
      await field.click()
      await active(page).getByTestId("voice-dictation-button").click()
      await expect(recorder).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
      await page.waitForTimeout(2_500)
      const during = await recorder.boundingBox()
      await recorder.getByTestId("voice-dictation-stop").click()
      const note = recorder.getByTestId("voice-dictation-note")
      await expect(note).toHaveText("No speech heard. Nothing was inserted.")
      const after = await recorder.boundingBox()
      expect(after?.height).toBe(during?.height)
      await expect(recorder.getByTestId("voice-dictation-discard")).toBeVisible()
      await expect(recorder.getByTestId("voice-dictation-elapsed")).toBeVisible()
      await expect(recorder.getByTestId("voice-dictation-stop")).toBeDisabled()
      await shoot(page, cardOf(recorder), "silent-thread-composer-no-speech")
      await expect(recorder).toHaveCount(0, { timeout: 5_000 })
      await page.reload()
    })

    // Phone (390): the input line itself becomes the recorder; the field
    // comes back with the text at the caret, the focus in it.
    await test.step("phone thread composer: the input line becomes the recorder", async () => {
      const desktop = page.viewportSize()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(threadUrl)
      const phone: Surface = {
        name: "phone thread",
        open: async () => {},
        field: (p) => active(p).getByTestId("compose-editor"),
        mic: (p) => active(p).getByTestId("voice-dictation-button"),
        recorder: (p) => active(p).getByTestId("voice-dictation-recorder"),
        send: "compose-send",
      }
      await expect(phone.field(page)).toBeVisible({ timeout: 15_000 })
      await startWithHello(phone, page)
      const answered = page.waitForResponse(isTranscribe, { timeout: 125_000 })
      await phone.mic(page).click()
      const recorder = phone.recorder(page)
      await expect(recorder).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
      await expect(phone.field(page)).toBeHidden()
      await page.waitForTimeout(TAKE_MS)
      await shoot(page, cardOf(recorder), "phone390-thread-composer-recording")
      await recorder.getByTestId("voice-dictation-stop").click()
      const res = await answered
      const body = (await res.json()) as { data: Transcribed }
      await expect(recorder).toHaveCount(0, { timeout: 30_000 })
      await expect(phone.field(page)).toBeVisible()
      await expect(phone.field(page)).toBeFocused()
      await expect.poll(() => textOf(phone, page)).toBe(`${BEFORE}${body.data.cleaned}`)
      await shoot(
        page,
        phone.field(page).locator("xpath=ancestor::*[@data-composer-dock][1]"),
        "phone390-thread-composer-inserted",
      )
      await page.keyboard.press("ControlOrMeta+z")
      await expect.poll(() => textOf(phone, page)).toBe(BEFORE)
      if (desktop) await page.setViewportSize(desktop)
    })

    // The personal agent's dock: its model chip says "Default" and shares the
    // control line with the mic and Send (it took a line of its own).
    await test.step("agent dock composer: model chip on the control line", async () => {
      await page.goto(`${base}/tickets/${ticket.id}`)
      const dock = await openAgentConversation(page)
      const chip = dock.getByTestId("thread-model-chip")
      await expect(chip).toBeVisible({ timeout: 15_000 })
      await expect(chip.getByTestId("model-selector-label")).toHaveText("Default")
      const title = await chip
        .getByTestId("model-selector-label")
        .locator("xpath=ancestor::button[1]")
        .getAttribute("title")
      expect(title).toMatch(/^Default \(/)
      const send = dock.getByTestId("compose-send")
      const row = dock.getByTestId("compose-controls-row")
      const [chipBox, sendBox, rowBox] = await Promise.all([
        chip.boundingBox(),
        send.boundingBox(),
        row.boundingBox(),
      ])
      if (!chipBox || !sendBox || !rowBox) throw new Error("the dock's composer is not laid out")
      expect(rowBox.width).toBeGreaterThanOrEqual(300)
      // One line: the chip's middle sits within Send's height.
      const middle = chipBox.y + chipBox.height / 2
      expect(middle).toBeGreaterThan(sendBox.y)
      expect(middle).toBeLessThan(sendBox.y + sendBox.height)
      const card = row.locator("xpath=ancestor::*[@data-composer-dock][1]")
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme)
        await page.waitForTimeout(200)
        await card.screenshot({ path: `${SHOT_DIR}/dock-composer-model-chip-${theme}.png` })
      }

      // A long "Provider: Model" name: the chip names the model, ellipsized;
      // the title keeps the provider.
      const trigger = chip.getByLabel("Select model")
      await trigger.click()
      await page
        .getByRole("menuitem", { name: /Gemini 3\.1 Flash Lite/ })
        // The model's own entry, not the Default one that names it as Auto's.
        .filter({ hasNotText: "Default" })
        .first()
        .click()
      const label = chip.getByTestId("model-selector-label")
      await expect(label).toHaveText(/^Gemini/)
      const longTitle = await label.locator("xpath=ancestor::button[1]").getAttribute("title")
      expect(longTitle).toMatch(/: Gemini 3\.1 Flash Lite/)
      await shoot(page, card, "dock-chip-long")
    })
  })
})
