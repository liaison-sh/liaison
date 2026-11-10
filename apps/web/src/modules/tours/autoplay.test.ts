// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T7: the autoplay runner's state machine against a fake DOM. The real
// typing/menu proof is the Playwright scenario tour-autoplay.scenario.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clickTarget, ghostClick, runAutoplay, TOUR_UI_ATTR, watchTakeover } from "./autoplay"

const cursor = { moveTo: vi.fn(async () => {}) }
const fast = { typeDelayMs: 0, stepPauseMs: 0, findTimeoutMs: 60 }

function add<T extends HTMLElement>(el: T, testid: string): T {
  el.dataset.testid = testid
  el.getClientRects = () => [{}] as unknown as DOMRectList
  document.body.append(el)
  return el
}

beforeEach(() => cursor.moveTo.mockClear())
afterEach(() => {
  document.body.innerHTML = ""
})

describe("ghostClick", () => {
  it("dispatches the full mouse sequence, untrusted", () => {
    const btn = add(document.createElement("button"), "b")
    const seen: string[] = []
    for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      btn.addEventListener(k, (e) => {
        seen.push(`${k}:${(e as MouseEvent).button}:${e.isTrusted}`)
        if (k.startsWith("pointer")) expect((e as PointerEvent).pointerType).toBe("mouse")
      })
    }
    ghostClick(btn)
    expect(seen).toEqual([
      "pointerdown:0:false",
      "mousedown:0:false",
      "pointerup:0:false",
      "mouseup:0:false",
      "click:0:false",
    ])
  })
})

