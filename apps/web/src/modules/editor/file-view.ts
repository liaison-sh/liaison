// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a page draws a file token (`![](liaison-file:<id>)`), in the editor and in the
// reader alike: an image as the picture, any other file (an SVG among them) as a
// card with its name, and a file this reader cannot read as a neutral label.
//
// The picture is never given an address of its own: its bytes come through the
// app's authenticated inline route and are shown from a `blob:` URL the app made.
// Anything else handed in as the picture's source is refused, so no page can make
// the browser fetch another host from here.

/** What the files service says of a file the reader can read. */
export interface PageFileInfo {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface FileViewLabels {
  /** A file this reader cannot read, or one that is gone. */
  unavailable: string
  /** While the file is looked up. */
  loading: string
  /** A file card's action, with the file's name: "Download {{name}}". */
  download: (name: string) => string
}

/** What the view needs to draw a file; the page's files service answers it. */
export interface FileViewDeps {
  /** The file, read under the reader's own rights; null when the reader cannot read it. */
  resolve: (id: string) => Promise<PageFileInfo | null>
  /** An object URL (`blob:`) of the picture, fetched through the authenticated route. */
  imageUrl: (id: string) => Promise<string | null>
  /** Open or save a file of a card. */
  open?: (file: PageFileInfo) => void
  labels: FileViewLabels
}

/** A file reference at the start of markdown source, alt text or not; group 1 is the id. */
export const FILE_REF_AT_START =
  /^!\[(?:\\.|[^\]\\])*\]\(liaison-file:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/

/**
 * How wide a page's picture is drawn, stored in the token's alt text so any markdown
 * reader keeps it: `![width=50%](liaison-file:<id>)`. No width (or another alt) is the
 * full line. Only these steps are written; any other value reads as the full line.
 */
export const IMAGE_WIDTHS = { small: 33, medium: 50, large: 75 } as const
export type ImageWidth = keyof typeof IMAGE_WIDTHS | "full"

/** The width a file reference's source (`![<alt>](liaison-file:...)`) asks for. */
export function imageWidthOfRef(raw: string): ImageWidth {
  const alt = /^!\[([^\]]*)\]/.exec(raw)?.[1] ?? ""
  const pct = /^width=(\d{1,3})%$/.exec(alt.trim())?.[1]
  for (const [name, value] of Object.entries(IMAGE_WIDTHS))
    if (String(value) === pct) return name as ImageWidth
  return "full"
}

/** The token for a file at a width. */
export function fileRef(id: string, width: ImageWidth): string {
  return width === "full"
    ? `![](liaison-file:${id})`
    : `![width=${IMAGE_WIDTHS[width]}%](liaison-file:${id})`
}

export function isImageWidth(value: unknown): value is ImageWidth {
  return value === "full" || (typeof value === "string" && value in IMAGE_WIDTHS)
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A file id as a token holds it: a uuid and nothing else. */
export function isFileId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

/**
 * Drawn as a picture: a raster image. SVG is a document (it can hold script and
 * links of its own), so it is a file card, never drawn inline.
 */
export function isInlineImage(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? ""
  return mime.startsWith("image/") && !mime.startsWith("image/svg")
}

/** A picture's source: only an object URL this app made. */
export function isLocalObjectUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("blob:")
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const SVG_NS = "http://www.w3.org/2000/svg"

/** Lucide's paperclip, drawn as markup of this document (nothing is fetched). */
function paperclip(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "16")
  svg.setAttribute("height", "16")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("class", "shrink-0 text-text-tertiary")
  const path = document.createElementNS(SVG_NS, "path")
  path.setAttribute(
    "d",
    "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
  )
  svg.append(path)
  return svg
}

function label(text: string, state: "loading" | "unavailable"): HTMLSpanElement {
  const span = document.createElement("span")
  span.className = "liaison-file-label"
  span.dataset.state = state
  span.dataset.testid =
    state === "unavailable" ? "liaison-file-unavailable" : "liaison-file-loading"
  span.textContent = text
  return span
}

function card(file: PageFileInfo, deps: FileViewDeps): HTMLElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "liaison-file-card"
  button.dataset.testid = "liaison-file-card"
  button.title = deps.labels.download(file.filename)
  button.setAttribute("aria-label", deps.labels.download(file.filename))
  const name = document.createElement("span")
  name.className = "liaison-file-name"
  name.textContent = file.filename
  const size = document.createElement("span")
  size.className = "liaison-file-size"
  size.textContent = formatFileSize(file.sizeBytes)
  button.append(paperclip(), name, size)
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    deps.open?.(file)
  })
  return button
}

/**
 * Draw file `id` into `dom` (whose content it owns). Answers a function that
 * stops the drawing (a view destroyed or redrawn before the lookup answered).
 */
export function renderFileView(
  dom: HTMLElement,
  id: string,
  deps: FileViewDeps,
  /** Called once the picture is in place (the editor adds its size buttons). */
  onImage?: () => void,
): () => void {
  let live = true
  dom.classList.add("liaison-file")
  dom.dataset.liaisonFile = id
  dom.replaceChildren(label(deps.labels.loading, "loading"))
  const unavailable = () => {
    dom.dataset.kind = "unavailable"
    dom.replaceChildren(label(deps.labels.unavailable, "unavailable"))
  }
  if (!isFileId(id)) {
    unavailable()
    return () => {}
  }
  void deps
    .resolve(id)
    .catch(() => null)
    .then(async (file) => {
      if (!live) return
      if (!file) return unavailable()
      if (!isInlineImage(file.mimeType)) {
        dom.dataset.kind = "file"
        dom.replaceChildren(card(file, deps))
        return
      }
      const url = await deps.imageUrl(id).catch(() => null)
      if (!live) return
      if (!isLocalObjectUrl(url)) {
        // The bytes could not be read: the file is shown as the file it is.
        dom.dataset.kind = "file"
        dom.replaceChildren(card(file, deps))
        return
      }
      const img = document.createElement("img")
      img.alt = file.filename
      img.dataset.testid = "liaison-file-image"
      img.draggable = false
      img.src = url
      dom.dataset.kind = "image"
      dom.replaceChildren(img)
      onImage?.()
    })
  return () => {
    live = false
  }
}
