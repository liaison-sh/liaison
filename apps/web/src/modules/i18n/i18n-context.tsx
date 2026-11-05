// SPDX-License-Identifier: FSL-1.1-ALv2
import { dictionariesFor, type NamespaceDicts, type ShippedLocale } from "@liaison/shared"
import { flatten, resolveTemplate } from "@solid-primitives/i18n"
import {
  type Accessor,
  type Component,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  useContext,
} from "solid-js"
import { createStore } from "solid-js/store"

/**
 * Module-level bridge for the startup hook (runs OUTSIDE the component
 * tree, so it can't use the context `setLocale`). `applyStoredLocale` is
 * called by startup.ts once the session is restored and the persisted
 * `kernel.user_preferences.language` is known (I4). The provider applies
 * it reactively on the next tick — no remount of the keep-alive tabs.
 */
const [storedLocale, setStoredLocale] = createSignal<ShippedLocale | null>(null)

/**
 * The provider's active locale, mirrored at module level for code that runs
 * outside a component (formatters, host services handed to app bundles).
 * Reactive: reading it inside a computation tracks locale switches.
 */
const [activeLocale, setActiveLocale] = createSignal<ShippedLocale>("en")
export function currentLocale(): ShippedLocale {
  return activeLocale()
}

/** Apply the persisted UI language resolved at startup (I4). */
export function applyStoredLocale(next: ShippedLocale): void {
  setStoredLocale(next)
}

export type TranslateParams = Record<string, string | number | boolean>

type FlatDict = Record<string, unknown>

/** Track keys we've already warned about so the console isn't spammed. */
const warned = new Set<string>()

function buildFlat(dicts: NamespaceDicts): FlatDict {
  const out: FlatDict = {}
  for (const [ns, dict] of Object.entries(dicts)) {
    const flat = flatten(dict as Record<string, unknown>)
    for (const [k, v] of Object.entries(flat)) {
      out[`${ns}.${k}`] = v
    }
  }
  return out
}

/** Each locale's flat dict, built once per process — dictionaries are static imports. */
const flatByLocale = new Map<ShippedLocale, FlatDict>()

function flatFor(locale: ShippedLocale): FlatDict {
  let flat = flatByLocale.get(locale)
  if (!flat) {
    flat = buildFlat(dictionariesFor(locale))
    flatByLocale.set(locale, flat)
  }
  return flat
}

export interface I18nValue {
  t: (key: string, params?: TranslateParams) => string
  locale: Accessor<ShippedLocale>
  setLocale: (next: ShippedLocale) => void
  fmtDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
  fmtNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  fmtCurrency: (value: number, currency: string) => string
}

const I18nContext = createContext<I18nValue>()

/**
 * A non-reactive English-only translator used when a component is rendered
 * outside an <I18nProvider> (notably component unit tests, which the plan
 * fixes to the default `en` locale). The real provider supplies the reactive
 * version at the app root.
 */
function createStaticEnglish(): I18nValue {
  const flat = flatFor("en")
  const t = (key: string, params?: TranslateParams): string => {
    const raw = flat[key]
    if (raw === undefined || typeof raw !== "string") {
      if (!warned.has(key)) {
        warned.add(key)
        // biome-ignore lint/suspicious/noConsole: intentional dev warn-once
        console.warn(`[i18n] missing translation key: ${key}`)
      }
      return key
    }
    return params ? resolveTemplate(raw, params) : raw
  }
  return {
    t,
    locale: () => "en",
    setLocale: () => {},
    fmtDate: (v, o) => new Intl.DateTimeFormat("en", o).format(v),
    fmtNumber: (v, o) => new Intl.NumberFormat("en", o).format(v),
    fmtCurrency: (v, c) =>
      new Intl.NumberFormat("en", { style: "currency", currency: c }).format(v),
  }
}

let staticEnglish: I18nValue | undefined

