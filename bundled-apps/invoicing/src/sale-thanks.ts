// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail a buyer gets for a sale: one per sale, whatever stream it came from, with every
// invoice of the sale attached (their legal originals).
//
//  - An issuer profile that opted in (`sale_thanks_enabled`) sends `sale_thanks`: a branded HTML
//    mail (the issuer's logo inline, a greeting, the purchase lines and total, the invoice
//    numbers, the issuer's legal footer) with a plain-text part, in French or English by the
//    buyer's language, else the issuer's. Its words are editable per profile in
//    `email_templates.sale_thanks` / `sale_thanks_fr` ({subject, html, text}).
//  - Any other profile keeps today's plain `invoice_paid` mail, sent only when
//    `auto_email_enabled` is on.
// The mail goes from the issuer profile's own mailbox (`mail_account_id`); without one it does not
// go, and the caller parks the sale `issuer_mail_account_missing` as before.
import { formatMoneyMinor } from "./money"

export type ThanksLanguage = "en" | "fr"

export interface ThanksIssuer {
  legal_name: string
  address?: string | null
  vat_id?: string | null
  siren?: string | null
  legal_form?: string | null
  share_capital?: string | null
  rcs_city?: string | null
  logo_file_id?: string | null
  default_language?: string | null
  email_templates?: Record<
    string,
    { subject?: string; body?: string; html?: string; text?: string }
  >
}

export interface ThanksInput {
  issuer: ThanksIssuer
  buyer: { name?: string | null; language?: string | null }
  /** The invoices of the sale, in issue order. */
  documents: Array<{
    number: string
    grand_total_minor: bigint | string | number
    currency: string
  }>
  /** The purchase lines as the buyer bought them (VAT included). */
  lines: Array<{
    description: string
    quantity: string | number
    total_minor: bigint | string | number
  }>
  /** YYYY-MM-DD, the sale date. */
  sold_on: string
  /** A sale invoiced later than it was paid (a catch-up): the mail says which purchase it is. */
  late?: boolean
}

export interface ThanksMail {
  subject: string
  html: string
  text: string
  language: ThanksLanguage
  /** The content id the HTML's logo refers to, when the issuer has a logo. */
  logoContentId: string | null
}

const LOGO_CID = "issuer-logo"

const COPY: Record<
  ThanksLanguage,
  {
    subject: string
    lateSubject: string
    greeting: (name: string | null) => string
    intro: string
    lateIntro: (date: string) => string
    invoices: (n: number) => string
    total: string
    attached: string
    quantity: string
  }
> = {
  en: {
    subject: "Thank you for your purchase: invoice {{numbers}}",
    lateSubject: "Your invoice {{numbers}} for your purchase of {{sale_date}}",
    greeting: (n) => (n ? `Hello ${n},` : "Hello,"),
    intro: "Thank you for your purchase. Here is what you bought.",
    lateIntro: (d) => `Here is your invoice for your purchase of ${d}.`,
    invoices: (n) => (n > 1 ? "Invoices" : "Invoice"),
    total: "Total",
    attached: "Your invoice is attached to this email as a PDF.",
    quantity: "Qty",
  },
  fr: {
    subject: "Merci pour votre achat : facture {{numbers}}",
    lateSubject: "Votre facture {{numbers}} pour votre achat du {{sale_date}}",
    greeting: (n) => (n ? `Bonjour ${n},` : "Bonjour,"),
    intro: "Merci pour votre achat. Voici ce que vous avez acheté.",
    lateIntro: (d) => `Voici votre facture pour votre achat du ${d}.`,
    invoices: (n) => (n > 1 ? "Factures" : "Facture"),
    total: "Total",
    attached: "Votre facture est jointe à ce message au format PDF.",
    quantity: "Qté",
  },
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** The buyer's language when it is French or English, else the issuer's, else English. */
export function thanksLanguage(buyer?: string | null, issuer?: string | null): ThanksLanguage {
  const pick = (v?: string | null) => (v ?? "").trim().slice(0, 2).toLowerCase()
  const b = pick(buyer)
  if (b === "fr" || b === "en") return b
  return pick(issuer) === "fr" ? "fr" : "en"
}

function dateWords(iso: string, lang: ThanksLanguage): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return lang === "fr" ? `${m[3]}/${m[2]}/${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`
}

