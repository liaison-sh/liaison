// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Defence in depth on the send path: before anything reaches Pennylane, the adapter re-reads the
// CII the caller hands over and refuses unless it is a domestic B2B e-invoice for exactly the
// invoice and buyer named in the call: BAR note B2B, invoice (380) or credit note (381), BT-1 =
// the invoice number, BT-2 = the issue date, buyer legal id (BT-47) a 9-digit SIREN under scheme
// 0002 equal to the buyer's, buyer country FR. The caller already checked eligibility from its own
// data; this check holds even if the caller is wrong.

export interface CiiFacts {
  number: string | null
  typeCode: string | null
  issueDate: string | null
  barNote: string | null
  buyerSiren: string | null
  buyerSirenScheme: string | null
  buyerCountry: string | null
}

function decode(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function first(re: RegExp, s: string): string | null {
  const m = re.exec(s)
  return m ? decode(m[1]!.trim()) : null
}

export function ciiFacts(xml: string): CiiFacts {
  const doc = /<rsm:ExchangedDocument>([\s\S]*?)<\/rsm:ExchangedDocument>/.exec(xml)?.[1] ?? ""
  const buyer = /<ram:BuyerTradeParty>([\s\S]*?)<\/ram:BuyerTradeParty>/.exec(xml)?.[1] ?? ""
  const legal =
    /<ram:SpecifiedLegalOrganization>([\s\S]*?)<\/ram:SpecifiedLegalOrganization>/.exec(
      buyer,
    )?.[1] ?? ""
  const legalId = /<ram:ID(?:\s+schemeID="([^"]*)")?>([^<]*)<\/ram:ID>/.exec(legal)
  const rawDate = first(
    /<ram:IssueDateTime>\s*<udt:DateTimeString[^>]*>(\d{8})<\/udt:DateTimeString>/,
    doc,
  )
  let barNote: string | null = null
  for (const m of doc.matchAll(/<ram:IncludedNote>([\s\S]*?)<\/ram:IncludedNote>/g)) {
    if (/<ram:SubjectCode>BAR<\/ram:SubjectCode>/.test(m[1]!))
      barNote = first(/<ram:Content>([\s\S]*?)<\/ram:Content>/, m[1]!)
  }
  return {
    number: first(/^\s*<ram:ID>([^<]*)<\/ram:ID>/, doc),
    typeCode: first(/<ram:TypeCode>([^<]*)<\/ram:TypeCode>/, doc),
    issueDate: rawDate
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : null,
    barNote,
    buyerSiren: legalId ? legalId[2]!.trim() : null,
    buyerSirenScheme: legalId ? (legalId[1] ?? null) : null,
    buyerCountry: first(
      /<ram:PostalTradeAddress>[\s\S]*?<ram:CountryID>([^<]*)<\/ram:CountryID>/,
      buyer,
    ),
  }
}

/** The reasons the CII does not describe this domestic B2B e-invoice (empty = eligible). */
export function eligibilityProblems(
  xml: string,
  expected: { invoice_number: string; issue_date: string; buyer_siren: string },
): string[] {
  if (typeof xml !== "string" || !xml.includes("CrossIndustryInvoice"))
    return ["the CII XML is missing"]
  const f = ciiFacts(xml)
  const out: string[] = []
  if (f.barNote !== "B2B") out.push(`BAR note is ${f.barNote ?? "absent"}, not B2B`)
  if (f.typeCode !== "380" && f.typeCode !== "381")
    out.push(`document type ${f.typeCode ?? "absent"} is not an invoice or credit note`)
  if (f.number !== expected.invoice_number)
    out.push(`BT-1 ${f.number ?? "absent"} differs from ${expected.invoice_number}`)
  if (f.issueDate !== expected.issue_date)
    out.push(`BT-2 ${f.issueDate ?? "absent"} differs from ${expected.issue_date}`)
  if (f.buyerSirenScheme !== "0002" || !/^\d{9}$/.test(f.buyerSiren ?? ""))
    out.push("buyer legal id (BT-47) is not a SIREN under scheme 0002")
  else if (f.buyerSiren !== expected.buyer_siren)
    out.push(`buyer SIREN ${f.buyerSiren} differs from ${expected.buyer_siren}`)
  if (f.buyerCountry !== "FR") out.push(`buyer country is ${f.buyerCountry ?? "absent"}, not FR`)
  return out
}
