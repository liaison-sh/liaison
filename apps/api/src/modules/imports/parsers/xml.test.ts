// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { collect, failure } from "./__test-helpers__/collect"
import { bytesOf, PARSER_RECORD_MAX_BYTES, ParserError } from "./common"
import { parseXml } from "./xml"

const TICKETS = `<?xml version="1.0" encoding="UTF-8"?>
<helpdesk-tickets>
  <helpdesk-ticket>
    <display-id>101</display-id>
    <subject>Printer &amp; scanner offline</subject>
    <notes>
      <helpdesk-note><body><![CDATA[<p>Rebooted</p>]]></body><private type="boolean">true</private></helpdesk-note>
      <helpdesk-note><body>Fixed</body><private type="boolean">false</private></helpdesk-note>
    </notes>
  </helpdesk-ticket>
  <helpdesk-ticket><display-id>102</display-id><subject>Refund</subject></helpdesk-ticket>
</helpdesk-tickets>`

describe("parseXml", () => {
  it("yields the root's children as plain objects, streaming across chunks", async () => {
    const rows = await collect(parseXml(bytesOf(TICKETS, 13)))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      number: 1,
      value: {
        "#name": "helpdesk-ticket",
        "display-id": "101",
        subject: "Printer & scanner offline",
        notes: {
          "helpdesk-note": [
            { body: "<p>Rebooted</p>", private: { "@type": "boolean", "#text": "true" } },
            { body: "Fixed", private: { "@type": "boolean", "#text": "false" } },
          ],
        },
      },
    })
    expect(rows[1]?.value).toEqual({
      "#name": "helpdesk-ticket",
      "display-id": "102",
      subject: "Refund",
    })
  })

  it("recordElement picks the outermost elements of that name at any depth", async () => {
    const rows = await collect(parseXml(bytesOf(TICKETS), { recordElement: "helpdesk-note" }))
    expect(rows.map((r) => (r.value as { body: string }).body)).toEqual([
      "<p>Rebooted</p>",
      "Fixed",
    ])
  })

  it("refuses billion laughs at its DOCTYPE: no entity is ever expanded", async () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<lolz><lol>&lol9;</lol></lolz>`
    const err = await failure(parseXml(bytesOf(lol), { name: "export.xml" }))
    expect(err).toBeInstanceOf(ParserError)
    expect((err as ParserError).code).toBe("xml_dtd_refused")
  })

  it("refuses any DTD, including an external entity (XXE)", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><a>&x;</a></r>`
    expect(((await failure(parseXml(bytesOf(xxe)))) as ParserError).code).toBe("xml_dtd_refused")
    const plain = `<?xml version="1.0"?><!DOCTYPE r SYSTEM "r.dtd"><r><a>1</a></r>`
    expect(((await failure(parseXml(bytesOf(plain)))) as ParserError).code).toBe("xml_dtd_refused")
  })

  it("an undefined entity reference is an error, not an expansion", async () => {
    const err = await failure(parseXml(bytesOf("<r><a>&nope;</a></r>"), { name: "export.xml" }))
    expect((err as ParserError).code).toBe("invalid_xml")
    expect(err.message).toContain("export.xml is not valid XML")
  })

  it("a record over 1 MB fails with its number", async () => {
    const big = "w".repeat(PARSER_RECORD_MAX_BYTES + 10)
    const err = await failure(
      parseXml(bytesOf(`<r><t><s>ok</s></t><t><s>${big}</s></t></r>`, 64 * 1024), {
        name: "export.xml",
      }),
    )
    expect((err as ParserError).code).toBe("record_too_large")
    expect(err.message).toContain("Record 2 of export.xml")
  })

  it("malformed XML names the file", async () => {
    const err = await failure(parseXml(bytesOf("<r><a></r>"), { name: "export.xml" }))
    expect((err as ParserError).code).toBe("invalid_xml")
  })
})

describe("parseXml: text saxes would buffer is bounded", () => {
  async function* hugeText(open: string, close: string, mb: number) {
    const enc = new TextEncoder()
    yield enc.encode(open)
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    for (let i = 0; i < mb; i++) yield chunk
    yield enc.encode(close)
  }

  it("200 MB of text at depth 1 (outside any record) is refused early with bounded memory", async () => {
    const before = process.memoryUsage().rss
    const err = await failure(parseXml(hugeText("<r>", "</r>", 200), { name: "big.xml" }))
    expect((err as ParserError).code).toBe("record_too_large")
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024)
  })

  it("a huge attribute value is refused", async () => {
    const err = await failure(parseXml(hugeText('<r><t a="', '"/></r>', 5), { name: "attr.xml" }))
    expect((err as ParserError).code).toBe("record_too_large")
  })
})
