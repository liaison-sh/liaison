// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing documents whose drawing outside a demo workspace is pinned: one
// fixture per document type and layout (short, several pages, an issuer whose
// identity takes two footer lines). The goldens beside them were written from
// the templates as they were before the demo footer existed, so a change that
// moves one command or one word of a real document fails the comparison.
// `writeGoldens()` rewrites them, on purpose only (then `biome format --write` them).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DrawCommand } from "@liaison/app-sdk"
import { renderTemplate as creditNoteTemplate } from "../../../../../bundled-apps/invoicing/templates/credit_note"
import { renderTemplate as invoiceTemplate } from "../../../../../bundled-apps/invoicing/templates/invoice"
import { renderTemplate as poTemplate } from "../../../../../bundled-apps/invoicing/templates/po"
import { renderTemplate as proformaTemplate } from "../../../../../bundled-apps/invoicing/templates/proforma"
import { renderTemplate as quoteTemplate } from "../../../../../bundled-apps/invoicing/templates/quote"
import type {
  DocumentRenderInput,
  LineItem,
} from "../../../../../bundled-apps/invoicing/templates/shared"
import { extractPdfText } from "./pdf-text"
import { replayDrawCommands } from "./replay"

export const GOLDEN_DIR = path.join(import.meta.dir, "__goldens__", "specimen")

export const TEMPLATES = {
  invoice: invoiceTemplate,
  quote: quoteTemplate,
  proforma: proformaTemplate,
  purchase_order: poTemplate,
  credit_note: creditNoteTemplate,
} as const
export type GoldenDocType = keyof typeof TEMPLATES

export function line(position: number, description: string): LineItem {
  return {
    position,
    description,
    quantity: "1",
    unit_price_minor: 10000n,
    tax_rate_bp: 2000,
    subtotal_minor: 10000n,
    tax_minor: 2000n,
    total_minor: 12000n,
  }
}

/** A document of `type` with `lines` line items; `french` gives the issuer a two-line identity. */
export function documentInput(
  type: GoldenDocType,
  lines: number,
  opts: { french?: boolean } = {},
): DocumentRenderInput {
  const items = Array.from({ length: lines }, (_, i) =>
    line(i + 1, `Design and build work, part ${i + 1} of the agreed scope`),
  )
  const n = BigInt(lines)
  return {
    document: {
      type,
      number: `DOC-2026-${String(lines).padStart(4, "0")}`,
      issued_at: "2026-05-15",
      due_at: "2026-06-14",
      currency: "EUR",
      subtotal_minor: 10000n * n,
      tax_total_minor: 2000n * n,
      grand_total_minor: 12000n * n,
      tax_treatment: "standard",
      incoterm: "DAP",
      ...(type === "credit_note"
        ? {
            original_invoice_number: "DOC-2026-0001",
            original_invoice_date: "2026-05-01",
            reason: "Refund",
          }
        : {}),
    },
    issuer: {
      legal_name: opts.french
        ? "Exemple Conseil et Réalisation de Projets Numériques SAS"
        : "Example Works Ltd",
      country: opts.french ? "FR" : "GB",
      vat_id: opts.french ? "FR12345678901" : "GB123456789",
      address: "1 Example Street, Example Town",
      iban: "FR7630006000011234567890189",
      swift_bic: "BNPAFRPP",
      bank_name: "Example Bank",
      default_language: opts.french ? "fr" : "en",
      ...(opts.french
        ? {
            siren: "123 456 789",
            legal_form: "SAS",
            share_capital: "10 000",
            rcs_city: "Paris",
          }
        : {}),
    },
    counterparty: {
      legal_name: "Example Client SARL",
      country: "FR",
      vat_id: "FR98765432109",
      address: "2 Client Avenue, 69001 Lyon",
    },
    line_items: items,
    legal_mention: "",
    requires_hs_code: false,
  } as DocumentRenderInput
}

/** The pinned layouts: name, type, lines, french. */
export const GOLDEN_CASES: ReadonlyArray<{
  name: string
  type: GoldenDocType
  lines: number
  french: boolean
}> = (Object.keys(TEMPLATES) as GoldenDocType[]).flatMap((type) => [
  { name: `${type}-short`, type, lines: 1, french: false },
  { name: `${type}-pages`, type, lines: 60, french: true },
])

/** Commands as stable JSON (money values are bigint in the template input). */
export function commandsJson(cmds: DrawCommand[]): string {
  return `${JSON.stringify(cmds, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}\n`
}

export async function pageText(cmds: DrawCommand[]): Promise<string> {
  return await extractPdfText(await replayDrawCommands(cmds))
}

export function goldenPaths(name: string): { draw: string; text: string } {
  return {
    draw: path.join(GOLDEN_DIR, `${name}.draw.json`),
    text: path.join(GOLDEN_DIR, `${name}.text.txt`),
  }
}

export function readGolden(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null
}

/** Write every golden from the templates as they are now (`SPECIMEN_GOLDEN_WRITE=1`). */
export async function writeGoldens(): Promise<void> {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  for (const c of GOLDEN_CASES) {
    const cmds = TEMPLATES[c.type](documentInput(c.type, c.lines, { french: c.french }))
    const p = goldenPaths(c.name)
    writeFileSync(p.draw, commandsJson(cmds))
    writeFileSync(p.text, `${await pageText(cmds)}\n`)
  }
}
