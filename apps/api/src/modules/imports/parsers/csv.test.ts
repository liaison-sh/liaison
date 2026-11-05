// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { collect, failure } from "./__test-helpers__/collect"
import { bytesOf, PARSER_RECORD_MAX_BYTES, ParserError } from "./common"
import { detectDelimiter, parseCsv } from "./csv"

describe("parseCsv", () => {
  it("keys rows by the header and numbers them from 1", async () => {
    const rows = await collect(parseCsv(bytesOf("id,subject\n1,Printer offline\n2,Refund\n")))
    expect(rows).toEqual([
      { number: 1, value: { id: "1", subject: "Printer offline" } },
      { number: 2, value: { id: "2", subject: "Refund" } },
    ])
  })

  it("handles quoted delimiters, doubled quotes and newlines inside quotes", async () => {
    const csv = 'id,body\n1,"Hello, world"\n2,"She said ""hi"""\n3,"line one\nline two"\n'
    const rows = await collect(parseCsv(bytesOf(csv, 7)))
    expect(rows.map((r) => r.value)).toEqual([
      { id: "1", body: "Hello, world" },
      { id: "2", body: 'She said "hi"' },
      { id: "3", body: "line one\nline two" },
    ])
  })

  it("drops a UTF-8 BOM and handles CRLF", async () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("Name,Email\r\nAda,ada@example.com\r\n"),
    ])
    const rows = await collect(parseCsv(bytesOf(bytes)))
    expect(rows.map((r) => r.value)).toEqual([{ Name: "Ada", Email: "ada@example.com" }])
  })

  it("detects a semicolon delimiter (European exports) and keeps decimal commas", async () => {
    expect(detectDelimiter('"Name";"Amount";"Date"')).toBe(";")
    const rows = await collect(parseCsv(bytesOf("Name;Amount\nAcme SARL;1 234,50\n")))
    expect(rows.map((r) => r.value)).toEqual([{ Name: "Acme SARL", Amount: "1 234,50" }])
  })

  it("detects tabs; an explicit delimiter wins", async () => {
    const tsv = await collect(parseCsv(bytesOf("a\tb\n1\t2\n")))
    expect(tsv.map((r) => r.value)).toEqual([{ a: "1", b: "2" }])
    const forced = await collect(parseCsv(bytesOf("a;b\n1;2\n"), { delimiter: "," }))
    expect(forced.map((r) => r.value)).toEqual([{ "a;b": "1;2" }])
  })

  it("names duplicate and empty headers so no column is lost; ragged rows keep their cells", async () => {
    const rows = await collect(parseCsv(bytesOf("Name,Name,\nA,B,C,D\n")))
    expect(rows[0]?.value).toEqual({ Name: "A", Name_2: "B", column_3: "C", column_4: "D" })
  })

  it("an unclosed quote is an error naming the file", async () => {
    const err = await failure(
      parseCsv(bytesOf('id,body\n1,"never closed\n'), { name: "tickets.csv" }),
    )
    expect(err).toBeInstanceOf(ParserError)
    expect((err as ParserError).code).toBe("invalid_csv")
    expect(err.message).toContain("tickets.csv is not valid CSV")
  })

  it("a row over 1 MB fails with its number", async () => {
    const big = "z".repeat(PARSER_RECORD_MAX_BYTES + 10)
    const err = await failure(
      parseCsv(bytesOf(`id,body\n1,small\n2,${big}\n`), { name: "tickets.csv" }),
    )
    expect((err as ParserError).code).toBe("record_too_large")
    expect(err.message).toContain("Row 2 of tickets.csv")
  })
})

describe("parseCsv: pathological rows are refused before they are buffered", () => {
  it("a 4 MB line of commas is refused fast with bounded memory", async () => {
    async function* commas() {
      yield new TextEncoder().encode("a,b\n")
      const chunk = new Uint8Array(64 * 1024).fill(0x2c)
      for (let i = 0; i < 64; i++) yield chunk
    }
    const before = process.memoryUsage().rss
    const started = Date.now()
    const err = await failure(parseCsv(commas(), { name: "flood.csv" }))
    expect(err).toBeInstanceOf(ParserError)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024)
  })

  it("a row with more than 16,384 columns is refused", async () => {
    const err = await failure(
      parseCsv(bytesOf(`a,b\n${",".repeat(20_000)}\n`), { name: "wide.csv" }),
    )
    expect((err as ParserError).code).toBe("invalid_csv")
    expect(err.message).toContain("more than 16384 columns")
  })

  it("a line over 1 MB without a newline is refused as a record over the cap", async () => {
    const err = await failure(
      parseCsv(bytesOf(`a,b\n1,${"x".repeat(1_100_000)}`), { name: "long.csv" }),
    )
    expect((err as ParserError).code).toBe("record_too_large")
    expect(err.message).toContain("Row 1 of long.csv")
  })
})

describe("parseCsv: backpressure", () => {
  it("leaves no listener behind on the parser per backpressure wait", async () => {
    // Each wait for the parser to drain used to leave a "close" listener (and
    // its error listener) on the parser: thousands over a GB-scale file.
    const warnings: string[] = []
    const onWarning = (w: Error) => {
      if (w.name === "MaxListenersExceededWarning") warnings.push(w.message)
    }
    process.on("warning", onWarning)
    try {
      const line = `x,${"y".repeat(400)}\n`
      const csv = `a,b\n${line.repeat(40_000)}`
      let rows = 0
      for await (const _ of parseCsv(bytesOf(csv), { name: "big.csv" })) {
        rows++
        if (rows % 500 === 0) await Bun.sleep(0)
      }
      expect(rows).toBe(40_000)
      // Warnings are emitted on the next tick.
      await Bun.sleep(10)
      expect(warnings).toEqual([])
    } finally {
      process.off("warning", onWarning)
    }
  })
})
