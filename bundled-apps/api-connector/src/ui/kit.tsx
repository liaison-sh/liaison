// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The few host primitives these screens use, inside the app frame: the copy in
// the reader's language (en.json / fr.json, keyed like the host's catalog),
// buttons, inputs and skeletons in the host's look, and the date format.

import { hostLocale } from "@liaison/host"
import { type Component, type JSX, Show, splitProps } from "solid-js"
import EN from "./en.json"
import FR from "./fr.json"

export type TParams = Record<string, string | number>

function lookup(tree: unknown, path: string[]): string | null {
  let node = tree
  for (const seg of path) {
    if (!node || typeof node !== "object") return null
    node = (node as Record<string, unknown>)[seg]
  }
  return typeof node === "string" ? node : null
}

/** `key` ("api-connector.settings.add" or "settings.add") in the reader's language. */
export function t(key: string, params?: TParams): string {
  const path = key.replace(/^api-connector\./, "").split(".")
  const fr = hostLocale().startsWith("fr")
  const text = (fr ? lookup(FR, path) : null) ?? lookup(EN, path) ?? key
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
    params[name] === undefined ? m : String(params[name]),
  )
}

export interface I18nValue {
  t: (key: string, params?: TParams) => string
  locale: () => string
  fmtDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
  fmtNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  fmtCurrency: (value: number, currency: string) => string
}

/** The same shape the host's i18n context has, so the screens read alike. */
export function useI18n(): I18nValue {
  const locale = () => hostLocale()
  return {
    t,
    locale,
    fmtDate: (v, o) => new Intl.DateTimeFormat(locale(), o).format(v),
    fmtNumber: (v, o) => new Intl.NumberFormat(locale(), o).format(v),
    fmtCurrency: (v, c) => {
      try {
        return new Intl.NumberFormat(locale(), { style: "currency", currency: c }).format(v)
      } catch {
        return `${new Intl.NumberFormat(locale()).format(v)} ${c}`
      }
    },
  }
}

export function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return ""
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return ""
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)
}

/** A narrow frame (a phone, or the header card on a tablet). */
export function narrowFrame(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 1024
}

const BUTTON: Record<string, string> = {
  primary: "bg-accent text-accent-contrast hover:opacity-90",
  ghost: "bg-transparent text-text hover:bg-surface-hover",
  danger: "bg-error text-white hover:opacity-90",
  secondary: "border border-border bg-surface text-text hover:bg-surface-hover",
  outline: "border border-border bg-transparent text-text hover:bg-surface-hover",
}

export const Button: Component<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger" | "secondary" | "outline"
    size?: "sm" | "md"
    loading?: boolean
  }
> = (props) => {
  const [own, rest] = splitProps(props, ["variant", "size", "loading", "class", "children", "disabled"])
  return (
    <button
      type="button"
      {...rest}
      disabled={own.disabled || own.loading}
      aria-busy={own.loading ? "true" : undefined}
      class={`inline-flex items-center gap-1 rounded-md font-medium disabled:opacity-50 ${
        own.size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"
      } ${BUTTON[own.variant ?? "primary"]} ${own.class ?? ""}`}
    >
      {own.children}
    </button>
  )
}

export const Input: Component<JSX.InputHTMLAttributes<HTMLInputElement> & { label?: string }> = (
  props,
) => {
  const [own, rest] = splitProps(props, ["label", "class"])
  return (
    <label class="flex flex-col gap-1 text-sm">
      <Show when={own.label}>
        <span class="text-text-secondary">{own.label}</span>
      </Show>
      <input
        {...rest}
        class={`rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none ${own.class ?? ""}`}
      />
    </label>
  )
}

export const Skeleton: Component<{ class?: string }> = (props) => (
  <div class={`animate-pulse rounded bg-surface-hover ${props.class ?? ""}`} />
)