export const I18nProvider: Component<{
  initialLocale?: ShippedLocale
  children: JSX.Element
}> = (props) => {
  const [state, setState] = createStore<{ locale: ShippedLocale }>({
    locale: props.initialLocale ?? "en",
  })

  const locale: Accessor<ShippedLocale> = () => state.locale
  const setLocale = (next: ShippedLocale) => setState("locale", next)

  // Startup applies the persisted language once it becomes known after the
  // session is restored (I4). MUST react ONLY to `storedLocale` — a plain
  // createEffect that also reads `state.locale` re-fires on every in-session
  // `setLocale(...)` and forcibly resets the locale back to the stored value,
  // so a user picking French would be instantly reverted to English (the
  // reactive-switch regression S-3 catches). `on(storedLocale, …)` makes the
  // dependency one-directional: stored → state, never the reverse.
  createEffect(
    on(storedLocale, (stored) => {
      if (stored && stored !== state.locale) setState("locale", stored)
    }),
  )

  createEffect(() => {
    setActiveLocale(state.locale)
    // The document says which language it is in: screen readers pick their
    // voice from it and the browser its hyphenation and translate offer. It
    // stayed "en" (index.html) under a French UI.
    if (typeof document !== "undefined") document.documentElement.lang = state.locale
  })
  // The mirrored locale belongs to this provider: once it is gone (a test that
  // rendered French), code outside the tree is back to English rather than
  // speaking the last provider's language.
  onCleanup(() => setActiveLocale("en"))

  const t = (key: string, params?: TranslateParams): string => {
    let raw = flatFor(locale())[key]
    if (raw === undefined) {
      // Per-key fallback: missing in active locale → try English.
      raw = flatFor("en")[key]
    }
    if (raw === undefined || typeof raw !== "string") {
      if (!warned.has(key)) {
        warned.add(key)
        // biome-ignore lint/suspicious/noConsole: intentional dev warn-once
        console.warn(`[i18n] missing translation key: ${key}`)
      }
      return key
    }
    if (params) return resolveTemplate(raw, params)
    return raw
  }

  const fmtDate = (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale(), options).format(value)

  const fmtNumber = (value: number, options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale(), options).format(value)

  const fmtCurrency = (value: number, currency: string) =>
    new Intl.NumberFormat(locale(), { style: "currency", currency }).format(value)

  const api: I18nValue = { t, locale, setLocale, fmtDate, fmtNumber, fmtCurrency }

  return <I18nContext.Provider value={api}>{props.children}</I18nContext.Provider>
}

/** Translator signature for helpers that run outside a component. */
export type Translate = (key: string, params?: TranslateParams) => string

/**
 * The English translator, for a plain helper called without one (its
 * callers inside the app pass the reactive `i18n.t`; its unit tests and any
 * non-UI caller get the same English copy the catalog holds).
 */
export const englishT: Translate = (key, params) => {
  if (!staticEnglish) staticEnglish = createStaticEnglish()
  return staticEnglish.t(key, params)
}

/** Whether the English catalog holds `key` (no missing-key warning). */
export function catalogHasKey(key: string): boolean {
  return typeof flatFor("en")[key] === "string"
}

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

/**
 * Product copy that was SEEDED into data in English (a default role's
 * description, a first-party app's description): shown from the catalog in the
 * reader's language while the stored text is still the seeded one (compared on
 * letters and digits, so the catalog's punctuation may differ), and as written
 * once someone changed it. An English reader always gets the stored text.
 */
export function seededCopy(
  stored: string | null | undefined,
  key: string,
  t: Translate = tNow,
): string {
  if (!stored) return ""
  if (activeLocale() === "en" || !catalogHasKey(key)) return stored
  return fold(englishT(key)) === fold(stored) ? t(key) : stored
}

/**
 * A translator in the ACTIVE locale for code outside the component tree
 * (toasts raised by a plain helper, store messages, host services). It reads
 * the provider's mirrored locale, so it follows a language switch; with no
 * provider mounted it is English, exactly like `englishT`.
 */
export const tNow: Translate = (key, params) => translatorFor(activeLocale())(key, params)

/**
 * A translator pinned to one locale, whatever the UI is set to (a helper that
 * must speak a given reader's language, and tests asserting the French copy).
 * A key the locale lacks falls back to English, like the provider's `t`.
 */
export function translatorFor(locale: ShippedLocale): Translate {
  return (key, params) => {
    if (locale === "en") return englishT(key, params)
    const raw = flatFor(locale)[key]
    if (typeof raw !== "string") return englishT(key, params)
    return params ? resolveTemplate(raw, params) : raw
  }
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (ctx) return ctx
  // No provider in tree (e.g. component unit tests) → static English.
  if (!staticEnglish) staticEnglish = createStaticEnglish()
  return staticEnglish
}
