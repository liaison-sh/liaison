// SPDX-License-Identifier: FSL-1.1-ALv2
// Identity validators and name matching for counterparties. Pure.

function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/[\s.]/g, "")
}

function luhn(s: string): boolean {
  let sum = 0
  const rev = [...s].reverse()
  for (let i = 0; i < rev.length; i++) {
    let d = Number(rev[i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

export function isValidSiren(v: string | null | undefined): boolean {
  const s = digits(v)
  return /^\d{9}$/.test(s) && luhn(s)
}

export function isValidSiret(v: string | null | undefined): boolean {
  const s = digits(v)
  if (!/^\d{14}$/.test(s)) return false
  if (s.startsWith("356000000")) {
    // La Poste establishments: the digit sum must be a multiple of 5 instead of Luhn.
    return [...s].reduce((a, c) => a + Number(c), 0) % 5 === 0
  }
  return isValidSiren(s.slice(0, 9)) && luhn(s)
}

/** SIREN encoded in a French VAT number (numeric key only); null when it cannot be trusted. */
export function sirenFromFrVat(
  vat: string | null | undefined,
  opts: { billingCountry: string | null | undefined },
): string | null {
  if ((opts.billingCountry ?? "").trim().toUpperCase() === "MC") return null
  const m = /^FR(\d{2})(\d{9})$/.exec((vat ?? "").replace(/[\s.-]/g, "").toUpperCase())
  if (!m) return null
  const siren = m[2] ?? ""
  const key = (12 + 3 * (Number(siren) % 97)) % 97
  return key === Number(m[1]) ? siren : null
}

/** Legal-form tokens, shared with the customer kind derivation. */
export const LEGAL_FORM_TOKENS: readonly string[] = [
  "sas",
  "sasu",
  "sarl",
  "eurl",
  "sa",
  "snc",
  "sci",
  "scop",
  "scp",
  "selarl",
  "selas",
  "sca",
  "sccv",
  "gie",
  "association",
  "ltd",
  "llc",
  "gmbh",
  "inc",
  "corp",
  "bv",
  "srl",
  "spa",
  "ag",
]

const LEGAL_SET = new Set(LEGAL_FORM_TOKENS)

function tokens(name: string | null | undefined): string[] {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !LEGAL_SET.has(t))
}

export function normaliseCompanyName(name: string | null | undefined): string {
  return tokens(name).join(" ")
}

function levenshtein(a: string, b: string): number {
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub)
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return false
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.every((t, i) => long[i] === t)) return true
  const na = ta.join(" ")
  const nb = tb.join(" ")
  const sim = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length)
  return sim >= 0.85
}

/** Only registry-checked writes set `confirmed_via`; a derived SIREN is never confirmed by itself. */
export function isSirenConfirmed(identity: { confirmed_via?: string | null; siren?: string | null; source?: string | null } | null | undefined): boolean {
  return !!identity?.confirmed_via
}
