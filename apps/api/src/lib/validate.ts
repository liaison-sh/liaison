// SPDX-License-Identifier: FSL-1.1-ALv2
import { zValidator as _zValidator } from "@hono/zod-validator"
import type { ValidationTargets } from "hono"
import type { ZodSchema } from "zod"

/**
 * Wrapped zValidator that formats validation errors to match the standard
 * response envelope: { error: { message, code } }. Prevents raw Zod error
 * objects from reaching clients (M-9).
 */
export function zValidator<Target extends keyof ValidationTargets, T extends ZodSchema>(
  target: Target,
  schema: T,
) {
  return _zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")
      return c.json({ error: { message, code: "VALIDATION_ERROR" } }, 400)
    }
  })
}
