// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Which looks most like your company?" on the demo door: the entries, the
 * needs each one preselects, and the answer the signup route takes.
 *
 * NOT IN `demo/`. Every file there is hashed into the demo world fingerprint
 * (`DEMO_WORLD_INPUTS`), which retires the warm pool when it changes. The answer
 * has no effect on the seeded world, so changing it must not retire anything.
 *
 * The answer rides on the org's demo marker (`settings.demo.entry`) as a hint,
 * like the welcome popup's. The marker schema does not declare it on purpose: a
 * malformed marker reads as "not a demo", and a hint must never be able to do
 * that. Read it through `demoEntrySchema.safeParse`.
 */
import { z } from "zod"
import type { DemoNeed } from "../demo/needs"

/** In the order the door lists them. */
export const DEMO_ENTRIES = ["products", "software", "expertise", "other"] as const

export type DemoEntryId = (typeof DEMO_ENTRIES)[number]

/**
 * The needs each entry preselects, in the order their scenarios play. `other`
 * preselects nothing: the picker keeps its usual empty start. Each set is one a
 * visitor could pick by hand, and `seed-plan.test.ts` checks its tours can run.
 */
export const DEMO_ENTRY_NEEDS: Readonly<Record<DemoEntryId, readonly DemoNeed[]>> = {
  products: ["support", "commerce", "knowledge"],
  software: ["support", "dev", "knowledge"],
  expertise: ["projects", "sales", "knowledge"],
  other: [],
}

/** The longest free text an `other` answer may carry. */
export const DEMO_ENTRY_TEXT_MAX = 120

/** Control and invisible formatting characters (bidi overrides, zero-width marks). */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu

/** Untrusted text flattened to one printable line. */
function flatten(raw: string): string {
  return raw
    .replace(/[\t\r\n]/g, " ")
    .replace(UNPRINTABLE, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The visitor's answer. The text is untrusted: capped, flattened, kept for
 * `other` only, and dropped when nothing is left of it. Render it as text only.
 */
export const demoEntrySchema = z
  .object({
    id: z.enum(DEMO_ENTRIES),
    text: z.string().max(DEMO_ENTRY_TEXT_MAX).optional(),
  })
  .transform(({ id, text }) => {
    const kept = id === "other" && text ? flatten(text) : ""
    return kept ? { id, text: kept } : { id }
  })

export type DemoEntry = z.output<typeof demoEntrySchema>

export function isDemoEntryId(value: unknown): value is DemoEntryId {
  return typeof value === "string" && (DEMO_ENTRIES as readonly string[]).includes(value)
}