describe("runAutoplay", () => {
  // Walk D49: on a visit that had played Sales, the Mail tour opened the
  // newest conversation, the prospect's email the routine had already
  // answered. A click may prefer the rows carrying a mark (unread) and falls
  // back to the first one only when none does.
  it("a click that prefers marked rows presses the first marked one, else the first row", async () => {
    const pressed: string[] = []
    const row = (id: string, unread: boolean) => {
      const el = add(document.createElement("div"), "row")
      el.dataset.id = id
      if (unread) el.dataset.unread = "true"
      el.addEventListener("click", () => pressed.push(id))
      return el
    }
    row("answered", false)
    row("waiting", true)
    const step = { click: "row", prefer: { attr: "data-unread", value: "true" } } as const
    const opts = { cursor, signal: new AbortController().signal, ...fast }
    expect(await runAutoplay([step], opts)).toEqual({ status: "done" })
    expect(pressed).toEqual(["waiting"])
    document.body.innerHTML = ""
    pressed.length = 0
    row("read-only", false)
    expect(await runAutoplay([step], opts)).toEqual({ status: "done" })
    expect(pressed).toEqual(["read-only"])
  })

  // Walk D31/D46: the approvals list re-rendered its cards (a list refetch
  // right after the draft landed) while the ghost glided to Approve, and the
  // click went to the detached button: no decision was sent, though a real
  // tap, which always lands on what is on screen, did send one.
  it("presses the element on screen when the one it glided to was re-rendered meanwhile", async () => {
    const first = add(document.createElement("button"), "approve")
    first.dataset.entityId = "r-1"
    const pressed: string[] = []
    first.addEventListener("click", () => pressed.push("detached"))
    const glide = {
      moveTo: vi.fn(async (el: HTMLElement) => {
        if (el !== first) return
        // The card is rebuilt during the glide: same request, a new button.
        first.remove()
        const fresh = add(document.createElement("button"), "approve")
        fresh.dataset.entityId = "r-1"
        fresh.addEventListener("click", () => pressed.push("fresh"))
      }),
    }
    const result = await runAutoplay(
      [{ click: { testid: "approve", created: { beat: "draft", attr: "data-entity-id" } } }],
      { cursor: glide, signal: new AbortController().signal, ...fast, created: { draft: "r-1" } },
    )
    expect(result).toEqual({ status: "done" })
    expect(pressed).toEqual(["fresh"])
  })

  // CI, projects.basics at 390: the send button greyed out for an instant
  // while the live connection reconnected, during the cursor's glide to it.
  // The press on the disabled button reached nothing, the script reported
  // done, and the typed request sat in the composer unsent.
  it("waits for a button disabled during the glide to take the press again", async () => {
    const send = add(document.createElement("button"), "send")
    const pressed: boolean[] = []
    send.addEventListener("click", () => pressed.push(send.disabled))
    const glide = {
      moveTo: vi.fn(async (el: HTMLElement) => {
        if (el !== send || glide.moveTo.mock.calls.length > 1) return
        send.disabled = true
        setTimeout(() => {
          send.disabled = false
        }, 30)
      }),
    }
    const result = await runAutoplay([{ click: "send" }], {
      cursor: glide,
      signal: new AbortController().signal,
      ...fast,
      findTimeoutMs: 500,
    })
    expect(result).toEqual({ status: "done" })
    expect(pressed).toEqual([false])
  })

  it("a button that stays disabled fails the step instead of a press that reaches nothing", async () => {
    const send = add(document.createElement("button"), "send")
    send.disabled = true
    const pressed = vi.fn()
    send.addEventListener("click", pressed)
    const result = await runAutoplay([{ click: "send" }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(result).toEqual({ status: "failed", missing: "send" })
    expect(pressed).not.toHaveBeenCalled()
  })

  it("types into a textarea one character at a time and presses a key", async () => {
    const ta = add(document.createElement("textarea"), "field")
    const inputs: string[] = []
    ta.addEventListener("input", () => inputs.push(ta.value))
    const keys: string[] = []
    ta.addEventListener("keydown", (e) => keys.push(e.key))
    const result = await runAutoplay(
      [{ type: { testid: "field", text: "hey" } }, { press: { testid: "field", key: "Enter" } }],
      { cursor, signal: new AbortController().signal, ...fast },
    )
    expect(result).toEqual({ status: "done" })
    expect(ta.value).toBe("hey")
    expect(inputs).toEqual(["h", "he", "hey"])
    expect(keys).toEqual(["Enter"])
    expect(cursor.moveTo).toHaveBeenCalledTimes(2)
  })

  it("a typing step replaces what the field held (a half-typed draft after a takeover)", async () => {
    const ta = add(document.createElement("textarea"), "field")
    ta.value = "Thanks for reach"
    const result = await runAutoplay([{ type: { testid: "field", text: "hey" } }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(result.status).toBe("done")
    expect(ta.value).toBe("hey")
  })

  it("a rich editor's draft is replaced too", async () => {
    const wrap = add(document.createElement("div"), "editor")
    const editable = document.createElement("div")
    editable.setAttribute("contenteditable", "true")
    editable.textContent = "Thanks for reach"
    wrap.append(editable)
    await runAutoplay([{ type: { testid: "editor", text: "ok" } }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(editable.textContent).toBe("ok")
  })

  it("an append step continues the text already there (after picking a mention)", async () => {
    const ta = add(document.createElement("textarea"), "field")
    ta.value = "@Ali "
    await runAutoplay([{ type: { testid: "field", text: "hey", append: true } }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(ta.value).toBe("@Ali hey")
  })

  it("types into a rich editor inside a wrapper carrying the testid", async () => {
    const wrap = add(document.createElement("div"), "editor")
    const editable = document.createElement("div")
    editable.setAttribute("contenteditable", "true")
    wrap.append(editable)
    const result = await runAutoplay([{ type: { testid: "editor", text: "ok" } }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(result.status).toBe("done")
    expect(editable.textContent).toBe("ok")
  })

  it("types and sends only in the person's own agent conversation, not the channel beside the dock", async () => {
    // The channel's composer comes first in the page, as on a channel screen with the dock open.
    const channel = add(document.createElement("div"), "compose-field")
    channel.dataset.personalAgent = "false"
    const channelEditor = document.createElement("div")
    channelEditor.setAttribute("contenteditable", "true")
    channel.append(channelEditor)
    const channelSend = add(document.createElement("button"), "compose-send")
    channelSend.dataset.personalAgent = "false"
    const own = add(document.createElement("div"), "compose-field")
    own.dataset.personalAgent = "true"
    const ownEditor = document.createElement("div")
    ownEditor.setAttribute("contenteditable", "true")
    own.append(ownEditor)
    const ownSend = add(document.createElement("button"), "compose-send")
    ownSend.dataset.personalAgent = "true"
    const pressed: string[] = []
    channelSend.addEventListener("click", () => pressed.push("channel"))
    ownSend.addEventListener("click", () => pressed.push("own"))
    const where = { attr: "data-personal-agent", value: "true" }
    const result = await runAutoplay(
      [
        { type: { testid: "compose-field", text: "hi", where } },
        { click: { testid: "compose-send", where } },
      ],
      { cursor, signal: new AbortController().signal, ...fast },
    )
    expect(result.status).toBe("done")
    expect(ownEditor.textContent).toBe("hi")
    expect(channelEditor.textContent).toBe("")
    expect(pressed).toEqual(["own"])
  })

  // Demo walk: the Sales tour's CRM step pins Approve by the card's
  // `data-tool-name`, which sits on the card root, not on the button. Three
  // pending cards (a web fetch above, the CRM write, a reply below): Do it for
  // me must press the CRM card's Approve, not time out, and not the others.
  it("a pin on the card's attribute presses the button inside the preferred card", async () => {
    const pressed: string[] = []
    const card = (tool: string) => {
      const root = add(document.createElement("div"), "approval-card")
      root.dataset.toolName = tool
      const row = document.createElement("div")
      const approve = document.createElement("button")
      approve.dataset.testid = "approval-card-action-approve"
      approve.getClientRects = () => [{}] as unknown as DOMRectList
      approve.addEventListener("click", () => pressed.push(tool))
      row.append(approve)
      root.append(row)
    }
    card("kernel:web_fetch")
    card("api-connector:connector_write")
    card("mail:reply")
    const approve = {
      testid: "approval-card-action-approve",
      where: {
        attr: "data-tool-name",
        value: ["api-connector:connector_write", "kernel:contacts_write", "mail:reply"],
      },
    }
    const result = await runAutoplay(
      [{ waitFor: approve }, { click: approve }, { waitEvent: true }],
      { cursor, signal: new AbortController().signal, ...fast },
    )
    expect(result).toEqual({ status: "done" })
    expect(pressed).toEqual(["api-connector:connector_write"])
  })

  // The composer shows a stand-in while the rich editor's code loads
  // (editor/index.tsx): the field carrying the testid is on screen before
  // anything in it can take text. A typing step waits for the editable inside
  // it, where it used to stop at once ("I could not find what this step needs
  // on screen"; gate run 42594553493, demo-tailored support at 1280).
  it("a typing step waits for the editor to load inside a field already on screen", async () => {
    const wrap = add(document.createElement("div"), "editor")
    const standIn = document.createElement("div")
    standIn.setAttribute("aria-busy", "true")
    wrap.append(standIn)
    const editable = document.createElement("div")
    editable.setAttribute("contenteditable", "true")
    setTimeout(() => standIn.replaceWith(editable), 30)
    const result = await runAutoplay(
      [{ waitFor: "editor" }, { type: { testid: "editor", text: "ok" } }],
      { cursor, signal: new AbortController().signal, ...fast, findTimeoutMs: 500 },
    )
    expect(result.status).toBe("done")
    expect(editable.textContent).toBe("ok")
  })

  it("clicks, waits for an element that appears later, and stops at waitEvent", async () => {
    const btn = add(document.createElement("button"), "open")
    const clicked = vi.fn()
    btn.addEventListener("click", () => {
      clicked()
      setTimeout(() => add(document.createElement("div"), "menu"), 20)
    })
    const after = vi.fn()
    const result = await runAutoplay(
      [{ click: "open" }, { waitFor: "menu" }, { waitEvent: true }, { click: "never-reached" }],
      { cursor, signal: new AbortController().signal, ...fast, findTimeoutMs: 500 },
    )
    after()
    expect(clicked).toHaveBeenCalledOnce()
    expect(result).toEqual({ status: "done" })
  })

  it("a click lands on what the mouse hits in the middle of the target (a row's inner button)", async () => {
    const row = add(document.createElement("div"), "row-with-button")
    const button = document.createElement("button")
    row.append(button)
    const opened = vi.fn()
    button.addEventListener("click", opened)
    const original = document.elementFromPoint
    document.elementFromPoint = () => button
    try {
      expect(clickTarget(row)).toBe(button)
      await runAutoplay([{ click: "row-with-button" }], {
        cursor,
        signal: new AbortController().signal,
        ...fast,
      })
      expect(opened).toHaveBeenCalledOnce()
      // Something outside the target (an overlay) is never clicked instead.
      document.elementFromPoint = () => document.body
      expect(clickTarget(row)).toBe(row)
    } finally {
      document.elementFromPoint = original
    }
  })

  it("a click with unlessVisible is skipped when that element is already on screen", async () => {
    const row = add(document.createElement("button"), "row")
    const opened = vi.fn()
    row.addEventListener("click", opened)
    const run = (steps: Parameters<typeof runAutoplay>[0]) =>
      runAutoplay(steps, { cursor, signal: new AbortController().signal, ...fast })
    // Nothing open yet: the row is clicked.
    expect(await run([{ click: "row", unlessVisible: "reply-bar" }, { waitEvent: true }])).toEqual({
      status: "done",
    })
    expect(opened).toHaveBeenCalledOnce()
    // Already open: the click is skipped.
    add(document.createElement("div"), "reply-bar")
    expect(await run([{ click: "row", unlessVisible: "reply-bar" }, { waitEvent: true }])).toEqual({
      status: "done",
    })
    expect(opened).toHaveBeenCalledOnce()
  })

  it("a click with unlessActive is skipped when its target is already the selected one", async () => {
    const tab = add(document.createElement("button"), "tab")
    const pressed = vi.fn()
    tab.addEventListener("click", pressed)
    const run = () =>
      runAutoplay([{ click: "tab", unlessActive: true }], {
        cursor,
        signal: new AbortController().signal,
        ...fast,
      })
    tab.setAttribute("data-active", "false")
    expect(await run()).toEqual({ status: "done" })
    expect(pressed).toHaveBeenCalledOnce()
    for (const attr of ["data-active", "aria-pressed", "aria-selected", "aria-checked"]) {
      for (const a of ["data-active", "aria-pressed", "aria-selected", "aria-checked"]) {
        tab.removeAttribute(a)
      }
      tab.setAttribute(attr, "true")
      expect(await run()).toEqual({ status: "done" })
    }
    expect(pressed).toHaveBeenCalledOnce()
  })

  it("a require guard that does not hold refuses: nothing after it runs", async () => {
    const send = add(document.createElement("button"), "send")
    send.setAttribute("data-action", "send-reply")
    const sent = vi.fn()
    send.addEventListener("click", sent)
    const steps = [
      { require: { testid: "send", attr: "data-action", value: "add-note" } },
      { click: "send" },
    ] as const
    const run = () => runAutoplay(steps, { cursor, signal: new AbortController().signal, ...fast })
    expect(await run()).toEqual({ status: "refused", target: "send" })
    expect(sent).not.toHaveBeenCalled()
    send.setAttribute("data-action", "add-note")
    expect(await run()).toEqual({ status: "done" })
    expect(sent).toHaveBeenCalledOnce()
  })

  it("a step pinned to a created entity works on that one only, and refuses when the tour created none", async () => {
    const mine = add(document.createElement("button"), "row")
    mine.setAttribute("data-task-id", "t-mine")
    const theirs = add(document.createElement("button"), "row")
    theirs.setAttribute("data-task-id", "t-theirs")
    document.body.prepend(theirs) // first in document order: an unpinned click would hit it
    const onMine = vi.fn()
    const onTheirs = vi.fn()
    mine.addEventListener("click", onMine)
    theirs.addEventListener("click", onTheirs)
    const step = {
      click: { testid: "row", created: { beat: "create-task", attr: "data-task-id" } },
    }
    const run = (created?: Record<string, string>) =>
      runAutoplay([step], { cursor, signal: new AbortController().signal, ...fast, created })
    expect(await run({ "create-task": "t-mine" })).toEqual({ status: "done" })
    expect(onMine).toHaveBeenCalledOnce()
    expect(onTheirs).not.toHaveBeenCalled()
    // The create beat was skipped: no id, so no fallback onto someone else's row.
    expect(await run({})).toEqual({ status: "refused", target: "row" })
    expect(onTheirs).not.toHaveBeenCalled()
    // The pinned entity is not on screen: the step fails, it never picks another.
    expect(await run({ "create-task": "t-gone" })).toEqual({ status: "failed", missing: "row" })
    expect(onTheirs).not.toHaveBeenCalled()
  })

  // The app tours ask the person's agent in the conversation the run recorded
  // (their DM with it), opened beside the screen.
  it("an openRunConversation step opens the conversation the run recorded, and refuses without one", async () => {
    const opened: string[] = []
    const openConversation = (id: string) => {
      opened.push(id)
      const field = add(document.createElement("textarea"), "compose-field")
      field.dataset.threadId = id
    }
    const steps = [
      { openRunConversation: true as const },
      {
        waitFor: {
          testid: "compose-field",
          created: { beat: "conversation", attr: "data-thread-id" },
        },
      },
    ]
    const ok = await runAutoplay(steps, {
      cursor,
      signal: new AbortController().signal,
      ...fast,
      created: { conversation: "run-thread" },
      openConversation,
    })
    expect(ok).toEqual({ status: "done" })
    expect(opened).toEqual(["run-thread"])
    const none = await runAutoplay(steps, {
      cursor,
      signal: new AbortController().signal,
      ...fast,
      openConversation,
    })
    expect(none).toEqual({ status: "refused", target: "compose-field" })
    expect(opened).toEqual(["run-thread"])
  })

  it("a missing target stops the script and names it (never skips)", async () => {
    const later = add(document.createElement("button"), "later")
    const clicked = vi.fn()
    later.addEventListener("click", clicked)
    const result = await runAutoplay([{ click: "missing" }, { click: "later" }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
    })
    expect(result).toEqual({ status: "failed", missing: "missing" })
    expect(clicked).not.toHaveBeenCalled()
  })

  it("types a whole request in well under a second at its own pace", async () => {
    const ta = add(document.createElement("textarea"), "field")
    const text =
      "Is Lena Hart a VIP customer? What has she bought from us, and when did she last order?"
    const started = performance.now()
    const result = await runAutoplay([{ type: { testid: "field", text } }], {
      cursor,
      signal: new AbortController().signal,
      stepPauseMs: 0,
      findTimeoutMs: 60,
    })
    expect(result.status).toBe("done")
    expect(ta.value).toBe(text)
    expect(performance.now() - started).toBeLessThan(700)
  })

  it("an abort stops typing midway", async () => {
    const ta = add(document.createElement("textarea"), "field")
    const ac = new AbortController()
    ta.addEventListener("input", () => {
      if (ta.value.length === 2) ac.abort()
    })
    const result = await runAutoplay([{ type: { testid: "field", text: "abcdef" } }], {
      cursor,
      signal: ac.signal,
      ...fast,
      typeDelayMs: 1,
    })
    expect(result).toEqual({ status: "aborted" })
    expect(ta.value).toBe("ab")
  })
})

describe("watchTakeover", () => {
  it("ignores the ghost's own (untrusted) events by default", () => {
    const onTakeover = vi.fn()
    const stop = watchTakeover(onTakeover)
    ghostClick(add(document.createElement("button"), "b"))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    stop()
    expect(onTakeover).not.toHaveBeenCalled()
  })

  // Moving the mouse while Do it for me typed stopped it mid-sentence: a hand
  // on the mouse, a hover or a focus change is never a takeover.
  it("fires on a key or a press; a mouse move, a hover or a focus change never", () => {
    const onTakeover = vi.fn()
    const stop = watchTakeover(onTakeover, () => true)
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 300 }))
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 10, clientY: 10 }))
    window.dispatchEvent(new MouseEvent("pointerover", { clientX: 10, clientY: 10 }))
    window.dispatchEvent(new FocusEvent("focusin"))
    window.dispatchEvent(new FocusEvent("blur"))
    expect(onTakeover).not.toHaveBeenCalled()
    window.dispatchEvent(new MouseEvent("pointerdown", { clientX: 40, clientY: 30 }))
    expect(onTakeover).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    expect(onTakeover).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    expect(onTakeover).toHaveBeenCalledTimes(2)
  })

  it("while the tour types, only the person's own typing takes over: a press or a scroll does not", async () => {
    const ta = add(document.createElement("textarea"), "field")
    // Focused already: the ghost presses nothing before it types.
    ta.focus()
    const onTakeover = vi.fn()
    const stop = watchTakeover(onTakeover, () => true)
    let pressed = false
    ta.addEventListener("input", () => {
      if (pressed) return
      pressed = true
      window.dispatchEvent(new MouseEvent("pointerdown", { clientX: 5, clientY: 5 }))
      window.dispatchEvent(new WheelEvent("wheel"))
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 300 }))
    })
    const result = await runAutoplay([{ type: { testid: "field", text: "hello there" } }], {
      cursor,
      signal: new AbortController().signal,
      ...fast,
      typeDelayMs: 1,
    })
    expect(result.status).toBe("done")
    expect(ta.value).toBe("hello there")
    expect(onTakeover).not.toHaveBeenCalled()
    stop()
  })

  it("input on the tour's own panel (Skip, Pause) is never a takeover", () => {
    const onTakeover = vi.fn()
    const panel = document.createElement("section")
    panel.setAttribute(TOUR_UI_ATTR, "")
    const skip = document.createElement("button")
    panel.append(skip)
    const app = document.createElement("button")
    document.body.append(panel, app)
    const stop = watchTakeover(onTakeover, () => true)
    skip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    skip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 0, clientY: 0 }))
    skip.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 90, clientY: 90 }))
    expect(onTakeover).not.toHaveBeenCalled()
    app.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    expect(onTakeover).toHaveBeenCalledOnce()
    stop()
  })
})
