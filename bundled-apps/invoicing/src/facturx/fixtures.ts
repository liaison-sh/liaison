// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test fixtures for the Factur-X builder: fictional parties with Luhn-valid SIRENs, and a
// matrix of documents (type x currency x operation category x payment state).

import { lineSubtotal, lineTax } from "../money"
import type { FacturxInput, FacturxLine, OperationCategory, PaymentState } from "./cii"

export const SELLER = {
  legal_name: "Maison Exemple SAS",
  siren: "732829320",
  routing_address: "732829320",
  vat_id: "FR44732829320",
  address: {
    line1: "1 rue de l'Exemple",
    line2: null,
    postcode: "75011",
    city: "Paris",
    country_code: "FR",
  },
}

export const BUYER = {
  legal_name: "Client Exemple SARL",
  siren: "356000000",
  routing_address: "356000000",
  vat_id: "FR39356000000",
  address: {
    line1: "2 avenue du Test",
    line2: "Bâtiment B",
    postcode: "69002",
    city: "Lyon",
    country_code: "FR",
  },
}

export function fxLine(
  position: number,
  description: string,
  quantity: string,
  unitMinor: bigint,
  rateBp = 2000,
  discount = 0n,
): FacturxLine {
  const subtotal = lineSubtotal({ quantity, unit_price_minor: unitMinor }) - discount
  return {
    position,
    description,
    quantity,
    unit_price_minor: unitMinor,
    discount_minor: discount,
    tax_rate_bp: rateBp,
    subtotal_minor: subtotal,
    tax_minor: lineTax({ subtotal_minor: subtotal, tax_rate_bp: rateBp }),
  }
}

export function fxDocument(
  over: Partial<FacturxInput> & { lines?: FacturxLine[] } = {},
): FacturxInput {
  const lines = over.lines ?? [
    fxLine(0, "Contrôleur MIDI", "2", 34999n),
    fxLine(1, "Câble USB-C", "3", 1250n, 2000, 250n),
    fxLine(2, "Livre technique", "1", 4200n, 550),
  ]
  const subtotal = lines.reduce((s, l) => s + l.subtotal_minor, 0n)
  const tax = lines.reduce((s, l) => s + l.tax_minor, 0n)
  return {
    type: "invoice",
    number: "FA-2026-0042",
    issue_date: "2026-11-03",
    due_date: "2026-12-03",
    currency: "EUR",
    operation_category: "goods",
    payment_state: "due",
    paid_date: null,
    vat_on_debits: false,
    tax_treatment: "eu_domestic",
    seller: SELLER,
    buyer: BUYER,
    delivery: null,
    po_number: "PO-7781",
    iban: "FR7630006000011234567890189",
    bic: "AGRIFRPP",
    original: null,
    tax_total_eur_minor: null,
    subtotal_minor: subtotal,
    tax_total_minor: tax,
    grand_total_minor: subtotal + tax,
    ...over,
    lines,
  }
}

export interface MatrixCase {
  name: string
  input: FacturxInput
}

/** Every document type x currency x category x payment state the issue paths produce. */
export function conformanceMatrix(): MatrixCase[] {
  const out: MatrixCase[] = []
  const types = ["invoice", "credit_note"] as const
  const currencies = ["EUR", "USD"] as const
  const categories: OperationCategory[] = ["goods", "services", "mixed"]
  const states: PaymentState[] = ["due", "paid"]
  for (const type of types) {
    for (const currency of currencies) {
      for (const operation_category of categories) {
        for (const payment_state of states) {
          if (type === "credit_note" && payment_state === "paid") continue // credit notes emit x1
          const base = fxDocument()
          out.push({
            name: `${type} ${currency} ${operation_category} ${payment_state}`,
            input: {
              ...base,
              type,
              number: type === "credit_note" ? "AV-2026-0007" : base.number,
              currency,
              operation_category,
              payment_state,
              paid_date: payment_state === "paid" ? "2026-11-02" : null,
              due_date: payment_state === "paid" ? null : base.due_date,
              vat_on_debits: operation_category !== "goods",
              original:
                type === "credit_note"
                  ? { number: "FA-2026-0042", issue_date: "2026-11-03" }
                  : null,
              tax_total_eur_minor:
                currency === "EUR" ? null : (base.tax_total_minor * 1000n) / 1085n,
              delivery:
                operation_category === "goods"
                  ? {
                      name: "Entrepôt Client",
                      line1: "9 quai des Livraisons",
                      postcode: "13002",
                      city: "Marseille",
                      country_code: "FR",
                    }
                  : null,
            },
          })
        }
      }
    }
  }
  out.push(...negativeCreditNotes())
  return out
}

/** Credit notes as the product stores them: negative lines mirroring what is reversed. */
export function negativeCreditNotes(): MatrixCase[] {
  const cn = (
    name: string,
    lines: FacturxLine[],
    over: Partial<FacturxInput> = {},
  ): MatrixCase => ({
    name: `credit_note ${name}`,
    input: fxDocument({
      type: "credit_note",
      number: "AV-2026-0008",
      due_date: null,
      original: { number: "FA-2026-0042", issue_date: "2026-11-03" },
      ...over,
      lines,
    }),
  })
  return [
    // Refund / cancellation: every line mirrored with a negated unit price.
    cn("EUR goods refund (negative unit prices)", [
      fxLine(0, "Contrôleur MIDI", "2", -34999n),
      fxLine(1, "Câble USB-C", "3", -1250n),
      fxLine(2, "Livre technique", "1", -4200n, 550),
    ]),
    // Reissue: unit price AND line discount negated.
    cn("EUR goods reissue (negative unit prices and discounts)", [
      fxLine(0, "Contrôleur MIDI", "2", -34999n),
      fxLine(1, "Câble USB-C", "3", -1250n, 2000, -250n),
    ]),
    // A correction written with a negative quantity instead.
    cn("EUR services negative quantity", [fxLine(0, "Prestation de réglage", "-3", 9000n)], {
      operation_category: "services",
      vat_on_debits: true,
    }),
    // Mixed signs: two reversed lines, one line kept against the customer (a restocking fee).
    cn("EUR goods mixed signs", [
      fxLine(0, "Contrôleur MIDI", "1", -34999n),
      fxLine(1, "Câble USB-C", "2", -1250n),
      fxLine(2, "Frais de reconditionnement", "1", 2500n),
    ]),
    // Non-EUR refund: BT-111 is negative as stored too.
    (() => {
      const lines = [
        fxLine(0, "Contrôleur MIDI", "2", -34999n),
        fxLine(1, "Livre technique", "1", -4200n, 550),
      ]
      const tax = lines.reduce((t, l) => t + l.tax_minor, 0n)
      return cn("USD goods refund (negative unit prices)", lines, {
        currency: "USD",
        tax_total_eur_minor: (tax * 1000n) / 1085n,
      })
    })(),
  ]
}
