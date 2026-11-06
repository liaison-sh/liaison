// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A money field in minor units holds a whole number: 41940 is 419.40. There is one reading of such
// a field, used by the check that refuses a call, the card a person approves and the code that
// issues, so no two of them can disagree on what a value means. A value with a decimal point has
// no safe reading ("899.00" could be 899 cents or 899 euros), so it is refused, never guessed.

const WHOLE_NUMBER = /^-?\d+$/
const PLAIN_DECIMAL = /^(-?)(\d+)\.(\d+)$/

/**
 * The amount in a minor-unit field as a bigint: a bigint, a whole number, or the string form of a
 * whole number. Anything else is null: a fraction, a decimal point, a currency sign, an exponent.
 */
export function readMinorAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value === "string" && WHOLE_NUMBER.test(value.trim())) return BigInt(value.trim())
  return null
}

function shown(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 80)
  } catch {
    return String(value).slice(0, 80)
  }
}

/**
 * What to tell a caller whose minor-unit field holds `value`: the amount as read, and what to send
 * under each thing it could have meant. `field` names the field as the caller wrote it.
 */
export function minorAmountRefusal(field: string, value: unknown): string {
  const decimal = PLAIN_DECIMAL.exec(
    typeof value === "number" ? String(value) : String(value ?? "").trim(),
  )
  if (!decimal || (typeof value !== "number" && typeof value !== "string")) {
    return (
      `${field} is ${shown(value)}, which is not a whole number of minor units, so nothing was done. ` +
      `Send a whole number with no currency sign, separator or decimal point: 41940 for 419.40.`
    )
  }
  const [, sign, whole, fraction] = decimal as unknown as [string, string, string, string]
  const typed = `${sign}${whole}.${fraction}`
  const asMajor = fraction.length <= 2 ? BigInt(`${sign}${whole}${fraction.padEnd(2, "0")}`) : null
  const down = BigInt(`${sign}${whole}`)
  const isWhole = /^0+$/.test(fraction)
  const asCents = isWhole
    ? `If you meant ${down} minor units, send ${down}.`
    : `If you meant ${typed} minor units, round it to a whole number: send ${down} or ${down + (sign ? -1n : 1n)}.`
  return (
    `${field} is ${shown(value)}, and an amount in minor units is a whole number, so nothing was done. ` +
    (asMajor !== null ? `If you meant ${typed} in currency units, send ${asMajor}. ` : "") +
    asCents
  )
}
