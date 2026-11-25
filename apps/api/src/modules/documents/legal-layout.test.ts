// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The classic legal layout: what reaches the page (read back from the bytes),
// numbers and references computed by the renderer, the refusals prepare relies
// on, the contents check, and layout baselines of a long contract's pages.
import { describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DrawCommand } from "@liaison/shared"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import { faceTextWidth } from "~/modules/pdf/unicode-fonts"
import {
  freezeTextMatches,
  layoutRichText,
  parseRichTextBody,
  RichTextError,
  renderRichTextForFreeze,
} from "./rich-text"

type Body = Record<string, unknown>

const parties = {
  type: "parties",
  groups: [
    {
      items: [
        {
          kind: "company",
          name: "{{client.name}}",
          form: "SAS",
          capital: "10 000 €",
          seat: "12 rue des Lilas, 75011 Paris",
          rcs_city: "Paris",
          rcs_number: "812 345 678",
          represented_by: "Claire Martin",
          capacity: "présidente",
          defined_as: "le Client",
        },
      ],
    },
    {
      items: [
        { kind: "company", name: "Maison Studio Nord", form: "SARL", defined_as: "le Prestataire" },
      ],
    },
  ],
}

const record = { client: { name: "Maison Ondine" } }

function legal(blocks: unknown[], page: Record<string, unknown> = {}): Body {
  return { page: { layout: "legal", lang: "fr", ...page }, blocks }
}

function lay(body: Body, rec: Record<string, unknown> = record) {
  return layoutRichText(parseRichTextBody(body), rec, (p) => p, new Map(), "Contrat de prestation")
}

function refusal(fn: () => unknown): RichTextError {
  try {
    fn()
  } catch (err) {
    if (err instanceof RichTextError) return err
    throw err
  }
  throw new Error("expected a refusal")
}

function drawn(commands: readonly DrawCommand[]): string {
  return commands.flatMap((c) => (c.op === "drawText" ? [c.text] : [])).join(" ")
}

const article = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "article",
  id,
  level: 1,
  heading: id,
  text,
  ...extra,
})

