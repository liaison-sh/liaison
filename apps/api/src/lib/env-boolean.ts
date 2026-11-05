// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Strict boolean parsing for environment variables. `z.coerce.boolean()` is
// JavaScript truthiness, so the string "false" (and "0", "no", "off") parses as
// true: a deployment that writes SMTP_SECURE=false gets TLS anyway. Every
// boolean env key goes through this one parser instead. Side-effect free, so
// modules that read process.env directly can share it without loading env.ts.
import { z } from "zod"

const TRUE_VALUES = new Set(["true", "1", "yes"])
const FALSE_VALUES = new Set(["false", "0", "no", ""])

/** Parse a raw env value. `undefined` for unset or unrecognized input. */
export function parseEnvBoolean(raw: string | undefined | null): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  const v = raw.trim().toLowerCase()
  if (TRUE_VALUES.has(v)) return true
  if (FALSE_VALUES.has(v)) return false
  return undefined
}

/** Read a boolean flag straight from process.env; unset or unrecognized is `fallback`. */
export function envFlag(name: string, fallback = false): boolean {
  return parseEnvBoolean(process.env[name]) ?? fallback
}

/**
 * Zod schema for a boolean env key: "true"/"1"/"yes" are true, "false"/"0"/"no"
 * and the empty string are false (case-insensitive), unset takes `defaultValue`,
 * anything else fails validation naming the accepted values.
 */
export function envBoolean(defaultValue: boolean) {
  return z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue
      if (typeof value === "boolean") return value
      const parsed = parseEnvBoolean(value)
      if (parsed === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `expected a boolean (true/false, 1/0, yes/no), got "${value}"`,
        })
        return z.NEVER
      }
      return parsed
    })
}
