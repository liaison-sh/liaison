// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tests only: PDFs written byte by byte, so a test can say exactly where each
// definition sits and what each cross-reference names. Nothing here is a sample
// file: every crafted reading is built in code.

const enc = (s: string) => Buffer.from(s, "latin1")

export class PdfWriter {
  private parts: string[] = []
  private length = 0
  /** Offsets of the definitions written since the last cross-reference. */
  private pending = new Map<number, number>()

  raw(s: string): this {
    this.parts.push(s)
    this.length += enc(s).byteLength
    return this
  }

  get offset(): number {
    return this.length
  }

  header(): this {
    return this.raw("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
  }

  /** One definition; answers its offset. */
  obj(num: number, body: string, gen = 0): number {
    const at = this.length
    this.pending.set(num, at)
    this.raw(`${num} ${gen} obj\n${body}\nendobj\n`)
    return at
  }

  stream(num: number, dict: string, data: string): number {
    return this.obj(
      num,
      `<< ${dict} /Length ${enc(data).byteLength} >>\nstream\n${data}\nendstream`,
    )
  }

  /**
   * A cross-reference table for the objects written since the last one (or
   * exactly `entries`: number to offset, or "free"), its trailer and the end.
   */
  xref(trailer: string, entries?: Map<number, number | "free">): { at: number } {
    const map = entries ?? new Map<number, number | "free">(this.pending)
    this.pending = new Map()
    const at = this.length
    const nums = [...map.keys()].sort((a, b) => a - b)
    let out = "xref\n"
    if (!map.has(0)) out += "0 1\n0000000000 65535 f \n"
    for (const n of nums) {
      const v = map.get(n)
      out += `${n} 1\n`
      out += v === "free" ? "0000000000 00001 f \n" : `${String(v).padStart(10, "0")} 00000 n \n`
    }
    this.raw(`${out}trailer\n<< ${trailer} >>\nstartxref\n${at}\n%%EOF\n`)
    return { at }
  }

  /** A cross-reference stream (no filter) naming packed and direct objects. */
  xrefStream(
    num: number,
    trailer: string,
    entries: Map<number, { offset: number } | { stream: number; index: number }>,
  ): { at: number } {
    const at = this.length
    const all = new Map(entries)
    all.set(num, { offset: at })
    const nums = [0, ...[...all.keys()].sort((a, b) => a - b)]
    const bytes: number[] = []
    const row = (t: number, a: number, b: number) =>
      bytes.push(
        t,
        (a >>> 24) & 255,
        (a >>> 16) & 255,
        (a >>> 8) & 255,
        a & 255,
        (b >>> 8) & 255,
        b & 255,
      )
    const index: number[] = []
    for (const n of nums) {
      index.push(n, 1)
      if (n === 0) row(0, 0, 65535)
      else {
        const e = all.get(n)
        if (e && "offset" in e) row(1, e.offset, 0)
        else if (e) row(2, e.stream, e.index)
      }
    }
    const data = Buffer.from(bytes).toString("latin1")
    this.raw(
      `${num} 0 obj\n<< /Type /XRef /W [1 4 2] /Index [${index.join(" ")}] /Size ${Math.max(...nums) + 1} ${trailer} /Length ${bytes.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`,
    )
    this.pending = new Map()
    return { at }
  }

  bytes(): Uint8Array {
    return new Uint8Array(enc(this.parts.join("")))
  }
}

export const PRICE = (amount: string) => `BT /F1 24 Tf 72 700 Td (PRICE EUR ${amount}) Tj ET`

/** The usual first four objects: catalog 1, pages 2, page 3 (contents 4), font 5. */
export function basePdf(
  opts: { catalogExtra?: string; pageExtra?: string; contents?: string } = {},
) {
  const w = new PdfWriter().header()
  w.obj(1, `<< /Type /Catalog /Pages 2 0 R ${opts.catalogExtra ?? ""} >>`)
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  w.obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${opts.pageExtra ?? ""} >>`,
  )
  w.stream(4, "", opts.contents ?? PRICE("10000"))
  w.obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  return w
}

/** A whole, plain file built on `basePdf`, with optional extra objects. */
export function plainPdf(
  opts: Parameters<typeof basePdf>[0] & { extra?: Array<[number, string]> } = {},
): Uint8Array {
  const w = basePdf(opts)
  for (const [n, body] of opts.extra ?? []) w.obj(n, body)
  const size = Math.max(5, ...(opts.extra ?? []).map(([n]) => n)) + 1
  w.xref(`/Size ${size} /Root 1 0 R`)
  return w.bytes()
}