describe("the legal layout on the page", () => {
  it("prints parties, preamble, numbered articles, page numbers and the signature page, read from the bytes", async () => {
    const out = await renderRichTextForFreeze({
      body: legal([
        parties,
        { type: "recitals", items: ["Le Client souhaite un site.", "Le Prestataire en conçoit."] },
        article("objet", "Le Prestataire réalise le site décrit à l'{{ref:annexe}}."),
        { type: "article", level: 2, text: "Le {{def:Client}} fournit ses contenus." },
        { type: "article", level: 4, text: "les textes ;" },
        { type: "article", level: 4, text: "les images." },
        {
          type: "annex",
          id: "annexe",
          title: "Cahier des charges",
          blocks: [{ type: "paragraph", text: "Trois pages." }],
        },
        {
          type: "signature_block",
          place: "Paris",
          lines: [{ party: "Maison Ondine", name: "Claire Martin", capacity: "présidente" }],
        },
      ]),
      record,
      title: "Contrat de prestation",
    })
    const text = await extractPdfText(out.bytes)
    for (const words of [
      "Contrat de prestation",
      "Entre les soussignés",
      "Maison Ondine",
      "D'une part,",
      "D'autre part,",
      "Préambule",
      "(A)",
      "Il a été convenu ce qui suit",
      "Article 1",
      "1.1",
      "(a)",
      "(b)",
      "annexe 1",
      "Annexe 1",
      "Page de signature",
      "Fait à",
      "Signé électroniquement",
      `Page 1 sur ${out.pageCount}`,
    ]) {
      expect({ words, found: text.includes(words) }).toEqual({ words, found: true })
    }
    expect(out.blanks).toEqual([])
    expect(Buffer.from(out.bytes).includes(Buffer.from("LiberationSerif"))).toBe(true)
    expect(freezeTextMatches(out.sourceText, out.layoutText)).toBe(true)
    expect(out.tocMatches).toBe(true)
    // A frozen page cannot know its date: none is printed.
    expect(text).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)
  })

  it("prints the English words with lang en", async () => {
    const out = await renderRichTextForFreeze({
      body: legal([parties, article("scope", "The work.")], { lang: "en" }),
      record,
    })
    const text = await extractPdfText(out.bytes)
    for (const words of ["Between", "hereinafter", "Of the one part,", "Clause 1", "Page 1 of 1"])
      expect({ words, found: text.includes(words) }).toEqual({ words, found: true })
  })

  it("prints a defined term in bold guillemets and puts French non-breaking spaces", () => {
    const { commands } = lay(legal([parties, article("objet", "Le {{def:Client}} paie : tout.")]))
    const text = drawn(commands)
    expect(text).toContain("« le")
    expect(text).toContain("Client »")
    expect(text).toContain("paie :")
    const bold = commands.filter(
      (c): c is Extract<DrawCommand, { op: "drawText" }> =>
        c.op === "drawText" && c.font === "serifBold" && c.text.includes("Client"),
    )
    expect(bold.length).toBeGreaterThan(0)
  })

  it("justifies every line but the last of a clause to the right margin, measured with the serif face", () => {
    const long = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(" ")
    const { commands } = lay(legal([article("objet", long)]))
    const words = commands.filter(
      (c): c is Extract<DrawCommand, { op: "drawText" }> =>
        c.op === "drawText" && c.text.startsWith("mot"),
    )
    const lines = new Map<number, typeof words>()
    for (const w of words) lines.set(w.y, [...(lines.get(w.y) ?? []), w])
    const ys = [...lines.keys()].sort((a, b) => b - a)
    expect(ys.length).toBeGreaterThan(2)
    for (const y of ys.slice(0, -1)) {
      const row = lines.get(y) ?? []
      const lastWord = row[row.length - 1] as Extract<DrawCommand, { op: "drawText" }>
      const right = lastWord.x + faceTextWidth("serif", lastWord.text, lastWord.size)
      expect(Math.abs(right - (595.28 - 71))).toBeLessThan(0.05)
      expect(row[0]?.x).toBeCloseTo(71, 5)
    }
    const lastRow = lines.get(ys[ys.length - 1] as number) ?? []
    const end = lastRow[lastRow.length - 1] as Extract<DrawCommand, { op: "drawText" }>
    expect(end.x + faceTextWidth("serif", end.text, end.size)).toBeLessThan(595.28 - 71 - 5)
  })

  it("draws a Japanese name with the fallback face and refuses a character no face can draw, naming it", async () => {
    const ok = await renderRichTextForFreeze({
      body: legal([article("objet", "株式会社アイシン signe.")]),
      record,
    })
    expect(await extractPdfText(ok.bytes)).toContain("株式会社アイシン")
    const err = refusal(() => lay(legal([article("objet", "Un sourire \u{1f600} ici.")])))
    expect(err.code).toBe("character_not_drawable")
    expect(err.message).toContain("U+1F600")
  })

  it("prints a missing value as a blank the freeze refuses", async () => {
    const out = await renderRichTextForFreeze({ body: legal([parties]), record: {} })
    expect(out.blanks.map((b) => b.path)).toEqual(["client.name"])
  })
})

