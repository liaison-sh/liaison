// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The adapter format as JSON Schema (draft 2020-12), for editors and external
 * tooling. Structural rules only: the cross-field rules (placeholders, roles,
 * tokenUrl host, read methods) live in `validateAdapter`, which stays the
 * authority.
 */
import { z } from "zod"
import { AdapterSchema } from "./schema"

export function toJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AdapterSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  })
  return {
    ...schema,
    title: "Liaison API connector adapter",
  }
}
