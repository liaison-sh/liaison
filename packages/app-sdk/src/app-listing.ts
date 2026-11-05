// SPDX-License-Identifier: FSL-1.1-ALv2
// Store listing of an app: the metadata the App store shows for a catalog or
// registry entry. A listing reuses the manifest's top-level `license`,
// `description`, `displayName` and `author`; it adds only the fields below.
//
// Marketplace rules (owner decisions): every listed app is source-available, so a
// listing requires a public `sourceRepository` (https) and an SPDX `license` on the
// manifest; there is no pricing of any kind, so a `price`, `pricing` or `plan` key
// anywhere under `listing` is refused. Apps installed from a URL may carry no listing
// and show as "Unlisted"; catalog and registry entries must carry one.
import { z } from "zod"

/** Store categories, in the order the App store shows its filter chips. */
export const APP_LISTING_CATEGORIES = [
  "Support",
  "Communication",
  "Commerce",
  "Finance",
  "Marketing",
  "Operations",
  "Knowledge",
  "Productivity",
  "Developer",
] as const

export type AppListingCategory = (typeof APP_LISTING_CATEGORIES)[number]

/** Keys refused anywhere under `listing`: the marketplace carries no prices. */
export const FORBIDDEN_LISTING_KEYS = ["price", "pricing", "plan"] as const

const httpsUrl = (what: string) =>
  z.url({ protocol: /^https$/, error: `${what} must be an https URL` }).max(2048)

const listingFieldsSchema = z
  .object({
    /** Who publishes the app, when it differs from the manifest `author`. */
    publisher: z.string().min(1).max(80).optional(),
    category: z.enum(APP_LISTING_CATEGORIES),
    /** A lucide icon name in kebab-case (e.g. `ticket`, `book-open`). */
    icon: z
      .string()
      .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "icon must be a kebab-case lucide icon name"),
    /** One line for the store row. */
    summary: z.string().min(1).max(160),
    /** Screenshot image URLs, shown as plain images. */
    screenshots: z.array(httpsUrl("screenshots[]")).max(8).optional(),
    /** Public repository holding the app's source (required: listed apps are source-available). */
    sourceRepository: httpsUrl("sourceRepository"),
  })
  .strict()

/** Every path under `value` whose key is a forbidden pricing key. */
function forbiddenKeyPaths(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => forbiddenKeyPaths(item, [...path, String(i)]))
  }
  if (value === null || typeof value !== "object") return []
  const out: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const at = [...path, key]
    if ((FORBIDDEN_LISTING_KEYS as readonly string[]).includes(key.toLowerCase())) {
      out.push(at.join("."))
    }
    out.push(...forbiddenKeyPaths(child, at))
  }
  return out
}

/**
 * The `listing` schema. The pricing denial runs on the raw input first so its message
 * names the rule, instead of a generic "unrecognized key".
 */
export const appListingSchema = z.preprocess((raw, ctx) => {
  for (const at of forbiddenKeyPaths(raw)) {
    ctx.issues.push({
      code: "custom",
      input: raw,
      path: at.split("."),
      message: `"${at}" is not allowed: listings carry no price, pricing or plan (every listed app is source-available)`,
    })
  }
  return raw
}, listingFieldsSchema)

export type AppListing = z.infer<typeof listingFieldsSchema>

// SPDX license expression: ids joined by AND / OR / WITH, optional parentheses.
const SPDX_ID = "[A-Za-z0-9][A-Za-z0-9.+-]*"
const SPDX_EXPRESSION = new RegExp(
  `^\\(?\\s*${SPDX_ID}\\s*\\)?(\\s+(AND|OR|WITH)\\s+\\(?\\s*${SPDX_ID}\\s*\\)?)*$`,
)
/** SPDX placeholders that name no licence: refused on a listed app. */
const NOT_A_LICENSE = new Set(["NONE", "NOASSERTION", "UNLICENSED", "PROPRIETARY"])

/** Whether `license` is an SPDX license expression naming an actual licence. */
export function isSpdxLicenseExpression(license: unknown): boolean {
  if (typeof license !== "string") return false
  const trimmed = license.trim()
  if (!SPDX_EXPRESSION.test(trimmed)) return false
  return !trimmed.split(/\s+|[()]/).some((part) => NOT_A_LICENSE.has(part.toUpperCase()))
}

/**
 * Cross-field rules of a manifest's `listing`: its own shape (pricing keys refused
 * anywhere under it) and, because a listed app is source-available, a top-level SPDX
 * `license`. A manifest with no listing yields no errors (an Unlisted URL install).
 * Shared by the package schema and the runtime manifest validator.
 */
export function listingDeclarationErrors(manifest: {
  listing?: unknown
  license?: unknown
}): string[] {
  if (manifest.listing === undefined) return []
  const errors: string[] = []
  const parsed = appListingSchema.safeParse(manifest.listing)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.length > 0 ? `listing.${issue.path.join(".")}` : "listing"
      errors.push(`${at}: ${issue.message}`)
    }
  }
  if (!isSpdxLicenseExpression(manifest.license)) {
    errors.push(
      "license: a listed app needs a top-level SPDX license (e.g. 'MIT', 'Apache-2.0', 'FSL-1.1-ALv2')",
    )
  }
  return errors
}
