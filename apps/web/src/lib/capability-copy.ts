// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The web's half of capability DISPLAY: it holds the three things only the
 * client knows (the manifest display names this instance loaded, the org's
 * role names, and the translator) and hands them to the pure formatters in
 * `@liaison/shared`.
 *
 * NO SURFACE PRINTS A SCOPE. Skills, routines, the agent Overview chips and
 * the capability editor all route their labels through here, so there is one
 * answer to "what does this grant read as" instead of four.
 *
 * EVERY WORD IS TRANSLATED. The app names and the nouns a derived phrase uses
 * are `kernel.capabilities.*` catalog entries, so a French reader gets
 * "Espace de travail : lire les agents" rather than an English phrase with a
 * French verb in it. Only a manifest's OWN `displayName` stays as the app
 * ships it: it is the app's name, not our copy. The key sets come from the
 * English dictionary so a missing entry is a silent fallback rather than a
 * console warning per render.
 */
import {
  type CapabilityChip,
  type CapabilityVocabulary,
  capabilityCategoryChip,
  englishDictionaries,
  scopeDisplayLabel,
  WILDCARD_CAPABILITY_CATEGORY,
} from "@liaison/shared"
import { createSignal } from "solid-js"
import { currentLocale } from "~/modules/i18n/i18n-context"

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

const [appDisplayNames, setAppDisplayNames] = createSignal<Record<string, string>>({})

export { appDisplayNames }

/** Record one manifest app's own display name (bootstrap, as apps register). */
export function registerAppDisplayName(name: string, displayName?: string | null): void {
  if (!name || typeof displayName !== "string" || displayName.trim() === "") return
  setAppDisplayNames((prev) =>
    prev[name] === displayName ? prev : { ...prev, [name]: displayName },
  )
}

function catalogKeys(section: "apps" | "resources"): string[] {
  const kernel = englishDictionaries().kernel as Record<string, any>
  const node = kernel?.capabilities?.[section]
  return node && typeof node === "object" ? Object.keys(node) : []
}

const APP_KEYS = catalogKeys("apps")

/** The scope actions the catalog has a verb for (`kernel.capabilities.action<Word>`). */
const ACTION_WORDS = [
  "read",
  "list",
  "write",
  "create",
  "delete",
  "admin",
  "approve",
  "export",
  "analyze",
  "close",
  "reply",
  "update",
  "manage",
  "archive",
  "upload",
  "download",
  "share",
  "run",
  "delegate",
  "spawn",
]

/** Scopes whose description the catalog carries, in every locale. */
const DESCRIBED_SCOPES = new Set(
  (() => {
    const node = (englishDictionaries().kernel as Record<string, any>)?.capabilities
      ?.scopeDescriptions
    return node && typeof node === "object" ? Object.keys(node) : []
  })(),
)
const RESOURCE_KEYS = catalogKeys("resources")

/** The app names this reader sees: the catalog, then the manifests on top. */
function appNames(t: Translate): Record<string, string> {
  const out: Record<string, string> = {}
  for (const slug of APP_KEYS) out[slug] = t(`kernel.capabilities.apps.${slug}`)
  return { ...out, ...appDisplayNames() }
}

/** The translated words a derived capability phrase may use. */
export function capabilityVocabulary(t: Translate): CapabilityVocabulary {
  const resources: Record<string, string> = {}
  for (const word of RESOURCE_KEYS) resources[word] = t(`kernel.capabilities.resources.${word}`)
  return {
    fullAccess: t("kernel.capabilities.fullAccess"),
    separator: t("kernel.capabilities.separator"),
    actions: Object.fromEntries(
      ACTION_WORDS.map((word) => [
        word,
        t(`kernel.capabilities.action${word.charAt(0).toUpperCase()}${word.slice(1)}`),
      ]),
    ),
    resources,
  }
}

/**
 * `<App name>: <what it lets you do>` for one scope string.
 *
 * The server's descriptions are English ("Read contacts", "Decide (approve,
 * edit, or deny) calendar approvals raised by its gated tools"), and a French
 * reader got "Espace de travail : Read contacts". An English reader keeps the
 * server's description. Any other reader gets the catalog's description of
 * the scope, the catalog's sentence for an app's approver scope, or else the
 * phrase derived from the scope's own words, which is all catalog vocabulary.
 */
export function scopeLabel(scope: string, t: Translate, description?: string): string {
  if (scope === "*") return t("kernel.capabilities.everything")
  let described: string | undefined = description
  if (currentLocale() !== "en") {
    described = DESCRIBED_SCOPES.has(scope)
      ? t(`kernel.capabilities.scopeDescriptions.${scope}`)
      : /^[^:]+:approve$/.test(scope)
        ? t("kernel.capabilities.decideAppApprovals")
        : undefined
  }
  return scopeDisplayLabel(scope, {
    description: described,
    appNames: appNames(t),
    vocabulary: capabilityVocabulary(t),
  })
}

/** The one hover phrase that carries a permission identifier, everywhere. */
export function scopeIdTitle(scope: string, t: Translate): string {
  return t("kernel.capabilities.scopeIdTitle", { scope })
}

/** The app, role or neutral label behind one capability category chip. */
export function categoryChip(
  category: string,
  t: Translate,
  roleNames: string[] = [],
): CapabilityChip {
  // "everything this workspace allows" is a phrase the shared package keeps in
  // English for its own callers; a reader gets it in their language.
  if (category === WILDCARD_CAPABILITY_CATEGORY || category === "*") {
    return { label: t("kernel.capabilities.everything") }
  }
  return capabilityCategoryChip(category, {
    appNames: appNames(t),
    roleNames,
    unknownLabel: t("kernel.capabilities.roleUnknown"),
  })
}
