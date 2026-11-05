// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Turning projected connector records into what a person reads. The keys and
// values come from whatever system the adapter maps, so nothing here assumes a
// schema: a field reads as a date only when its name says so AND its value
// parses, as money only when its name says so AND a currency code sits beside
// it. Anything else prints as itself. No NaN, no 1970, no guessed currency.

import type { ProjectedObject, ProjectedValue } from "@liaison/api-connector-core/contract"
import type { I18nValue } from "~/modules/i18n/i18n-context"

type Formatters = Pick<I18nValue, "fmtDate" | "fmtNumber" | "fmtCurrency">

/**
 * `lifetime_value`, `lifetimeValue`, `lifetime-value` all read "Lifetime value".
 * A nested path reads whole, so two `name` fields stay apart:
 * `account_manager.name` is "Account manager name". A list index
 * (`lines.0.sku`) is not a word and is left out.
 */
export function humanizeKey(key: string): string {
  const words = key
    .split(".")
    .filter((segment) => !/^\d+$/.test(segment))
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key
}

/** Dotted paths to scalar (or scalar array) values, in insertion order. */
export function flattenRecord(
  record: ProjectedObject,
  prefix = "",
): Array<[string, Exclude<ProjectedValue, ProjectedObject>]> {
  const out: Array<[string, Exclude<ProjectedValue, ProjectedObject>]> = []
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenRecord(value, path))
    } else {
      out.push([path, value])
    }
  }
  return out
}

const DATE_KEY_SNAKE = /(^|[_-])(date|at|time|day|on)$/i
const DATE_KEY_CAMEL = /[a-z0-9](Date|At|Time|Day)$/
const DATE_KEY_PREFIX = /^(date|created|updated|due|issued|closed)/i
const AMOUNT_KEY = /(total|amount|value|price|balance|revenue|sum)$/i
const CURRENCY_KEY = /^(currency|currency_?code)$/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** A timestamp a person would believe: parseable, and after 1971 (an epoch-zero date is a missing one). */
function plausibleTime(value: string | number): number | null {
  const at = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(at)) return null
  if (at < Date.UTC(1971, 0, 1)) return null
  return at
}

function currencyOf(siblings: ProjectedObject | undefined): string | null {
  if (!siblings) return null
  for (const [key, value] of Object.entries(siblings)) {
    if (CURRENCY_KEY.test(key) && typeof value === "string" && /^[A-Za-z]{3}$/.test(value)) {
      return value.toUpperCase()
    }
  }
  return null
}

export function isDateKey(key: string): boolean {
  const last = key.split(".").pop() ?? key
  return DATE_KEY_SNAKE.test(last) || DATE_KEY_CAMEL.test(last) || DATE_KEY_PREFIX.test(last)
}

export function isAmountKey(key: string): boolean {
  return AMOUNT_KEY.test(key.split(".").pop() ?? key)
}

export function isCurrencyKey(key: string): boolean {
  return CURRENCY_KEY.test(key.split(".").pop() ?? key)
}

/**
 * Where an amount's currency comes from: the value's own record (a currency
 * field beside it), or a code already known for the whole record (a customer
 * match's `currency`), which wins.
 */
export interface MoneyContext {
  siblings?: ProjectedObject
  currency?: string
}

/** One value as text, formatted for the UI locale when its key and its value agree on a kind. */
export function formatValue(
  key: string,
  value: ProjectedValue,
  fmt: Formatters,
  money: MoneyContext = {},
  /** A list row's date: the short style, so it fits on one line beside the title. */
  opts: { compactDate?: boolean } = {},
): string {
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== null && v !== "")
      .map((v) => String(v))
      .join(", ")
  }
  if (typeof value === "object") return ""
  if (typeof value === "boolean") return String(value)

  if (isDateKey(key) && (typeof value === "string" || typeof value === "number")) {
    const at = plausibleTime(value)
    if (at !== null) {
      const dateOnly = typeof value === "string" && DATE_ONLY.test(value)
      const dateStyle = opts.compactDate ? "short" : "medium"
      return fmt.fmtDate(at, dateOnly ? { dateStyle, timeZone: "UTC" } : { dateStyle })
    }
    return typeof value === "string" ? value : ""
  }

  if (typeof value === "number") {
    const numeric = value
    if (!Number.isFinite(numeric)) return ""
    const currency = isAmountKey(key) ? (money.currency ?? currencyOf(money.siblings)) : null
    if (currency) {
      try {
        return fmt.fmtCurrency(numeric, currency)
      } catch {
        return fmt.fmtNumber(numeric)
      }
    }
    return fmt.fmtNumber(numeric)
  }
  return value
}

/** Only an absolute http(s) URL becomes a link out; anything else is dropped. */
export function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

/** Summary keys the card uses for itself rather than listing as fields. */
export const SUMMARY_RESERVED_KEYS = new Set(["id", "name", "url"])

/** The lists a customer card shows, each with its own idea of what names a row. */
export type RowRole = "orders" | "invoices" | "deals"

/**
 * Top-level keys that title a row, by preference. Only the record's own
 * fields: a nested object's `name` is someone else's (a deal's owner).
 */
const TITLE_KEYS: Record<RowRole, readonly string[]> = {
  deals: ["title", "name", "subject", "id"],
  orders: ["number", "id"],
  invoices: ["number", "id"],
}
const STATUS_KEYS = ["status", "stage", "state"]

export interface RowParts {
  title: string
  date: string
  amount: string
  status: string
}

/**
 * The four things a short list row shows: what it is (its role's title field),
 * when, how much, and where it stands. The record's own fields come before a
 * nested object's, and the title is only ever the record's own. Each part may
 * be empty; nothing is invented.
 */
export function rowParts(record: ProjectedObject, fmt: Formatters, role: RowRole): RowParts {
  const flat = flattenRecord(record)
  const own = flat.filter(([key]) => !key.includes("."))
  const nested = flat.filter(([key]) => key.includes("."))
  const lastOf = (key: string) => (key.split(".").pop() ?? key).toLowerCase()
  const find = (pred: (key: string) => boolean) =>
    own.find(([key]) => pred(key)) ?? nested.find(([key]) => pred(key))
  const byName = (names: readonly string[]) =>
    names.map((n) => find((key) => lastOf(key) === n)).find(Boolean)

  const title = TITLE_KEYS[role]
    .map((t) => own.find(([key]) => key.toLowerCase() === t))
    .find(Boolean)
  const status = byName(STATUS_KEYS)
  const date = find(isDateKey)
  const amount = find(isAmountKey)
  const money = { siblings: record }

  return {
    title: title ? formatValue(title[0], title[1], fmt, money) : "",
    date: date ? formatValue(date[0], date[1], fmt, money, { compactDate: true }) : "",
    amount: amount ? formatValue(amount[0], amount[1], fmt, money) : "",
    status: status ? formatValue(status[0], status[1], fmt, money) : "",
  }
}
