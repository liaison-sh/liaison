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

/** The note as safe HTML: marked, then the app's sanitizer, then app paths made links again. */
export function renderNote(markdown: string): string {
  const html = noteMarked.parse(markdown, { async: false }) as string
  const safe = sanitizeHtml(html)
  if (typeof DOMParser === "undefined") return safe
  const doc = new DOMParser().parseFromString(`<div>${safe}</div>`, "text/html")
  const root = doc.body.firstElementChild as HTMLElement
  for (const a of Array.from(root.querySelectorAll("a[data-mention-ref]"))) {
    const path = a.getAttribute("data-mention-ref") ?? ""
    a.removeAttribute("data-mention-ref")
    a.removeAttribute("target")
    a.removeAttribute("rel")
    if (isAppPath(path)) {
      a.setAttribute("href", path)
      a.setAttribute("data-app-path", "true")
    }
  }
  return root.innerHTML
}

export const TextBlock: Component<{ markdown: string }> = (props) => {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[data-app-path]")
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return
    const href = a.getAttribute("href")
    if (!href || !isAppPath(href)) return
    e.preventDefault()
    spaNavigate(href)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegation only; the links inside take the keyboard
    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter on a link inside fires this same click
    <div
      data-testid="block-text"
      class="prose-thread min-w-0 text-[13px] text-text-secondary"
      onClick={onClick}
      innerHTML={renderNote(props.markdown)}
    />
  )
}