describe("numbers are the renderer's", () => {
  const refBody = (order: string[]) =>
    legal([
      ...order.map((id) => article(id, `Texte de ${id}.`)),
      article("renvoi", "Voir {{ref:frais}}."),
    ])

  it("a reference follows its clause when the clause moves", () => {
    const before = drawn(lay(refBody(["objet", "frais"])).commands)
    expect(before).toContain("article 2")
    const after = drawn(lay(refBody(["frais", "objet"])).commands)
    expect(after).toContain("article 1")
    expect(after).not.toContain("article 2.")
  })

  it("numbers sub-clauses 1.1, 1.1.1, (a) and (i), and refers to them in full", () => {
    const text = drawn(
      lay(
        legal([
          article("un", "A."),
          { type: "article", level: 2, text: "B." },
          { type: "article", id: "c", level: 3, text: "C." },
          { type: "article", id: "d", level: 4, text: "D." },
          { type: "article", id: "e", level: 5, text: "E." },
          article("deux", "Voir {{ref:e}} et {{ref:c}}."),
        ]),
      ).commands,
    )
    for (const n of ["1.1", "1.1.1", "(a)", "(i)", "article 1.1.1(a)(i)", "article 1.1.1"])
      expect({ n, found: text.includes(n) }).toEqual({ n, found: true })
  })

  it("a clause a condition hides is not numbered, and a reference to it is refused", () => {
    const body = legal([
      article("objet", "Objet."),
      { ...article("option", "Option."), when: { path: "with_option", equals: "yes" } },
      article("prix", "Prix."),
    ])
    expect(drawn(lay(body).commands)).toContain("Article 2 – prix")
    expect(drawn(lay(body, { ...record, with_option: "yes" }).commands)).toContain(
      "Article 3 – prix",
    )
    const err = refusal(() =>
      lay(legal([...(body.blocks as unknown[]), article("renvoi", "Voir {{ref:option}}.")])),
    )
    expect(err.code).toBe("broken_reference")
    expect(err.message).toContain("{{ref:option}}")
    expect(err.message).toContain("hides")
  })

  it("two deleted clauses: the refusal names each reference left dangling", () => {
    const err = refusal(() =>
      lay(
        legal([article("objet", "Voir {{ref:prix}} et {{ref:duree}}, et le {{def:Fournisseur}}.")]),
      ),
    )
    expect(err.code).toBe("broken_reference")
    for (const ref of ["{{ref:prix}}", "{{ref:duree}}", "{{def:Fournisseur}}"])
      expect(err.message).toContain(ref)
  })

  it("an article number typed by hand where that article exists is refused, a statute citation is not", () => {
    const err = refusal(() =>
      lay(legal([article("objet", "Objet."), article("prix", "Comme dit à l'article 1, payer.")])),
    )
    expect(err.code).toBe("typed_reference")
    expect(err.message).toContain("article 1")
    // A number that is not an article here, or one followed by a statute's name, is a citation.
    lay(legal([article("objet", "Selon l'article 1366 du Code civil.")]))
    lay(legal([article("objet", "Selon l'article 1 du Code civil.")]))
    lay(legal([article("objet", "Selon l'article 1 de la loi."), article("b", "B.")]))
    // A person marked the clause as citing another text.
    lay(legal([article("objet", "Voir article 1.", { citation: true })]))
  })

  it("a clause whose text starts with a number is refused", () => {
    for (const text of [
      "1. Objet du contrat.",
      "2.1 Le prix.",
      "(a) les textes",
      "Article 3 dit.",
    ]) {
      const err = refusal(() => lay(legal([article("objet", text)])))
      expect({ text, code: err.code }).toEqual({ text, code: "numbered_clause" })
    }
    // A sentence that merely begins with a figure is not a typed number.
    lay(legal([article("objet", "2026 sera l'année du lancement.")]))
  })

  it("a heading or a clause heading with a typed number is refused too: the layout numbers them", () => {
    for (const blocks of [
      [{ type: "heading", level: 2, text: "1. Scope" }, article("a", "The work.")],
      [article("a", "The work.", { heading: "2. Timeline" })],
    ]) {
      const err = refusal(() => lay(legal(blocks as never)))
      expect(err.code).toBe("numbered_clause")
    }
    lay(legal([{ type: "heading", level: 2, text: "Scope" }, article("a", "The work.")] as never))
  })

  it("legal blocks print only in the legal layout, and the legal layout takes no table", () => {
    expect(() => parseRichTextBody({ blocks: [article("a", "A.")] })).toThrow(/legal layout only/)
    expect(() =>
      parseRichTextBody(legal([{ type: "table", columns: [{ header: "A" }], rows: [["x"]] }])),
    ).toThrow(/no table block/)
    expect(() => parseRichTextBody(legal([article("a", "A."), article("a", "B.")]))).toThrow(
      /two clauses have the id a/,
    )
  })
})

// A contract long enough for automatic contents (from 10 pages).
function longContract(): Body {
  const clause = (i: number) =>
    `Les parties conviennent que la clause ${String.fromCharCode(97 + (i % 26))} s'applique dans les conditions prévues au présent contrat, sans préjudice des autres stipulations, et que chacune d'elles exécute ses obligations de bonne foi, avec diligence et dans les délais convenus entre elles.`
  const blocks: unknown[] = [
    parties,
    {
      type: "recitals",
      items: ["Le Client souhaite confier une mission.", "Le Prestataire l'accepte."],
    },
  ]
  for (let a = 1; a <= 24; a++) {
    blocks.push({ type: "article", id: `a${a}`, level: 1, heading: `Titre ${a}`, text: clause(a) })
    for (let s = 1; s <= 4; s++) blocks.push({ type: "article", level: 2, text: clause(a + s) })
  }
  blocks.push({
    type: "annex",
    id: "x1",
    title: "Conditions particulières",
    blocks: [{ type: "paragraph", text: clause(3) }],
  })
  blocks.push({
    type: "signature_block",
    place: "Lyon",
    lines: [
      { party: "Maison Ondine", name: "Claire Martin", capacity: "présidente" },
      { party: "Maison Studio Nord", name: "Paul Durand", capacity: "gérant" },
    ],
  })
  return legal(blocks, { confidential: true, shortTitle: "Contrat cadre" })
}

