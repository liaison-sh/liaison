// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Resolve a tour anchor (a `data-testid`) to the element a person can SEE.
 * Tabs are keep-alive (inactive ones stay mounted under `display: none`), so a
 * testid often matches several elements and the first one in document order is
 * frequently a hidden tab's. Shared by the spotlight and the ghost cursor so
 * both point at the same element.
 */

function hasHiddenAncestor(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (style && (style.display === "none" || style.visibility === "hidden")) return true
    node = node.parentElement
  }
  return false
}

/**
 * The first element (for a turn's answer, the newest) carrying `testid`
 * (or, for `prefix*`, a testid starting with the prefix), and `where.attr` = `where.value`
 * when given (on the element or the nearest enclosing element carrying `where.attr`), that is
 * rendered (has a box), not inside a hidden subtree and not still loading
 * (`aria-busy="true"`: a customer card still looking the sender up is not
 * yet what a beat points at).
 */
/**
 * `testid[data-attr=value]`: a beat anchor pinned to the element carrying a
 * recorded id. A fixed pin may list values in order of preference
 * (`approval-card[data-tool-name=a|b]`): the first value any visible element
 * carries wins.
 */
const PINNED_ANCHOR_RE = /^([^[\]]+)\[(data-[a-z][a-z0-9-]*)=([^\]]+)\]$/

export function resolveVisibleAnchor(
  anchor: string,
  root: ParentNode = document,
  /**
   * Only an element whose `attr` is exactly `value` (a tour step's
   * created-entity pin), or, for a list, one of the values in that order of
   * preference.
   */
  pin?: AnchorPin,
): HTMLElement | null {
  // A turn's answer (`agent-answer[data-turn-id=…]`): the newest. A request
  // whose answer came after an approval has two, and the step follows the
  // agent's latest output. Its tool rows keep the first match (the search).
  const pinned = PINNED_ANCHOR_RE.exec(anchor)
  const latest =
    (pinned?.[1] ?? anchor) === LATEST_ANSWER && (pin?.attr ?? pinned?.[2]) === "data-turn-id"
  let found: HTMLElement | null = null
  for (const el of visibleMatches(anchor, root, pin)) {
    found = el
    if (!latest) break
  }
  return found
}

/**
 * A beat anchor pinned to a turn (`tool-call-row[data-turn-id=…]`) that the
 * agent works on past that turn: the latest element of the same kind in that
 * turn's conversation, at or after the turn's first one. The person may have
 * answered the agent's question ("go ahead") and the step is done in that
 * later turn; its rows carry the reply's id, so the pin alone would keep the
 * first row of the asked turn, long scrolled out of sight. Any other anchor
 * resolves as `resolveVisibleAnchor` does.
 */
export function resolveLatestFromTurn(
  anchor: string,
  root: ParentNode = document,
): HTMLElement | null {
  const first = resolveVisibleAnchor(anchor, root)
  const pinned = PINNED_ANCHOR_RE.exec(anchor)
  if (!first || pinned?.[2] !== "data-turn-id") return first
  const list = first.closest<HTMLElement>(`[data-testid="${CONVERSATION_LIST}"]`)
  if (!list) return first
  let found = first
  for (const el of visibleMatches(pinned[1]!, list)) {
    if (first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = el
  }
  return found
}

/** A conversation's message list (`MessageList`): the scope a turn's later rows are looked for in. */
const CONVERSATION_LIST = "message-scroll-container"

/** An attribute an element must carry: one value, or several in order of preference. */
export interface AnchorPin {
  attr: string
  value: string | readonly string[]
}

/** The testid of an agent turn's answer: a step pinned to it follows the newest. */
const LATEST_ANSWER = "agent-answer"

/**
 * Every element `resolveVisibleAnchor` could return, in document order: a
 * beat that rings a group (`anchorAll`, the rows of the subtasks just made).
 */
export function resolveVisibleAnchors(anchor: string, root: ParentNode = document): HTMLElement[] {
  return [...visibleMatches(anchor, root)]
}

function* visibleMatches(
  anchor: string,
  root: ParentNode,
  pin?: AnchorPin,
): Generator<HTMLElement> {
  // A beat anchor may carry its pin in the string (`approval-card[data-request-id=…]`).
  const pinned = pin ? null : PINNED_ANCHOR_RE.exec(anchor)
  const testid = pinned ? pinned[1]! : anchor
  const where: AnchorPin | undefined = pinned
    ? { attr: pinned[2]!, value: pinned[3]!.split("|") }
    : pin
  // `rows-*`: the first visible element whose testid starts with `rows-`.
  const base = testid.endsWith("*")
    ? `[data-testid^="${CSS.escape(testid.slice(0, -1))}"]`
    : `[data-testid="${CSS.escape(testid)}"]`
  // A pin holds on the element itself or on the nearest enclosing element
  // carrying the attribute: a card's Approve button is pinned by the card's
  // `data-tool-name` (the card is the unit, its controls do not each repeat
  // it). The nearest carrier decides, so a card nested in another kind never
  // borrows its container's value.
  const candidates: Array<{ selector: string; value?: string }> = !where
    ? [{ selector: base }]
    : (typeof where.value === "string" ? [where.value] : where.value).map((value) => {
        const attr = `[${where.attr}="${CSS.escape(value)}"]`
        return { selector: `${base}${attr}, ${attr} ${base}`, value }
      })
  // In order of preference: every match of the first value, then the next.
  for (const { selector, value } of candidates) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      if (
        where &&
        value !== undefined &&
        el.closest(`[${where.attr}]`)?.getAttribute(where.attr) !== value
      )
        continue
      if (el.getClientRects().length === 0) continue
      if (el.getAttribute("aria-busy") === "true") continue
      if (hasHiddenAncestor(el)) continue
      yield el
    }
  }
}

/**
 * Where typing should go for an anchor: the element itself when it is
 * editable, else its first editable descendant (a composer wrapper carrying
 * the testid around its textarea or ProseMirror editor).
 */
export function editableTarget(el: HTMLElement): HTMLElement | null {
  if (isEditable(el)) return el
  return el.querySelector<HTMLElement>(
    'textarea, input:not([type="hidden"]):not([type="file"]), [contenteditable="true"], [contenteditable=""]',
  )
}

export function isEditable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return el.type !== "hidden" && el.type !== "file"
  if (!(el instanceof HTMLElement)) return false
  // jsdom has no isContentEditable; the attribute is the same truth there.
  return el.isContentEditable === true || el.getAttribute("contenteditable") === "true"
}
