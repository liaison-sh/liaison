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

// Raw HTML (a block or inline) reads as the text it is. An app path cannot pass the sanitizer
// as an href (web links only), so it rides `data-mention-ref` and is restored below.
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
      if (isAppPath(token.href)) {
        return `<a data-mention-ref="${escapeHtml(token.href)}"${title}>${text}</a>`
      }
      return `<a href="${escapeHtml(token.href)}"${title}>${text}</a>`
    },
    image(token) {
      return escapeHtml(token.text)
    },
  },
})

/**
 * The note as safe HTML: marked, then the app's sanitizer. An app path never becomes an href
 * (the sanitizer keeps web links only): it stays in `data-mention-ref`, and the link is made
 * reachable (focus, role) here, with the note's own handler opening it in place.
 */
export function renderNote(markdown: string): string {
  const html = noteMarked.parse(markdown, { async: false }) as string
  const safe = sanitizeHtml(html)
  if (typeof DOMParser === "undefined") return safe
  const doc = new DOMParser().parseFromString(`<div>${safe}</div>`, "text/html")
  const root = doc.body.firstElementChild as HTMLElement
  for (const a of Array.from(root.querySelectorAll("a[data-mention-ref]"))) {
    a.removeAttribute("target")
    a.removeAttribute("rel")
    a.setAttribute("role", "link")
    a.setAttribute("tabindex", "0")
  }
  return root.innerHTML
}

/** The app path a click or a key landed on, checked, or null. */
function appPathAt(target: EventTarget | null): string | null {
  const a = (target as HTMLElement | null)?.closest?.("a[data-mention-ref]")
  const path = a?.getAttribute("data-mention-ref") ?? ""
  return isAppPath(path) ? path : null
}

export const TextBlock: Component<{ markdown: string }> = (props) => {
  const open = (e: Event) => {
    const path = appPathAt(e.target)
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
      innerHTML={renderNote(props.markdown)}
    />
  )
}
