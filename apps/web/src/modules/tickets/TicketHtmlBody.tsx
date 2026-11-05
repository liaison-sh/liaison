// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { EMAIL_HTML_CLASS } from "~/lib/email-html"
import { fetchInlineObjectUrl } from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

// CID-rewritten inline attachments point at the authed streaming route.
const INLINE_SRC = /\/api\/files\/([^/"?]+)\/inline\b/

// A remote image in a customer's email is a tracking pixel waiting to fire: the
// browser would fetch it the moment a support agent opens the ticket, telling
// the sender their IP and when they looked.
const REMOTE_SRC = /^(?:https?:)?\/\//i

/**
 * Synchronously strip inline-file image `src`s (moving the file id to a
 * `data-file-id` attribute) so the browser never fires a native, un-authed
 * request for them — `/api/files/:id/inline` sits behind Bearer auth that a
 * native `<img>` load can't satisfy, so it would 401 into a broken image. The
 * bytes are streamed in afterwards via the authed client. Non-inline images
 * (ordinary remote `https://` srcs) are NOT loaded either: the src moves to
 * `data-remote-src` and is only fetched, through the authenticated mail image
 * proxy (never directly), after the agent clicks "load images".
 */
function prepareInlineHtml(html: string): string {
  if (typeof document === "undefined") return html
  const tpl = document.createElement("template")
  tpl.innerHTML = html
  let changed = false
  for (const img of tpl.content.querySelectorAll("img")) {
    // Images must never gate the text paint: defer offscreen loads and
    // decode off the main thread so a 68-message thread's inline images
    // don't contend with rendering the readable content.
    img.setAttribute("loading", "lazy")
    img.setAttribute("decoding", "async")
    changed = true
    const rawSrc = img.getAttribute("src")?.trim() ?? ""
    if (REMOTE_SRC.test(rawSrc)) {
      img.setAttribute("data-remote-src", rawSrc.startsWith("//") ? `https:${rawSrc}` : rawSrc)
      img.removeAttribute("src")
      continue
    }
    const m = rawSrc.match(INLINE_SRC)
    if (!m) continue
    img.setAttribute("data-file-id", m[1])
    // Template content is inert, so removing the src here fires no request.
    img.removeAttribute("src")
  }
  return changed ? tpl.innerHTML : html
}

interface Props {
  html: string
  class?: string
  testId?: string
  /** Clicked a body image — receives the resolved src and its file id (null
   *  for non-inline/remote images that carry no `data-file-id`). */
  onImageClick?: (src: string, fileId: string | null) => void
}

/**
 * Renders server-sanitized ticket HTML, streaming any CID-embedded inline image
 * (`/api/files/:id/inline`) through the authed client into a blob URL so it
 * actually displays. Images are click-to-zoom via {@link Props.onImageClick}.
 *
 * The neutralized markup is bound declaratively (so text renders synchronously);
 * the blob swap runs in an effect after the DOM is in place. A superseded run
 * (the html changed while a fetch was in flight) revokes its own late URLs.
 */
export const TicketHtmlBody: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [remoteLoaded, setRemoteLoaded] = createSignal(false)
  let container: HTMLDivElement | undefined
  let objectUrls: string[] = []
  let runId = 0

  const revokeAll = () => {
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls = []
  }
  onCleanup(revokeAll)

  const prepared = createMemo(() => prepareInlineHtml(props.html))
  const hasRemoteImages = createMemo(() => /data-remote-src=/.test(prepared()))

  // A different message starts blocked again.
  createEffect(
    on(
      () => props.html,
      () => setRemoteLoaded(false),
      { defer: true },
    ),
  )

  createEffect(
    on([prepared, remoteLoaded] as const, ([, loaded]) => {
      const el = container
      if (!el || !loaded) return
      const myRun = runId
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>("img[data-remote-src]"))) {
        const remote = img.dataset.remoteSrc
        if (!remote || !/^https:\/\//i.test(remote)) continue
        void api
          .rawGet(`/mail/image-proxy?url=${encodeURIComponent(remote)}`)
          .then(async (res) => {
            if (!res.ok) return
            const url = URL.createObjectURL(await res.blob())
            if (myRun !== runId) {
              URL.revokeObjectURL(url)
              return
            }
            objectUrls.push(url)
            img.setAttribute("src", url)
          })
          .catch(() => {
            // Blocked or unreachable: the image stays blank, the message still reads.
          })
      }
    }),
  )

  createEffect(
    on(prepared, () => {
      const myRun = ++runId
      revokeAll()
      const el = container
      if (!el) return
      // createEffect runs after render effects, so the (declarative) innerHTML
      // is already applied and these nodes exist.
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>("img[data-file-id]"))) {
        const id = img.dataset.fileId
        if (!id) continue
        void fetchInlineObjectUrl(api, id)
          .then((url) => {
            if (myRun !== runId) {
              // A newer run superseded this fetch — it owns neither this element
              // nor the tracked array anymore, so revoke immediately.
              URL.revokeObjectURL(url)
              return
            }
            objectUrls.push(url)
            img.setAttribute("src", url)
          })
          .catch(() => {
            // Leave the image blank; the rest of the message still reads.
          })
      }
    }),
  )

  const onClick = (e: MouseEvent) => {
    const t = e.target
    if (t instanceof HTMLImageElement) {
      const src = t.currentSrc || t.src
      if (src) props.onImageClick?.(src, t.dataset.fileId ?? null)
    }
  }

  return (
    <>
      <Show when={hasRemoteImages() && !remoteLoaded()}>
        <div
          data-testid="ticket-body-image-banner"
          class="mb-2 flex items-center gap-2 rounded bg-surface-hover px-3 py-1.5 text-xs text-text-secondary"
        >
          <span>{i18n.t("mail.imagesFromThisSenderAreHidden")}</span>
          <button
            type="button"
            data-testid="ticket-body-load-images"
            class="text-accent hover:underline"
            onClick={() => setRemoteLoaded(true)}
          >
            {i18n.t("mail.loadImages")}
          </button>
        </div>
      </Show>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated click-to-zoom for images inside sanitized customer HTML, not a focusable control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only zoom affordance; the file stays reachable via the lightbox download / attachment strip */}
      <div
        ref={(el) => {
          container = el
        }}
        data-testid={props.testId}
        class={cn(EMAIL_HTML_CLASS, props.class)}
        onClick={onClick}
        innerHTML={prepared()}
      />
    </>
  )
}
