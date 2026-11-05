// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's icon is data in its manifest, never code: `iconSvg` (SVG markup) or
// `iconName` (a name from Liaison's own icon set). The server refuses a manifest
// whose `iconSvg` is not plain drawing markup, and the client checks it again
// before showing it, and only ever as an `<img>` source, never inline markup.
//
// The check is an allowlist over a strict tokenizer: every element, attribute
// and value must be one a static drawing needs. Nothing is stripped: an icon
// that would need sanitizing is refused, and the refusal names what was found,
// so the author fixes the file instead of shipping something other than what
// they drew.

/** Largest `iconSvg` accepted, in bytes of UTF-8. */
export const APP_ICON_SVG_MAX_BYTES = 8 * 1024

/** The names an app may give as `iconName`; each one is drawn by Liaison. */
export const APP_ICON_NAMES = [
  "activity",
  "bar-chart",
  "bell",
  "book-open",
  "bot",
  "box",
  "briefcase",
  "building",
  "calculator",
  "calendar",
  "clipboard-list",
  "credit-card",
  "database",
  "file-text",
  "folder",
  "gauge",
  "globe",
  "heart",
  "inbox",
  "kanban",
  "layout-dashboard",
  "line-chart",
  "list-todo",
  "mail",
  "map-pin",
  "megaphone",
  "message-square",
  "package",
  "phone",
  "pie-chart",
  "plug",
  "receipt",
  "shield",
  "shopping-cart",
  "star",
  "store",
  "ticket",
  "truck",
  "users",
  "wallet",
  "wrench",
  "zap",
] as const

export type AppIconName = (typeof APP_ICON_NAMES)[number]

export function isAppIconName(value: unknown): value is AppIconName {
  return typeof value === "string" && (APP_ICON_NAMES as readonly string[]).includes(value)
}

const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
])

const ATTRIBUTES = new Set([
  // Root and structure.
  "xmlns",
  "viewBox",
  "width",
  "height",
  "id",
  "transform",
  // Geometry.
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "points",
  "pathLength",
  // Paint.
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  // Gradients.
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
])

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"

// A paint value may point at a gradient of the icon's own (`url(#id)`), never
// at anything outside it.
const OWN_REFERENCE = /^url\(#[A-Za-z_][\w.-]*\)$/

// The only character references allowed in a title: the five XML escapes and numeric
// ones. An attribute value allows none: a reference there (`u&#114;l(`) would spell a
// value past the checks below, which read the text as written.
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9A-Fa-f]{1,6});)/

const NAME = /^[A-Za-z][\w.:-]*/
const ATTRIBUTE = /^\s+([A-Za-z][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/

/**
 * Everything in `svg` that is not plain icon markup, one short reason per
 * finding. An empty list means the icon is shown exactly as written.
 */
export function appIconSvgProblems(svg: unknown): string[] {
  if (typeof svg !== "string") return ["the icon is not a string"]
  const problems: string[] = []
  if (new TextEncoder().encode(svg).length > APP_ICON_SVG_MAX_BYTES) {
    return [`the icon is larger than ${APP_ICON_SVG_MAX_BYTES} bytes`]
  }
  let rest = withoutDeclaration(svg)
  const open: string[] = []
  let rootSeen = false
  let rootClosed = false
  const reject = (reason: string) => {
    if (!problems.includes(reason)) problems.push(reason)
  }

  while (rest.length > 0) {
    const lt = rest.indexOf("<")
    const text = lt === -1 ? rest : rest.slice(0, lt)
    if (text.trim() !== "") {
      if (open.at(-1) === "title") {
        if (ENTITY.test(text)) reject("an unknown character reference in the title")
      } else {
        reject("text outside a <title>")
      }
    }
    if (lt === -1) break
    rest = rest.slice(lt)

    if (rest.startsWith("<!--")) {
      reject("a comment")
      const end = rest.indexOf("-->")
      rest = end === -1 ? "" : rest.slice(end + 3)
      continue
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      reject(rest.startsWith("<![CDATA[") ? "a CDATA section" : "a declaration or instruction")
      const end = rest.indexOf(">")
      rest = end === -1 ? "" : rest.slice(end + 1)
      continue
    }
    if (rest.startsWith("</")) {
      const match = /^<\/([A-Za-z][\w.:-]*)\s*>/.exec(rest)
      if (!match) {
        reject("a malformed closing tag")
        break
      }
      const name = match[1] as string
      if (open.at(-1) !== name) {
        reject(`a closing </${name}> that does not match`)
        break
      }
      open.pop()
      if (open.length === 0) rootClosed = true
      rest = rest.slice(match[0].length)
      continue
    }

    const nameMatch = NAME.exec(rest.slice(1))
    if (!nameMatch) {
      reject("a malformed tag")
      break
    }
    const name = nameMatch[0]
    if (rootClosed) reject("markup after the closing </svg>")
    const isRoot = !rootSeen
    if (!rootSeen) {
      rootSeen = true
      if (name !== "svg") reject(`a root element <${name}> (it must be <svg>)`)
    }
    if (!ELEMENTS.has(name)) reject(`the element <${name}>`)
    rest = rest.slice(1 + name.length)

    let xmlns: string | null = null
    for (;;) {
      const attr = ATTRIBUTE.exec(rest)
      if (!attr) break
      const attrName = attr[1] as string
      const value = (attr[2] ?? attr[3] ?? "") as string
      rest = rest.slice(attr[0].length)
      if (!ATTRIBUTES.has(attrName)) {
        reject(`the attribute ${attrName}`)
        continue
      }
      if (attrName === "xmlns") {
        if (isRoot) xmlns = value
        else reject(`xmlns on <${name}> (only the root <svg> declares it)`)
      }
      if (value.includes("&")) reject(`a character reference in ${attrName}`)
      if (/url\s*\(/i.test(value) && !OWN_REFERENCE.test(value.trim())) {
        reject(`a reference outside the icon in ${attrName}`)
      }
    }
    if (isRoot && name === "svg" && xmlns !== SVG_NAMESPACE) {
      reject(`the root <svg> without xmlns="${SVG_NAMESPACE}"`)
    }
    const close = /^\s*(\/?)>/.exec(rest)
    if (!close) {
      reject(`a malformed attribute on <${name}>`)
      break
    }
    rest = rest.slice(close[0].length)
    if (close[1] !== "/") open.push(name)
    else if (open.length === 0) rootClosed = true
  }

  if (!rootSeen) reject("no <svg> element")
  if (open.length > 0 && problems.length === 0) reject(`an unclosed <${open.at(-1)}>`)
  return problems
}

/**
 * The `src` an `<img>` shows a clean icon from, or null when the icon is not
 * clean. The markup is never put in the page as elements. A leading XML
 * declaration is dropped: the data URL declares UTF-8, so no declaration can
 * have the image read in another encoding than the one checked.
 */
export function appIconSvgDataUrl(svg: unknown): string | null {
  if (typeof svg !== "string" || appIconSvgProblems(svg).length > 0) return null
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withoutDeclaration(svg))}`
}

/** The markup, trimmed, without a leading `<?xml ...?>` declaration. */
function withoutDeclaration(svg: string): string {
  return svg.trim().replace(/^<\?xml\s[^?<>]*\?>\s*/, "")
}
