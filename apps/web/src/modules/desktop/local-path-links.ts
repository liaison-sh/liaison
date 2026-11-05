// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LOCAL PATHS IN A MESSAGE, AS LINKS THE SHELL OPENS (desktop only).
//
// An agent running on this computer names the files it wrote, and the person
// used to go and find them by hand. In the desktop app the rendered message is
// walked once, after sanitizing, and every path on this computer becomes a
// link: a click asks the shell to open it (`openLocalPath`), and the shell is
// what decides a program is revealed in its folder rather than run.
//
// What becomes a link (the detection rules are `lib/local-paths.ts`):
//
//   - a path in prose, absolute only;
//   - inline code that is a path, as a whole (spaces allowed);
//   - a code block whose ONLY line is a path. A block with anything else in
//     it is code, and a path inside code is part of that code: it stays text;
//   - a markdown link whose target is a path or a `file://` URL (the
//     renderer marks it, `markLocalPathLink` below);
//   - a RELATIVE path in inline code, a one line block or a link target, only
//     when this conversation's local session has a folder to resolve it in.
//
// The link text is exactly what the agent wrote; the tooltip is the full path
// the shell will be asked for. With no shell (a browser), none of this runs
// and the markup is what it always was.

import { delimitedLocalPath, findLocalPaths } from "~/lib/local-paths"
import { tNow } from "~/modules/i18n/i18n-context"
import { canOpenLocalPaths, openLocalPath } from "./desktop-store"

/** The attribute that carries the path a link opens. */
export const LOCAL_PATH_ATTRIBUTE = "data-local-path"
/** The class every local path link wears. */
export const LOCAL_PATH_CLASS = "local-path-link"
/** The class of the small notice a click leaves when the path is not there. */
export const LOCAL_PATH_NOTICE_CLASS = "local-path-notice"

/** Everything inside which a path is never linked: already a link, a mention, or code. */
const SKIP_TEXT_INSIDE = "a, pre, code, [data-mention-ref]"

/**
 * THE MARKDOWN LINKS ONE RENDER MARKED AS LOCAL PATHS. The renderer runs
 * before the sanitizer, which would drop a non http href, so each link it
 * marks carries only a class naming this render's random nonce and the
 * link's index; the target itself stays here, and it is always one that went
 * through `localPathFromHref`. An agent writing raw HTML that imitates a local
 * path link cannot know the nonce, so its anchor is never decorated.
 */
export interface LocalPathMarks {
  nonce: string
  targets: string[]
}

function randomToken(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function newLocalPathMarks(): LocalPathMarks {
  return { nonce: randomToken(), targets: [] }
}

/**
 * THE CLASS ONLY THIS PASS PUTS ON A LINK, random per page load. The sanitizer
 * keeps `data-*` attributes (DOMPurify's default, which other surfaces may
 * rely on), so a message's raw HTML can carry `data-local-path` of its own.
 * Every incoming one is stripped, and the click acts only on an element that
 * also wears this class, which no message can know in advance.
 */
const OWNED_CLASS = `local-path-owned-${randomToken()}`

/** The HTML one marked link renders as, before sanitizing. */
export function markLocalPathLink(
  marks: LocalPathMarks,
  target: string,
  innerHtml: string,
): string {
  const index = marks.targets.push(target) - 1
  return `<a class="lpmark-${marks.nonce}-${index}">${innerHtml}</a>`
}

function makeLink(target: string, doc: Document): HTMLAnchorElement {
  const link = doc.createElement("a")
  decorate(link, target)
  return link
}

function decorate(link: HTMLAnchorElement, target: string): void {
  link.setAttribute("href", "#")
  link.setAttribute("class", `${LOCAL_PATH_CLASS} ${OWNED_CLASS}`)
  link.setAttribute(LOCAL_PATH_ATTRIBUTE, target)
  link.setAttribute("title", target)
  // Not a web link: the sanitizer's `_blank` and `rel` mean nothing here.
  link.removeAttribute("target")
  link.removeAttribute("rel")
}

/** Wraps one text node, whole, in a link to `target`. */
function wrapText(node: Text, target: string): void {
  const link = makeLink(target, node.ownerDocument)
  node.replaceWith(link)
  link.append(node)
}

/** The only text node inside an element, or null when it holds anything else. */
function soleText(element: Element): Text | null {
  const nodes = Array.from(element.childNodes)
  if (nodes.length === 1 && nodes[0].nodeType === Node.TEXT_NODE) return nodes[0] as Text
  if (nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE) {
    return soleText(nodes[0] as Element)
  }
  return null
}

function linkifyTextNode(node: Text): void {
  const text = node.data
  const matches = findLocalPaths(text)
  if (matches.length === 0) return
  const doc = node.ownerDocument
  const fragment = doc.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) fragment.append(text.slice(cursor, match.start))
    const link = makeLink(match.target, doc)
    link.textContent = match.text
    fragment.append(link)
    cursor = match.end
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  node.replaceWith(fragment)
}

