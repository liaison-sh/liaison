// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Streaming XML (saxes). Records are the elements at `recordDepth` (default
 * 2, the children of the root: `<tickets><ticket/>...</tickets>`), or, with
 * `recordElement`, every outermost element of that name at any depth. Each
 * becomes a plain object:
 *
 *   <ticket id="7"><subject>Hi</subject><note>a</note><note>b</note></ticket>
 *   → { "#name": "ticket", "@id": "7", subject: "Hi", note: ["a", "b"] }
 *
 * A child with attributes or children of its own is an object; text beside
 * children is kept as "#text". Only the current record is held in memory.
 *
 * Safety: a document type declaration is refused outright (no DTD, so no
 * entity expansion and no external entities: billion laughs and XXE cannot
 * start), an undefined entity reference is an error, nesting is capped at
 * 256 levels and a record at 1 MB.
 */
import { SaxesParser, type SaxesTagPlain } from "saxes"
import {
  type ByteSource,
  PARSER_RECORD_MAX_BYTES,
  type ParsedRecord,
  ParserError,
  recordTooLarge,
  textChunks,
} from "./common"

export interface XmlOptions {
  recordDepth?: number
  recordElement?: string
  name?: string
}

const MAX_DEPTH = 256
/** Text is handed to saxes in slices this size, so the pending count is checked often. */
const WRITE_SLICE = 64 * 1024

type XmlValue = string | XmlNode | Array<string | XmlNode>
interface XmlNode {
  [key: string]: XmlValue
}

interface Frame {
  name: string
  node: XmlNode
  text: string
  hasChildren: boolean
  hasAttributes: boolean
}

function addChild(parent: XmlNode, key: string, value: string | XmlNode): void {
  const existing = parent[key]
  if (existing === undefined) parent[key] = value
  else if (Array.isArray(existing)) existing.push(value)
  else parent[key] = [existing, value]
}

export async function* parseXml(
  source: ByteSource,
  opts: XmlOptions = {},
): AsyncGenerator<ParsedRecord> {
  const name = opts.name ?? "the XML file"
  const recordDepth = opts.recordDepth ?? 2
  const parser = new SaxesParser()
  const ready: ParsedRecord[] = []
  const stack: Frame[] = []
  let depth = 0
  /** Depth of the record being collected, or 0. */
  let recordAt = 0
  let recordBytes = 0
  let number = 0
  let failure: Error | null = null

  const fail = (err: Error): never => {
    failure = err
    throw err
  }

  // saxes buffers text, attribute values and comments until the event that
  // ends them. Count what was written since the last event and refuse past a
  // record's worth, so nothing outside or inside a record grows unbounded.
  let pending = 0
  const seen = () => {
    pending = 0
  }
  // saxes keeps one handler per event, so the events handled below reset the
  // count themselves; the rest get `seen`.
  for (const ev of [
    "opentagstart",
    "attribute",
    "comment",
    "processinginstruction",
    "xmldecl",
  ] as const) {
    parser.on(ev, seen)
  }

  parser.on("error", (err) => {
    fail(
      err instanceof ParserError
        ? err
        : new ParserError("invalid_xml", `${name} is not valid XML: ${err.message}`),
    )
  })
  parser.on("doctype", () => {
    fail(
      new ParserError(
        "xml_dtd_refused",
        `${name} declares a document type (<!DOCTYPE>); DTDs and entity declarations are refused in imports. Export the file without a DOCTYPE.`,
      ),
    )
  })

  const count = (bytes: number) => {
    if (!recordAt) return
    recordBytes += bytes
    if (recordBytes > PARSER_RECORD_MAX_BYTES) {
      fail(recordTooLarge(`Record ${number + 1} of ${name}`, PARSER_RECORD_MAX_BYTES, true))
    }
  }

  parser.on("opentag", (tag: SaxesTagPlain) => {
    pending = 0
    depth++
    if (depth > MAX_DEPTH) {
      fail(
        new ParserError("invalid_xml", `${name} nests elements deeper than ${MAX_DEPTH} levels.`),
      )
    }
    const starts =
      !recordAt && (opts.recordElement ? tag.name === opts.recordElement : depth === recordDepth)
    if (starts) {
      recordAt = depth
      recordBytes = 0
    }
    if (!recordAt) return
    const node: XmlNode = {}
    let hasAttributes = false
    for (const [k, v] of Object.entries(tag.attributes)) {
      node[`@${k}`] = v
      hasAttributes = true
      count(k.length + v.length + 4)
    }
    count(tag.name.length + 4)
    const parent = stack[stack.length - 1]
    if (parent) parent.hasChildren = true
    stack.push({ name: tag.name, node, text: "", hasChildren: false, hasAttributes })
  })

  const onText = (text: string) => {
    pending = 0
    if (!recordAt) return
    const top = stack[stack.length - 1]
    if (!top) return
    count(Buffer.byteLength(text, "utf8"))
    top.text += text
  }
  parser.on("text", onText)
  parser.on("cdata", onText)

  parser.on("closetag", () => {
    pending = 0
    const closingDepth = depth
    depth--
    if (!recordAt) return
    const frame = stack.pop() as Frame
    let value: string | XmlNode
    if (!frame.hasChildren && !frame.hasAttributes) {
      value = frame.text
    } else {
      value = frame.node
      if (frame.text.trim() !== "") frame.node["#text"] = frame.text
    }
    if (closingDepth === recordAt) {
      const record = typeof value === "string" ? { "#text": value } : value
      ready.push({ number: ++number, value: { "#name": frame.name, ...record } })
      recordAt = 0
      recordBytes = 0
      return
    }
    const parent = stack[stack.length - 1]
    if (parent) addChild(parent.node, frame.name, value)
  })

  const drain = function* (): Generator<ParsedRecord> {
    while (ready.length > 0) yield ready.shift() as ParsedRecord
  }

  try {
    for await (const text of textChunks(source)) {
      for (let i = 0; i < text.length; i += WRITE_SLICE) {
        const piece = text.slice(i, i + WRITE_SLICE)
        pending += piece.length
        parser.write(piece)
        if (pending > PARSER_RECORD_MAX_BYTES + WRITE_SLICE) {
          fail(
            recordTooLarge(
              `A text, attribute or comment run in ${name}`,
              PARSER_RECORD_MAX_BYTES,
              true,
            ),
          )
        }
        yield* drain()
      }
    }
    parser.close()
    yield* drain()
  } catch (err) {
    if (failure) throw failure
    if (err instanceof ParserError) throw err
    throw new ParserError(
      "invalid_xml",
      `${name} is not valid XML: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