describe("contents, header and footer", () => {
  it("a body of 10 pages or more gets contents whose every entry shows the page its heading landed on", async () => {
    const out = await renderRichTextForFreeze({
      body: longContract(),
      record,
      title: "Contrat cadre",
    })
    expect(out.pageCount).toBeGreaterThanOrEqual(10)
    const laid = lay(longContract())
    expect(laid.toc?.length).toBe(25)
    for (const e of laid.toc ?? []) expect(e.printedPage).toBe(e.headingPage)
    expect(out.tocMatches).toBe(true)
    const text = await extractPdfText(out.bytes)
    expect(text).toContain("Sommaire")
    expect(text).toContain("Confidentiel")
    expect(text).toContain(`Page ${out.pageCount} sur ${out.pageCount}`)
    // The compare leaves the running header, the footer and the contents out.
    expect(out.layoutText).not.toContain("Sommaire")
    expect(out.layoutText).not.toContain("Confidentiel")
    expect(out.layoutText).not.toContain(" sur ")
    expect(out.sourceText).not.toContain("Sommaire")
    expect(freezeTextMatches(out.sourceText, out.layoutText)).toBe(true)
  })

  it("a heading never ends a page: it keeps with the text that follows", () => {
    const laid = lay(longContract())
    const texts = laid.commands.filter(
      (c): c is Extract<DrawCommand, { op: "drawText" }> => c.op === "drawText",
    )
    for (const h of texts.filter((t) => t.text === "Article" && t.font === "serifBold")) {
      // Something of the body is drawn below the heading on its own page.
      const below = texts.filter((t) => t.page === h.page && t.y < h.y - 10 && t.y > 71)
      expect(below.length).toBeGreaterThan(0)
    }
  })

  it("an explicit contents block prints even on a short body", async () => {
    const out = await renderRichTextForFreeze({
      body: legal([parties, { type: "toc" }, article("objet", "Objet.")]),
      record,
    })
    expect(await extractPdfText(out.bytes)).toContain("Sommaire")
    expect(out.tocMatches).toBe(true)
  })
})

// Layout baselines of a long contract's first page, page 9, last page and
// signature page: every drawn word with its page, position, size and font. A
// change to the layout shows here as a diff to review; rewrite with
// LEGAL_LAYOUT_BASELINE_WRITE=1 after looking at the pages.
describe("layout baselines of a long contract", () => {
  const file = join(import.meta.dir, "__fixtures__", "legal-layout-baseline.json")

  it("page 1, page 9, the last page and the signature page lay out as the baseline", () => {
    const laid = lay(longContract())
    const texts = laid.commands.filter(
      (c): c is Extract<DrawCommand, { op: "drawText" }> => c.op === "drawText",
    )
    const signaturePage = texts.find((t) => t.text === "Page")?.page
    const sig = texts.find((t) => t.text === "signature" && t.font === "serifBold")?.page
    const last = laid.pageCount - 1
    const pages = { first: 0, ninth: 8, last, signature: sig ?? signaturePage ?? last }
    const snapshot = Object.fromEntries(
      Object.entries(pages).map(([name, page]) => [
        name,
        {
          page: page + 1,
          words: texts
            .filter((t) => t.page === page)
            .map((t) => `${t.text}|${t.x.toFixed(1)}|${t.y.toFixed(1)}|${t.size}|${t.font}`),
        },
      ]),
    )
    const actual = { pageCount: laid.pageCount, pages: snapshot }
    if (process.env.LEGAL_LAYOUT_BASELINE_WRITE === "1") {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")))
    // The page rules: no typed number in the body, no date on a frozen page.
    const allText = texts.map((t) => t.text).join(" ")
    expect(allText).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)
  })
})