/** The money total of the sale's invoices, per currency ("120.00 EUR"). */
function totalWords(docs: ThanksInput["documents"]): string {
  const by = new Map<string, bigint>()
  for (const d of docs) by.set(d.currency, (by.get(d.currency) ?? 0n) + BigInt(d.grand_total_minor))
  return [...by].map(([c, v]) => formatMoneyMinor(v, c)).join(" + ")
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => values[k] ?? all)
}

/** The issuer's legal footer: name, address, legal form and capital, SIREN and RCS, VAT number. */
export function legalFooter(i: ThanksIssuer): string[] {
  const form = [i.legal_form, i.share_capital ? `capital ${i.share_capital} €` : null]
    .filter(Boolean)
    .join(", ")
  const reg = [i.siren ? `SIREN ${i.siren}` : null, i.rcs_city ? `RCS ${i.rcs_city}` : null]
    .filter(Boolean)
    .join(" · ")
  return [
    i.legal_name,
    form,
    (i.address ?? "").replace(/\s*\n\s*/g, ", "),
    reg,
    i.vat_id ? `TVA / VAT ${i.vat_id}` : "",
  ].filter((l) => l.trim() !== "")
}

/** The `sale_thanks` mail of one sale. Pure: the caller sends it. */
export function renderSaleThanks(input: ThanksInput): ThanksMail {
  const lang = thanksLanguage(input.buyer.language, input.issuer.default_language)
  const c = COPY[lang]
  const tpl =
    (lang === "fr" ? input.issuer.email_templates?.sale_thanks_fr : undefined) ??
    input.issuer.email_templates?.sale_thanks ??
    {}
  const numbers = input.documents.map((d) => d.number).join(", ")
  const saleDate = dateWords(input.sold_on, lang)
  const name = (input.buyer.name ?? "").trim() || null
  const values = {
    numbers,
    sale_date: saleDate,
    buyer_name: name ?? "",
    issuer_name: input.issuer.legal_name,
    total: totalWords(input.documents),
  }
  const subject = fill(tpl.subject ?? (input.late ? c.lateSubject : c.subject), values)
  const intro = input.late ? c.lateIntro(saleDate) : c.intro
  const textIntro = tpl.text ? fill(tpl.text, values) : `${c.greeting(name)}\n\n${intro}`
  // An edited HTML intro is the issuer's own markup; the values put into it are escaped.
  const escaped = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escapeHtml(v)]))
  const htmlIntro = tpl.html
    ? fill(tpl.html, escaped)
    : `<p>${escapeHtml(c.greeting(name))}</p><p>${escapeHtml(intro)}</p>`
  const currency = input.documents[0]?.currency ?? "EUR"
  const lineRows = input.lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 0">${escapeHtml(l.description)}</td>` +
        `<td style="padding:6px 8px;text-align:right;color:#6b6b6b">${escapeHtml(String(l.quantity))}</td>` +
        `<td style="padding:6px 0;text-align:right">${escapeHtml(formatMoneyMinor(l.total_minor, currency))}</td></tr>`,
    )
    .join("")
  const footer = legalFooter(input.issuer)
  const logo = input.issuer.logo_file_id
    ? `<p><img src="cid:${LOGO_CID}" alt="${escapeHtml(input.issuer.legal_name)}" style="max-height:48px"></p>`
    : `<p style="font-size:18px;font-weight:600">${escapeHtml(input.issuer.legal_name)}</p>`
  const html =
    `<!doctype html><html lang="${lang}"><body style="margin:0;background:#ffffff">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1f1f1f;line-height:1.5">` +
    logo +
    htmlIntro +
    `<table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5">` +
    `<thead><tr style="font-size:12px;color:#6b6b6b"><th style="text-align:left;padding:6px 0;font-weight:normal"></th>` +
    `<th style="text-align:right;padding:6px 8px;font-weight:normal">${escapeHtml(c.quantity)}</th><th></th></tr></thead>` +
    `<tbody>${lineRows}</tbody>` +
    `<tfoot><tr><td style="padding:8px 0;font-weight:600">${escapeHtml(c.total)}</td><td></td>` +
    `<td style="padding:8px 0;text-align:right;font-weight:600">${escapeHtml(values.total)}</td></tr></tfoot></table>` +
    `<p>${escapeHtml(c.invoices(input.documents.length))} ${escapeHtml(numbers)}. ${escapeHtml(c.attached)}</p>` +
    `<p style="margin-top:24px;font-size:11px;color:#6b6b6b">${footer.map(escapeHtml).join("<br>")}</p>` +
    `</div></body></html>`
  const textLines = input.lines.map(
    (l) => `- ${l.description} x${l.quantity}: ${formatMoneyMinor(l.total_minor, currency)}`,
  )
  const text = [
    textIntro,
    "",
    ...textLines,
    `${c.total}: ${values.total}`,
    "",
    `${c.invoices(input.documents.length)} ${numbers}. ${c.attached}`,
    "",
    "--",
    ...footer,
  ].join("\n")
  return {
    subject,
    html,
    text,
    language: lang,
    logoContentId: input.issuer.logo_file_id ? LOGO_CID : null,
  }
}

