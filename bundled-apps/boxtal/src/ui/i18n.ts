// SPDX-License-Identifier: FSL-1.1-ALv2
//
// This app's copy in the reader's language, keyed by the English text with the French beside it
// (i18n-fr.ts), the same scheme as the invoicing app. The host hands over the reader's locale; a
// string with no French entry falls back to English, and i18n.test.ts fails on such a gap.
import { hostLocale } from "@liaison/host"
import { FR } from "./i18n-fr"

export type TrParams = Record<string, string | number>

function interpolate(text: string, params?: TrParams): string {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
    params[name] === undefined ? m : String(params[name]),
  )
}

/** `english` in the reader's language, `{{name}}` placeholders filled. */
export function tr(english: string, params?: TrParams): string {
  const text = hostLocale().startsWith("fr") ? (FR[english] ?? english) : english
  return interpolate(text, params)
}