/**
 * TURNS THE LOCAL PATHS IN SANITIZED MESSAGE HTML INTO LINKS. Runs after the
 * sanitizer, and builds every node it adds through the DOM, so nothing it
 * writes is ever parsed as markup. `base` is this conversation's session
 * folder, or null.
 */
export function linkifyLocalPaths(
  safeHtml: string,
  base: string | null = null,
  marks: LocalPathMarks | null = null,
): string {
  const template = document.createElement("template")
  template.innerHTML = safeHtml
  const root = template.content

  // Nothing that arrived in the message is a local path link: raw HTML that
  // borrows the class is stripped of it before this pass adds its own.
  // The same goes for the attribute the click reads.
  for (const element of Array.from(
    root.querySelectorAll(`.${LOCAL_PATH_CLASS}, .${OWNED_CLASS}, [${LOCAL_PATH_ATTRIBUTE}]`),
  )) {
    element.classList.remove(LOCAL_PATH_CLASS, OWNED_CLASS)
    if (element.getAttribute("class") === "") element.removeAttribute("class")
    element.removeAttribute(LOCAL_PATH_ATTRIBUTE)
  }

  // Links the renderer marked in THIS render (a markdown link to a path).
  if (marks) {
    const prefix = `lpmark-${marks.nonce}-`
    for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[class]"))) {
      const mark = Array.from(link.classList).find((name) => name.startsWith(prefix))
      if (!mark) continue
      const target = marks.targets[Number(mark.slice(prefix.length))]
      if (target) decorate(link, target)
    }
  }

  // A code block whose only line is a path.
  for (const block of Array.from(root.querySelectorAll("pre"))) {
    if (block.querySelector("a")) continue
    const text = soleText(block)
    const target = text ? delimitedLocalPath(text.data, base) : null
    if (text && target) wrapText(text, target)
  }

  // Inline code that is a path, as a whole.
  for (const code of Array.from(root.querySelectorAll("code"))) {
    if (code.closest("pre, a")) continue
    const text = soleText(code)
    const target = text ? delimitedLocalPath(text.data, base) : null
    if (text && target) wrapText(text, target)
  }

  // Paths in prose.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.parentElement?.closest(SKIP_TEXT_INSIDE) ?? false)) texts.push(node as Text)
  }
  for (const text of texts) linkifyTextNode(text)

  return template.innerHTML
}

/** Where the notice goes: after the code or block the link sits in. */
function noticeAnchor(link: Element): Element {
  return link.closest("pre") ?? (link.parentElement?.tagName === "CODE" ? link.parentElement : link)
}

function showNotice(link: Element, message: string | null): void {
  const anchor = noticeAnchor(link)
  const existing = anchor.nextElementSibling?.classList.contains(LOCAL_PATH_NOTICE_CLASS)
    ? anchor.nextElementSibling
    : null
  if (message === null) {
    existing?.remove()
    return
  }
  const notice = existing ?? document.createElement("span")
  notice.className = LOCAL_PATH_NOTICE_CLASS
  notice.setAttribute("role", "status")
  notice.textContent = message
  if (!existing) anchor.after(notice)
}

/**
 * THE CLICK. Answers true when the click was on a local path link (and is
 * therefore handled here), false for anything else. The shell opens the path,
 * or reveals it when it is a program; a path that is not on this computer
 * leaves a small notice beside the link rather than failing in silence.
 */
export function handleLocalPathClick(event: MouseEvent): boolean {
  // Only a link this pass made: its class is one no message can know.
  const link = (event.target as Element | null)?.closest?.(
    `a.${OWNED_CLASS}[${LOCAL_PATH_ATTRIBUTE}]`,
  )
  if (!link) return false
  event.preventDefault()
  event.stopPropagation()
  const path = link.getAttribute(LOCAL_PATH_ATTRIBUTE)
  if (!path || !canOpenLocalPaths()) return true
  void openLocalPath(path).then((outcome) => {
    if (outcome === "not_found") showNotice(link, tNow("kernel.desktopUi.localPath.notFound"))
    else if (outcome === "network") showNotice(link, tNow("kernel.desktopUi.localPath.network"))
    else if (outcome === "failed") showNotice(link, tNow("kernel.desktopUi.localPath.failed"))
    else showNotice(link, null)
  })
  return true
}