/** Today's plain invoice mail (`invoice_paid`), unchanged for profiles that did not opt in. */
export function renderInvoicePaid(
  issuer: ThanksIssuer,
  numbers: string,
): { subject: string; text: string } {
  const tpl = issuer.email_templates?.invoice_paid ?? {}
  return {
    subject: (tpl.subject ?? "Invoice {{number}}").replace("{{number}}", numbers),
    text: (tpl.body ?? "Please find your invoice attached.").replace("{{number}}", numbers),
  }
}

export type SaleMailPlan =
  | { kind: "none" }
  | { kind: "no_mailbox" }
  | {
      kind: "thanks" | "invoice_paid"
      params: {
        accountId: string
        to: string[]
        subject: string
        textBody: string
        htmlBody?: string
        attachments: string[]
        inlineImages?: Array<{ fileId: string; contentId: string }>
      }
    }

/**
 * Which mail a sale gets, as the `mail:composeForApp` call to make: the branded thanks for an
 * issuer that opted in, today's plain invoice mail when auto-email is on, else none.
 */
export function planSaleMail(params: {
  issuer: ThanksIssuer & {
    sale_thanks_enabled?: boolean | null
    auto_email_enabled?: boolean | null
    mail_account_id?: string | null
  }
  to: string
  attachments: string[]
  thanks: Omit<ThanksInput, "issuer">
}): SaleMailPlan {
  const { issuer } = params
  const thanks = issuer.sale_thanks_enabled === true
  if (!thanks && issuer.auto_email_enabled !== true) return { kind: "none" }
  if (!issuer.mail_account_id) return { kind: "no_mailbox" }
  if (!thanks) {
    const plain = renderInvoicePaid(issuer, params.thanks.documents.map((d) => d.number).join(", "))
    return {
      kind: "invoice_paid",
      params: {
        accountId: issuer.mail_account_id,
        to: [params.to],
        subject: plain.subject,
        textBody: plain.text,
        attachments: params.attachments,
      },
    }
  }
  const mail = renderSaleThanks({ ...params.thanks, issuer })
  return {
    kind: "thanks",
    params: {
      accountId: issuer.mail_account_id,
      to: [params.to],
      subject: mail.subject,
      textBody: mail.text,
      htmlBody: mail.html,
      attachments: params.attachments,
      ...(mail.logoContentId && issuer.logo_file_id
        ? { inlineImages: [{ fileId: issuer.logo_file_id, contentId: mail.logoContentId }] }
        : {}),
    },
  }
}
