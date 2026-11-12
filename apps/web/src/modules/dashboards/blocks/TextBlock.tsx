// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A note on a dashboard: its markdown, rendered and sanitized like every text
// the app shows (lib/sanitize.ts, the one approved path). Raw HTML in the note
// is shown as text, never as markup. Links go to the web (http, https) in a new
// tab, or to a page of the app ("/projects"), opened in place.
import { Marked } from "marked"
import type { Component } from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import { sanitizeHtml } from "~/lib/sanitize"
import { isAppPath } from "../dashboards-client"

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// The app paths of the note being rendered, in order. A link to one carries only its index
// (`data-mention-ref="0"`): the path opened is always the one written in the note, never text
// read back from the page.
let collecting: string[] | null = null

// Raw HTML (a block or inline) reads as the text it is. An app path cannot pass the sanitizer
// as an href (web links only), so its link carries the index of the path instead.
const noteMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escapeHtml(token.text)
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens)
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ""
      if (collecting && isAppPath(token.href)) {
        collecting.push(token.href)
        return `<a data-mention-ref="${collecting.length - 1}"${title}>${text}</a>`
      }
      return `<a href="${escapeHtml(token.href)}"${title}>${text}</a>`
    },
    image(token) {
      return escapeHtml(token.text)
    },
  },
})

export interface RenderedNote {
  html: string
  /** The note's app paths; a link names one by its index. */
  paths: string[]
}

/**
 * The note as safe HTML: marked, then the app's sanitizer. An app path never becomes an href
 * (the sanitizer keeps web links only): its link is made reachable (focus, role) here, and the
 * note's own handler opens the path it names.
 */
export function renderNote(markdown: string): RenderedNote {
  const paths: string[] = []
  collecting = paths
  let html: string
  try {
    html = noteMarked.parse(markdown, { async: false }) as string
  } finally {
    collecting = null
  }
  const safe = sanitizeHtml(html)
  if (typeof DOMParser === "undefined") return { html: safe, paths }
  const doc = new DOMParser().parseFromString(`<div>${safe}</div>`, "text/html")
  const root = doc.body.firstElementChild as HTMLElement
  for (const a of Array.from(root.querySelectorAll("a[data-mention-ref]"))) {
    a.removeAttribute("target")
    a.removeAttribute("rel")
    a.setAttribute("role", "link")
    a.setAttribute("tabindex", "0")
  }
  return { html: root.innerHTML, paths }
}

export const TextBlock: Component<{ markdown: string }> = (props) => {
  const note = () => renderNote(props.markdown)
  /** The note's path the click or key landed on, or null. */
  const pathAt = (target: EventTarget | null): string | null => {
    const a = (target as HTMLElement | null)?.closest?.("a[data-mention-ref]")
    const index = Number.parseInt(a?.getAttribute("data-mention-ref") ?? "", 10)
    const path = Number.isInteger(index) ? note().paths[index] : undefined
    return path !== undefined && isAppPath(path) ? path : null
  }
  const open = (e: Event) => {
    const path = pathAt(e.target)
    if (!path) return
    e.preventDefault()
    spaNavigate(path)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegation only; the links inside take the keyboard
    <div
      data-testid="block-text"
      class="prose-thread min-w-0 text-[13px] text-text-secondary"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e)
      }}
      innerHTML={note().html}
    />
  )
}
