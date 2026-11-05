// SPDX-License-Identifier: FSL-1.1-ALv2
// Walk D76: the agent's live turn in a docked chat is a tall block inside the
// chat window's scroll area; ringed by its own box, the spotlight ran up off
// the window, over the ticket header and the banner. The ring is the part of
// the anchor its scroll containers show.
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { type AnchorBox, createAnchorTracker } from "./anchor-tracker"

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function boxed(el: HTMLElement, r: DOMRect): HTMLElement {
  el.getBoundingClientRect = () => r
  el.getClientRects = () => [r] as unknown as DOMRectList
  return el
}

let dispose: () => void = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function track(testid: string, all = false): () => AnchorBox | null {
  let read: () => AnchorBox | null = () => null
  createRoot((d) => {
    dispose = d
    read = createAnchorTracker(
      () => testid,
      () => all,
    )
  })
  return read
}

describe("the anchor's box", () => {
  it("is clipped to the scroll area that holds it", () => {
    // The chat window's message list (jsdom's screen is 1024 x 768): 400 px
    // tall, from y 300 to 700.
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    // The live turn: 900 px tall, scrolled so most of it is above the list.
    const turn = boxed(document.createElement("div"), rect(-200, 610, 320, 850))
    turn.dataset.testid = "agent-stream-block"
    list.append(turn)
    document.body.append(list)

    const box = track("agent-stream-block")()
    expect(box).not.toBeNull()
    expect(box?.top).toBe(300)
    expect(box?.height).toBe(350)
    expect(box?.left).toBe(610)
    expect(box?.width).toBe(320)
  })

  it("is the element's own box when nothing clips it", () => {
    const el = boxed(document.createElement("div"), rect(100, 100, 200, 40))
    el.dataset.testid = "plain"
    document.body.append(el)
    const box = track("plain")()
    expect(box).toMatchObject({ top: 100, left: 100, width: 200, height: 40 })
  })

  it("is nothing when its scroll area shows none of it", () => {
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    const turn = boxed(document.createElement("div"), rect(720, 610, 320, 40))
    turn.dataset.testid = "agent-stream-block"
    turn.scrollIntoView = () => {}
    list.append(turn)
    document.body.append(list)
    expect(track("agent-stream-block")()).toBeNull()
  })

  it("is scrolled into its scroll area once when the area shows none of it", () => {
    // A tool row of the answered turn, scrolled above a docked chat's list.
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    const row = boxed(document.createElement("div"), rect(120, 610, 320, 40))
    row.dataset.testid = "tool-call-row"
    let scrolls = 0
    row.scrollIntoView = () => {
      scrolls += 1
      row.getBoundingClientRect = () => rect(400, 610, 320, 40)
    }
    list.append(row)
    document.body.append(list)
    const box = track("tool-call-row")()
    expect(scrolls).toBe(1)
    expect(box).toMatchObject({ top: 400, height: 40 })
  })

  it("is scrolled into view once when it shows less than half of itself", () => {
    // The routine's draft under its long internal note: its top edge only.
    const card = boxed(document.createElement("div"), rect(744, 100, 600, 200))
    card.dataset.testid = "tickets-detail-approval-card"
    let scrolls = 0
    let block: ScrollLogicalPosition | undefined
    card.scrollIntoView = (opts?: boolean | ScrollIntoViewOptions) => {
      scrolls += 1
      block = typeof opts === "object" ? opts.block : undefined
      card.getBoundingClientRect = () => rect(568, 100, 600, 200)
    }
    document.body.append(card)
    const box = track("tickets-detail-approval-card")()
    expect(scrolls).toBe(1)
    // The least scroll, downward: never past where it needs to be.
    expect(block).toBe("nearest")
    expect(box).toMatchObject({ top: 568, height: 200 })
  })

  it("is not scrolled back up when a following chat has cut off its top", () => {
    // The turn being answered, pushed up a docked chat that keeps to its
    // newest message: scrolling it back would stop the chat following.
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    const turn = boxed(document.createElement("div"), rect(150, 610, 320, 250))
    turn.dataset.testid = "agent-answer"
    let scrolls = 0
    turn.scrollIntoView = () => {
      scrolls += 1
    }
    list.append(turn)
    document.body.append(list)
    const box = track("agent-answer")()
    expect(scrolls).toBe(0)
    expect(box).toMatchObject({ top: 300, height: 100 })
  })
})

