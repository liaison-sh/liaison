// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A deliberately small, safe XML reader for supplier e-invoices (CII and UBL). It only ever builds
// an element tree to READ a few business terms; the document is never rendered.
//   - A document type declaration is refused outright (`<!DOCTYPE`, and with it every internal or
//     external entity, parameter entity and external DTD): no entity is ever defined, so none can
//     be expanded or fetched.
//   - Only the five predefined entities and numeric character references are decoded; any other
//     `&name;` is refused.
//   - Size, element count, depth and wall-clock budgets: a hostile file fails fast with a code.
// Element and attribute names are kept by LOCAL name (namespace prefix dropped).

export class XmlRefused extends Error {
  constructor(
    public readonly code:
      | "xml_dtd_refused"
      | "xml_entity_refused"
      | "xml_too_large"
      | "xml_too_complex"
      | "xml_timeout"
      | "xml_malformed",
    message: string,
  ) {
    super(message)
    this.name = "XmlRefused"
  }
}

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

export interface XmlLimits {
  maxBytes: number
  maxElements: number
  maxDepth: number
  timeoutMs: number
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxElements: 200_000,
  maxDepth: 128,
  timeoutMs: 2_000,
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s
  // Every & must open a reference; checked before decoding (a decoded &amp; is plain text).
  if (/&(?!(?:#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9._-]{0,31});)/.test(s)) {
    throw new XmlRefused("xml_malformed", "a bare & is not well-formed")
  }
  return s.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9._-]{0,31});/g,
    (_m, name: string) => {
      if (name.startsWith("#")) {
        const cp =
          name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff)
          throw new XmlRefused("xml_malformed", `bad character reference &${name};`)
        return String.fromCodePoint(cp)
      }
      const v = PREDEFINED[name]
      if (v === undefined)
        throw new XmlRefused("xml_entity_refused", `entity &${name}; is not allowed`)
      return v
    },
  )
}

function local(qname: string): string {
  const i = qname.indexOf(":")
  return i === -1 ? qname : qname.slice(i + 1)
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

/** Parse `xml` into an element tree, or throw `XmlRefused`. */
export function parseXmlSafe(
  xml: string,
  limits: Partial<XmlLimits> = {},
  now: () => number = Date.now,
): XmlElement {
  const L = { ...DEFAULT_XML_LIMITS, ...limits }
  // UTF-16 code units ≥ bytes / 3 for UTF-8 input: a cheap pre-check, the caller checks bytes.
  if (xml.length > L.maxBytes)
    throw new XmlRefused("xml_too_large", `document over ${L.maxBytes} bytes`)
  if (/<!DOCTYPE/i.test(xml))
    throw new XmlRefused("xml_dtd_refused", "a document type declaration is not accepted")
  if (/<!ENTITY/i.test(xml))
    throw new XmlRefused("xml_entity_refused", "an entity declaration is not accepted")
  const started = now()
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" }
  const stack: XmlElement[] = [root]
  let count = 0
  let i = 0
  const n = xml.length
  while (i < n) {
    if ((count & 0x3ff) === 0 && now() - started > L.timeoutMs)
      throw new XmlRefused("xml_timeout", `parse over ${L.timeoutMs} ms`)
    const lt = xml.indexOf("<", i)
    if (lt === -1) {
      if (xml.slice(i).trim() !== "") stack[stack.length - 1]!.text += decodeEntities(xml.slice(i))
      break
    }
    if (lt > i) {
      const t = xml.slice(i, lt)
      if (stack.length > 1) stack[stack.length - 1]!.text += decodeEntities(t)
      else if (t.trim() !== "")
        throw new XmlRefused("xml_malformed", "text outside the root element")
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4)
      if (end === -1) throw new XmlRefused("xml_malformed", "unterminated comment")
      i = end + 3
      continue
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9)
      if (end === -1) throw new XmlRefused("xml_malformed", "unterminated CDATA")
      if (stack.length > 1) stack[stack.length - 1]!.text += xml.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2)
      if (end === -1) throw new XmlRefused("xml_malformed", "unterminated processing instruction")
      i = end + 2
      continue
    }
    if (xml.startsWith("<!", lt))
      throw new XmlRefused("xml_dtd_refused", "markup declarations are not accepted")
    const gt = xml.indexOf(">", lt + 1)
    if (gt === -1) throw new XmlRefused("xml_malformed", "unterminated tag")
    const raw = xml.slice(lt + 1, gt)
    if (raw.startsWith("/")) {
      const name = local(raw.slice(1).trim())
      const top = stack.pop()
      if (!top || top === root || top.name !== name)
        throw new XmlRefused("xml_malformed", `unexpected </${name}>`)
      i = gt + 1
      continue
    }
    const selfClosing = raw.endsWith("/")
    const body = selfClosing ? raw.slice(0, -1) : raw
    const m = /^([^\s/>]+)/.exec(body)
    if (!m) throw new XmlRefused("xml_malformed", "a tag without a name")
    const el: XmlElement = { name: local(m[1]!), attrs: {}, children: [], text: "" }
    ATTR.lastIndex = 0
    for (let a = ATTR.exec(body); a; a = ATTR.exec(body)) {
      el.attrs[local(a[1]!)] = decodeEntities(a[3] ?? a[4] ?? "")
    }
    count += 1
    if (count > L.maxElements)
      throw new XmlRefused("xml_too_complex", `over ${L.maxElements} elements`)
    const parent = stack[stack.length - 1]!
    if (parent === root && root.children.length > 0)
      throw new XmlRefused("xml_malformed", "more than one root element")
    parent.children.push(el)
    if (!selfClosing) {
      stack.push(el)
      if (stack.length - 1 > L.maxDepth)
        throw new XmlRefused("xml_too_complex", `deeper than ${L.maxDepth}`)
    }
    i = gt + 1
  }
  if (stack.length !== 1) throw new XmlRefused("xml_malformed", "unclosed element")
  const doc = root.children[0]
  if (!doc) throw new XmlRefused("xml_malformed", "no root element")
  return doc
}

// ---------------------------------------------------------------------------------------------
// Reading paths (local names).

export function child(el: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let cur = el
  for (const p of path) {
    cur = cur?.children.find((c) => c.name === p)
    if (!cur) return undefined
  }
  return cur
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : []
}

export function text(el: XmlElement | undefined, ...path: string[]): string | null {
  const t = child(el, ...path)?.text.trim()
  return t ? t : null
}
