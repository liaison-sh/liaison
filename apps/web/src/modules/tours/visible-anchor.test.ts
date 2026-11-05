// SPDX-License-Identifier: FSL-1.1-ALv2
// The visible-anchor resolver shared by the spotlight and the ghost cursor:
// keep-alive tabs leave hidden copies of every testid in the DOM.
import { afterEach, describe, expect, it, vi } from "vitest"
import { editableTarget, resolveVisibleAnchor } from "./visible-anchor"

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function boxed(el: HTMLElement, hasBox: boolean): HTMLElement {
  el.getClientRects = () => (hasBox ? [{}] : []) as unknown as DOMRectList
  return el
}

describe("resolveVisibleAnchor", () => {
  // Walk D53: support's approve step ringed the note's approval card, the
  // first one on the page. An anchor pinned to an id finds only that element.
  it("an anchor pinned to an id resolves to the element carrying it, never the first one", () => {
    const first = boxed(document.createElement("div"), true)
    first.dataset.testid = "card"
    first.dataset.approvalId = "note-approval"
    const draft = boxed(document.createElement("div"), true)
    draft.dataset.testid = "card"
    draft.dataset.approvalId = "draft-approval"
    document.body.append(first, draft)
    expect(resolveVisibleAnchor("card[data-approval-id=draft-approval]")).toBe(draft)
    expect(resolveVisibleAnchor("card[data-approval-id=gone]")).toBeNull()
    // Unresolved (nothing recorded yet): it points at nothing.
    expect(resolveVisibleAnchor("card[data-approval-id={routine-draft}]")).toBeNull()
  })

  // Walk 2026-10-26: sales' CRM step waited on a CRM-write card the run never
  // staged (it staged a contact note). A pin listing values prefers them in order.
  it("a pin listing values resolves the first value any visible element carries", () => {
    const fetch = boxed(document.createElement("div"), true)
    fetch.dataset.testid = "card"
    fetch.dataset.toolName = "kernel:web_fetch"
    const reply = boxed(document.createElement("div"), true)
    reply.dataset.testid = "card"
    reply.dataset.toolName = "mail:reply"
    const note = boxed(document.createElement("div"), true)
    note.dataset.testid = "card"
    note.dataset.toolName = "kernel:contacts_write"
    document.body.append(fetch, reply, note)
    const anchor = "card[data-tool-name=crm:write|kernel:contacts_write|mail:reply]"
    expect(resolveVisibleAnchor(anchor)).toBe(note)
    const values = ["crm:write", "kernel:contacts_write", "mail:reply"]
    expect(resolveVisibleAnchor("card", document, { attr: "data-tool-name", value: values })).toBe(
      note,
    )
    note.remove()
    expect(resolveVisibleAnchor(anchor)).toBe(reply)
    reply.remove()
    expect(resolveVisibleAnchor(anchor)).toBeNull()
  })

  // Walk 2026-10-26: the breakdown step ringed the turn's first element while
  // the person read its summary. A turn's elements resolve to the newest.
  it("an anchor pinned to a turn resolves to that turn's newest element", () => {
    const early = boxed(document.createElement("div"), true)
    early.dataset.testid = "agent-answer"
    early.dataset.turnId = "ask-1"
    const latest = boxed(document.createElement("div"), true)
    latest.dataset.testid = "agent-answer"
    latest.dataset.turnId = "ask-1"
    const other = boxed(document.createElement("div"), true)
    other.dataset.testid = "agent-answer"
    other.dataset.turnId = "ask-2"
    document.body.append(early, latest, other)
    expect(resolveVisibleAnchor("agent-answer[data-turn-id=ask-1]")).toBe(latest)
    expect(
      resolveVisibleAnchor("agent-answer", document, { attr: "data-turn-id", value: "ask-1" }),
    ).toBe(latest)
    // Any other pin keeps the first match.
    expect(resolveVisibleAnchor("agent-answer")).toBe(early)
  })

  it("skips a copy inside a display:none tab and returns the visible one", () => {
    const hiddenTab = document.createElement("div")
    hiddenTab.style.display = "none"
    const hiddenCopy = boxed(document.createElement("button"), true)
    hiddenCopy.dataset.testid = "x"
    hiddenTab.append(hiddenCopy)
    const visible = boxed(document.createElement("button"), true)
    visible.dataset.testid = "x"
    document.body.append(hiddenTab, visible)
    expect(resolveVisibleAnchor("x")).toBe(visible)
  })

  // The sales scenario's customer card counted as shown while it was still
  // looking the sender up (D12): an element still loading is not there yet.
  it("an element still loading (aria-busy) is not there yet", () => {
    const card = boxed(document.createElement("section"), true)
    card.dataset.testid = "customer-card"
    card.setAttribute("aria-busy", "true")
    document.body.append(card)
    expect(resolveVisibleAnchor("customer-card")).toBeNull()
    card.removeAttribute("aria-busy")
    expect(resolveVisibleAnchor("customer-card")).toBe(card)
  })

  it("skips an element with no box and returns null when none is visible", () => {
    const noBox = boxed(document.createElement("button"), false)
    noBox.dataset.testid = "y"
    document.body.append(noBox)
    expect(resolveVisibleAnchor("y")).toBeNull()
    expect(resolveVisibleAnchor("missing")).toBeNull()
  })

  it("a prefix* target resolves the first visible element whose testid starts with it", () => {
    const hidden = boxed(document.createElement("div"), false)
    hidden.dataset.testid = "row-1"
    const shown = boxed(document.createElement("div"), true)
    shown.dataset.testid = "row-2"
    const other = boxed(document.createElement("div"), true)
    other.dataset.testid = "rowboat"
    document.body.append(other, hidden, shown)
    expect(resolveVisibleAnchor("row-*")).toBe(shown)
    expect(resolveVisibleAnchor("row-2")).toBe(shown)
    expect(resolveVisibleAnchor("col-*")).toBeNull()
  })

  it("finds the editable inside a wrapper", () => {
    const wrap = document.createElement("div")
    const editor = document.createElement("div")
    editor.setAttribute("contenteditable", "true")
    wrap.append(editor)
    expect(editableTarget(wrap)).toBe(editor)
    const ta = document.createElement("textarea")
    expect(editableTarget(ta)).toBe(ta)
  })
})