describe("an anchor a following chat pushed up", () => {
  it("is not scrolled back up once it was seen, even as a new element", async () => {
    // The approval card the person approved in a docked chat: on screen, then
    // hidden for its Undo window, then back above the list, which follows the
    // agent's follow-up. Scrolling up to it would stop the chat following.
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    const card = boxed(document.createElement("div"), rect(500, 610, 320, 120))
    card.dataset.testid = "approval-card"
    let scrolls = 0
    const counted = (el: HTMLElement) => {
      el.scrollIntoView = () => {
        scrolls += 1
      }
    }
    counted(card)
    list.append(card)
    document.body.append(list)
    const read = track("approval-card")
    expect(read()).toMatchObject({ top: 500, height: 120 })

    card.remove()
    const again = boxed(document.createElement("div"), rect(100, 610, 320, 120))
    again.dataset.testid = "approval-card"
    counted(again)
    list.append(again)
    window.dispatchEvent(new Event("resize"))
    expect(scrolls).toBe(0)
    expect(read()).toBeNull()
  })

  it("is still scrolled down to when the chat leaves it below the fold", () => {
    const list = boxed(document.createElement("div"), rect(300, 600, 340, 400))
    list.style.overflowY = "auto"
    const card = boxed(document.createElement("div"), rect(500, 610, 320, 120))
    card.dataset.testid = "approval-card"
    list.append(card)
    document.body.append(list)
    const read = track("approval-card")
    expect(read()).not.toBeNull()
    card.remove()
    const below = boxed(document.createElement("div"), rect(760, 610, 320, 120))
    below.dataset.testid = "approval-card"
    let scrolls = 0
    below.scrollIntoView = () => {
      scrolls += 1
    }
    list.append(below)
    window.dispatchEvent(new Event("resize"))
    expect(scrolls).toBe(1)
  })
})

// The projects scenario's board beat: the subtasks the agent just made under
// the visitor's task are ringed together, not only the first of them.
describe("a group anchor", () => {
  function row(taskId: string, parentId: string, top: number): HTMLElement {
    const li = boxed(document.createElement("li"), rect(top, 20, 600, 40))
    li.dataset.testid = "project-list-view.row"
    li.dataset.taskId = taskId
    li.dataset.parentTaskId = parentId
    return li
  }

  function list(): void {
    const ul = document.createElement("ul")
    ul.append(
      row("mine", "", 100),
      row("sub-1", "mine", 140),
      row("sub-2", "mine", 180),
      row("sub-3", "mine", 220),
      row("other", "", 260),
      row("other-sub", "other", 300),
    )
    document.body.append(ul)
  }

  const anchor = "project-list-view.row[data-parent-task-id=mine]"

  it("rings every visible match as one box", () => {
    list()
    expect(track(anchor, true)()).toMatchObject({ top: 140, left: 20, width: 600, height: 120 })
  })

  it("leaves out a match that is hidden", () => {
    list()
    const hidden = document.querySelector<HTMLElement>('[data-task-id="sub-3"]')!
    hidden.style.display = "none"
    expect(track(anchor, true)()).toMatchObject({ top: 140, height: 80 })
  })

  it("rings only the first match without it", () => {
    list()
    expect(track(anchor)()).toMatchObject({ top: 140, height: 40 })
  })

  it("is nothing while no row matches", () => {
    list()
    expect(track("project-list-view.row[data-parent-task-id=none]", true)()).toBeNull()
  })
})
