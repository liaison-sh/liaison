// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { accessToken } from "~/modules/auth/auth-store"
import { installExternalLinkHandler } from "~/modules/desktop/external-links"
import { ImageLightbox } from "~/modules/files/ImageLightbox"
import { useI18n } from "~/modules/i18n/i18n-context"
import { allowSenderImageDomain, isSenderImageAllowed } from "~/modules/mail/mail-account-store"
import { prepareMailHtml, sanitizeInlineStyle } from "~/modules/mail/mail-sanitize"
import { useApi } from "~/modules/shell/ApiContext"

interface MailMessageRendererProps {
  accountId: string | null
  htmlBody: string | null
  textBody: string | null
  senderDomain: string
  /** Only the first blockquote level keeps its rail and indent: the "Show
   *  original" view of a folded quoted chain, which otherwise nests one rail
   *  per earlier email. */
  flattenQuotes?: boolean
}

export const SHADOW_BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  body { font-family: var(--font-sans, sans-serif); color: var(--color-text, #1a1a1a); background: transparent; line-height: 1.5; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: var(--color-accent, #2563eb); }
  blockquote { border-left: 3px solid var(--color-border, #d1d5db); margin-left: 0; padding-left: 12px; color: var(--color-text-secondary, #6b7280); }
`

/** Nested quote levels lose their indent; `!important` beats the inline
 *  margin and border most mail clients write on each blockquote. */
export const FLAT_QUOTES_CSS = `
  blockquote blockquote { margin-left: 0 !important; padding-left: 0 !important; border-left: 0 !important; }
`

export function htmlHasImages(html: string | null): boolean {
  if (!html) return false
  return /<img\s/i.test(html)
}

/**
 * The policy every email document carries. Message content is untrusted, and the
 * regex CSS filter in mail-sanitize cannot name every way CSS loads a resource
 * (escaped identifiers, `image-set()` with a string, ...). This makes the
 * "images stay hidden until you click" promise the browser's rule, not the
 * filter's: nothing but the app's own origin (inline-attachment and image-proxy
 * routes), blob: and data: images can load; no fonts, frames, media or scripts.
 */
export const MAIL_DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob: data:"

export function buildMailHtmlDocument(
  content: string,
  themeCss = "",
  bodyCss = "",
  bodyClass = "",
  extraCss = "",
): string {
  const bodyStyle = bodyCss ? `<style>body { ${bodyCss} }</style>` : ""
  const classAttr = bodyClass ? ` class="${escapeHtml(bodyClass)}"` : ""
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_DOCUMENT_CSP}"><base target="_blank"><style>${themeCss}${SHADOW_BASE_CSS}${extraCss}</style>${bodyStyle}</head><body${classAttr}>${content}</body></html>`
}

export function extractBodyCss(raw: string | null): string {
  if (!raw || typeof DOMParser === "undefined") return ""
  const doc = new DOMParser().parseFromString(raw, "text/html")
  const body = doc.body
  const rules: string[] = []
  const style = body.getAttribute("style")?.trim()
  const align = body.getAttribute("align")?.trim()
  const bgcolor = body.getAttribute("bgcolor")?.trim()

  if (style) {
    const safe = sanitizeInlineStyle(style)
    if (safe) rules.push(safe)
  }
  if (align && /^(left|right|center)$/i.test(align))
    rules.push(`text-align: ${align.toLowerCase()}`)
  if (bgcolor && /^#[0-9a-f]{3,8}$/i.test(bgcolor)) rules.push(`background-color: ${bgcolor}`)

  return rules.join("; ")
}

export function extractBodyClass(raw: string | null): string {
  if (!raw || typeof DOMParser === "undefined") return ""
  const doc = new DOMParser().parseFromString(raw, "text/html")
  return (
    doc.body
      .getAttribute("class")
      ?.replace(/[\r\n<>"']/g, " ")
      .trim() ?? ""
  )
}

/** A colour value that sets no colour of its own. */
const NEUTRAL_COLOR_VALUE = /^(?:inherit|initial|unset|revert|currentcolor|transparent|none)\b/i
/** A `color`, `background-color` or `background` declaration (not `border-color`,
 *  not `color-scheme`, not a custom property), capturing its value. */
const COLOR_DECL_RE = /(?:^|[;{\s])(?:color|background-color|background)\s*:\s*([^;}]*)/gi
const STYLE_ATTR_RE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
/** Presentational colour attributes: `bgcolor` on any element, `color` on
 *  `<font>`, `text` on a body. Text content cannot match: a serialized `<` in
 *  text is `&lt;`. */
const COLOR_ATTR_RE =
  /<(?:[a-z][\w-]*\b[^>]*?\sbgcolor|font\b[^>]*?\scolor|body\b[^>]*?\stext)\s*=\s*["']?\s*[#\w]/i

function cssSetsColor(css: string): boolean {
  for (const m of css.matchAll(COLOR_DECL_RE)) {
    const value = m[1].trim()
    // A stripped `url(...)` leaves a comment, not a colour.
    if (value && !value.startsWith("/*") && !NEUTRAL_COLOR_VALUE.test(value)) return true
  }
  return false
}

/**
 * Whether an email sets its OWN text or background colours: an inline style,
 * a `<style>` rule, `bgcolor` or `<font color>`. Such an email was designed
 * against a light page (most hard-code dark text and no background), so it is
 * shown as authored on a white sheet, the way webmail shows a designed
 * newsletter; theming it would paint its dark text on the dark theme. A plain
 * email with no colours of its own follows the app's theme.
 *
 * Run once per message on the SANITIZED html (what will actually render) plus
 * the body CSS folded out of the raw `<body>`.
 */
export function mailHasAuthoredColors(sanitizedHtml: string, bodyCss = ""): boolean {
  if (cssSetsColor(bodyCss)) return true
  if (COLOR_ATTR_RE.test(sanitizedHtml)) return true
  for (const m of sanitizedHtml.matchAll(STYLE_ATTR_RE)) {
    if (cssSetsColor(m[1] ?? m[2] ?? "")) return true
  }
  for (const m of sanitizedHtml.matchAll(STYLE_BLOCK_RE)) {
    if (cssSetsColor(m[1])) return true
  }
  return false
}

/**
 * The frame CSS for an email with authored colours: the app's font only, a
 * light colour scheme and a white sheet. Every colour variable is left unset,
 * so SHADOW_BASE_CSS falls back to its light defaults.
 */
export function lightSheetCssFromElement(el: HTMLElement): string {
  const font = getComputedStyle(el).getPropertyValue("--font-sans").trim()
  const fontVar = font ? `--font-sans: ${font}; ` : ""
  return `:root { ${fontVar}color-scheme: light; }\nhtml { background: #ffffff; padding: 12px 16px; }\n`
}

export function themeCssFromElement(el: HTMLElement): string {
  const computed = getComputedStyle(el)
  const vars = [
    "--font-sans",
    "--color-text",
    "--color-bg-surface",
    "--color-accent",
    "--color-border",
    "--color-text-secondary",
  ]
    .map((name) => {
      const value = computed.getPropertyValue(name).trim()
      return value ? `${name}: ${value};` : ""
    })
    .filter(Boolean)
  // The frame's colour scheme follows the app's. A frame whose scheme differs
  // from its host's gets an opaque canvas from the browser: on the dark theme
  // the "transparent" body sat on white, with the theme's light text on it.
  const scheme = computed.colorScheme?.trim()
  if (scheme && scheme !== "normal") vars.push(`color-scheme: ${scheme};`)
  return vars.length > 0 ? `:root { ${vars.join(" ")} }\n` : ""
}

function replaceImagesWithPlaceholders(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(
      /<img\b[^>]*>/gi,
      '<span style="color:#9ca3af;font-style:italic">[Image]</span>',
    )
  }

  const template = document.createElement("template")
  template.innerHTML = html

  for (const img of template.content.querySelectorAll("img")) {
    const alt = img.getAttribute("alt")?.trim()
    const placeholder = document.createElement("span")
    placeholder.textContent = alt ? `[${alt}]` : "[Image]"
    placeholder.setAttribute("style", "color:#9ca3af;font-style:italic")
    img.replaceWith(placeholder)
  }

  return template.innerHTML
}

/**
 * Fetches proxied `<img>` sources and rewrites them to blob URLs.
 *
 * `requestId` + `isCurrent` let a superseded run (the html/theme/token effect
 * re-ran while this fetch was in flight) revoke the blob URLs IT created
 * instead of pushing them into the caller's `objectUrls` array — that array
 * may have already been swapped out for a new one by the newer run, which
 * would otherwise leak every blob URL created by the stale run forever.
 */
async function inlineProxiedImages(
  html: string,
  token: string | null,
  objectUrls: string[],
  requestId: number,
  isCurrent: (requestId: number) => boolean,
): Promise<string> {
  if (
    !token ||
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return html
  const template = document.createElement("template")
  template.innerHTML = html
  const images = Array.from(template.content.querySelectorAll("img"))

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src")?.trim()
      if (!src?.includes("/api/mail/image-proxy?")) return

      try {
        const res = await fetch(src, {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const blob = await res.blob()
        const objectUrl = URL.createObjectURL(blob)
        if (!isCurrent(requestId)) {
          // A newer run superseded this one while the fetch was in flight —
          // this run's array is no longer the one being tracked/revoked on
          // cleanup, so this URL must revoke itself right away.
          URL.revokeObjectURL(objectUrl)
          return
        }
        objectUrls.push(objectUrl)
        img.setAttribute("src", objectUrl)
      } catch {
        // Leave the proxied URL in place so the browser can still attempt a normal load.
      }
    }),
  )

  return template.innerHTML
}

export const MailMessageRenderer: Component<MailMessageRendererProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  let containerRef!: HTMLDivElement
  let iframeRef!: HTMLIFrameElement
  const [imagesLoaded, setImagesLoaded] = createSignal(false)
  const [savingSenderPreference, setSavingSenderPreference] = createSignal(false)
  const [themeCss, setThemeCss] = createSignal("")
  const [lightSheetCss, setLightSheetCss] = createSignal("")
  const [authoredColors, setAuthoredColors] = createSignal(false)
  const [iframeHeight, setIframeHeight] = createSignal(120)
  const [iframeSrcdoc, setIframeSrcdoc] = createSignal(buildMailHtmlDocument(""))
  const [lightboxSrc, setLightboxSrc] = createSignal<string | null>(null)
  let renderRequestId = 0
  // Blob URLs created by the CURRENT (latest-dispatched) render run. Each run
  // owns its own array so a superseded run's late-arriving createObjectURL
  // calls revoke themselves instead of orphaning into whatever array the
  // next run happens to be using (the previous bug: reassigning this to `[]`
  // at the top of every effect run left in-flight fetches from the prior
  // run still pushing into the OLD array reference, which nothing ever
  // revoked).
  let imageObjectUrls: string[] = []

  const imagesAllowed = () =>
    imagesLoaded() || isSenderImageAllowed(props.accountId, props.senderDomain)

  createEffect(
    on(
      () => [props.accountId, props.senderDomain, props.htmlBody, props.textBody] as const,
      () => setImagesLoaded(false),
    ),
  )

  createEffect(
    on(
      () =>
        [
          props.htmlBody,
          props.textBody,
          props.flattenQuotes ? FLAT_QUOTES_CSS : "",
          imagesAllowed(),
          themeCss(),
          lightSheetCss(),
          accessToken(),
        ] as const,
      ([html, text, extraCss, allowed, appTheme, lightSheet, token]) => {
        if (!containerRef) return
        const requestId = ++renderRequestId

        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          for (const objectUrl of imageObjectUrls) URL.revokeObjectURL(objectUrl)
        }
        imageObjectUrls = []

        let theme = appTheme
        setAuthoredColors(false)

        if (!html && !text) {
          setIframeSrcdoc(
            buildMailHtmlDocument(
              `<p style="color: #9ca3af">${escapeHtml(i18n.t("mail.noContent"))}</p>`,
              theme,
              "",
              "",
              extraCss,
            ),
          )
          return
        }

        if (!html) {
          setIframeSrcdoc(
            buildMailHtmlDocument(
              `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text ?? "")}</pre>`,
              theme,
              "",
              "",
              extraCss,
            ),
          )
          return
        }

        let rendered = prepareMailHtml(html)
        const bodyCss = extractBodyCss(html)
        const bodyClass = extractBodyClass(html)
        if (mailHasAuthoredColors(rendered, bodyCss)) {
          theme = lightSheet
          setAuthoredColors(true)
        }

        if (!allowed) {
          rendered = replaceImagesWithPlaceholders(rendered)
          setIframeSrcdoc(buildMailHtmlDocument(rendered, theme, bodyCss, bodyClass, extraCss))
          return
        }

        const runObjectUrls = imageObjectUrls
        void inlineProxiedImages(
          rendered,
          token,
          runObjectUrls,
          requestId,
          (id) => id === renderRequestId,
        ).then((nextRendered) => {
          if (requestId !== renderRequestId) return
          setIframeSrcdoc(buildMailHtmlDocument(nextRendered, theme, bodyCss, bodyClass, extraCss))
        })
      },
    ),
  )

  onCleanup(() => {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const objectUrl of imageObjectUrls) URL.revokeObjectURL(objectUrl)
    }
  })

  onMount(() => {
    setThemeCss(themeCssFromElement(containerRef))
    setLightSheetCss(lightSheetCssFromElement(containerRef))
  })

  // Each srcdoc load is a new document. Its links carry `<base target=_blank>`,
  // which opens nothing in the desktop webview, so the same delegated click
  // handler as the app's own document is installed on it (the iframe is
  // same-origin): on desktop an external link goes to the system browser.
  let removeLinkHandler: (() => void) | null = null
  let linkHandlerDoc: Document | null = null
  onCleanup(() => removeLinkHandler?.())

  function resizeIframe(): void {
    const doc = iframeRef?.contentDocument
    if (!doc) return
    if (linkHandlerDoc !== doc) {
      removeLinkHandler?.()
      removeLinkHandler = installExternalLinkHandler(doc)
      linkHandlerDoc = doc
    }
    const nextHeight = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 80)
    setIframeHeight(nextHeight)

    for (const img of Array.from(doc.images)) {
      img.addEventListener("load", resizeIframe, { once: true })
      img.addEventListener("error", resizeIframe, { once: true })
      // Click any body-embedded image (CID inline, proxied remote) to preview
      // it fullscreen. The iframe is same-origin (sandbox allow-same-origin),
      // so the parent can wire listeners directly; blob:/inline-route srcs
      // resolve identically from the parent document.
      if (!img.dataset.liaisonLightbox) {
        img.dataset.liaisonLightbox = "1"
        img.style.cursor = "zoom-in"
        img.addEventListener("click", () => {
          const src = img.currentSrc || img.src
          if (src) setLightboxSrc(src)
        })
      }
    }
  }

  async function alwaysLoadImagesFromSender(): Promise<void> {
    if (!props.accountId || !props.senderDomain) return
    setSavingSenderPreference(true)
    try {
      await allowSenderImageDomain(api, props.accountId, props.senderDomain)
      setImagesLoaded(true)
    } finally {
      setSavingSenderPreference(false)
    }
  }

  return (
    <div>
      <Show when={htmlHasImages(props.htmlBody) && !imagesAllowed()}>
        <div
          data-testid="mail-image-banner"
          class="flex items-center gap-2 rounded bg-surface-hover px-3 py-1.5 text-xs text-text-secondary mb-2"
        >
          <span>{i18n.t("mail.imagesFromThisSenderAreHidden")}</span>
          <button
            type="button"
            data-testid="mail-load-images"
            class="text-accent hover:underline"
            onClick={() => setImagesLoaded(true)}
          >
            {i18n.t("mail.loadImages")}
          </button>
          <Show when={props.senderDomain}>
            <button
              type="button"
              data-testid="mail-load-images-always"
              class="text-accent hover:underline disabled:opacity-50"
              disabled={savingSenderPreference()}
              onClick={() => void alwaysLoadImagesFromSender()}
            >
              {savingSenderPreference()
                ? i18n.t("kernel.common.saving2")
                : i18n.t("mail.alwaysForThisSender")}
            </button>
          </Show>
        </div>
      </Show>
      <div ref={containerRef!}>
        <iframe
          data-testid="mail-message-body"
          title={i18n.t("mail.emailMessageBody")}
          ref={iframeRef!}
          sandbox="allow-same-origin allow-popups"
          srcdoc={iframeSrcdoc()}
          data-color-source={authoredColors() ? "authored" : "theme"}
          class={
            authoredColors()
              ? "block w-full rounded-md border-0 bg-white"
              : "block w-full border-0 bg-transparent"
          }
          style={{ height: `${iframeHeight()}px` }}
          scrolling="no"
          onLoad={resizeIframe}
        />
      </div>
      <ImageLightbox
        open={lightboxSrc() !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxSrc(null)
        }}
        src={lightboxSrc() ?? undefined}
      />
    </div>
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
