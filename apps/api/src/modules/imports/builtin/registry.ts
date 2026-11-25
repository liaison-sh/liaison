// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Built-in transforms: importers the product ships and runs for a person (an
 * export of another tool's pages, uploaded as a zip), unlike the reference
 * transforms (`reference/references.ts`), which are examples an agent reads.
 *
 * A built-in runs on the same runner, sandbox and scopes as a saved transform
 * (`kernel:imports:run`, the kinds' write scopes, as the person), with three
 * differences the server decides and a client never sends:
 *   - its code is the file shipped here, its settings set the one
 *     `const PARAMS = ...` line, and a run pins the resulting code's sha256
 *     (changed since the preview: refused);
 *   - its file rules and limits come from this registry, never from a row;
 *   - its source label is the server's: `builtin:<label>` for an import
 *     everyone sees, `builtin:<label>:u:<userId>` for one only its person
 *     sees, so a private import dedups per person and a shared one per org.
 *     A client label cannot hold a `:` (routes.ts), so it can name neither.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { FileRule } from "~/modules/imports/transform-run"
import { ImportError } from "~/modules/imports/types"

export interface BuiltinLimits {
  /** Read zips found inside the upload (one level), as one namespace. */
  nestedZips: boolean
  /** The upload's files together, at most this. */
  maxUploadBytes: number
  /** Everything the archives declare, decompressed, at most this. */
  maxDecompressedBytes: number
  /** A preview reads everything, for at most this long. */
  previewTimeMs: number
}

export interface BuiltinTransform {
  /** The script, relative to this folder. */
  file: string
  /** The source label's middle part: `builtin:<label>`. */
  label: string
  /** One line: what it reads and writes. */
  about: string
  /** The kinds it emits, in the order they are written. */
  kinds: string[]
  files: FileRule[]
  /** The settings a person chooses; their parsed value is the script's PARAMS. */
  params: z.ZodType<Record<string, unknown>>
  /** Only its person sees what the import makes: its label is per person. */
  isPrivate(params: Record<string, unknown>): boolean
  limits: BuiltinLimits
}

const GB = 1024 * 1024 * 1024

/** Every built-in transform, by key. Tests may add one; a row names only a key. */
export const BUILTIN_TRANSFORMS: Record<string, BuiltinTransform> = {
  "notion-export": {
    file: "notion-export.js",
    label: "notion",
    about:
      "A Notion workspace export (Markdown & CSV, one zip or a zip of zips) into knowledge folders, pages, tables and files.",
    kinds: ["knowledge.collection", "knowledge.document"],
    files: [
      { match: "**", as: "listing" },
      { match: "**/*_all.csv", as: "csv" },
      { match: "**/*.csv", as: "csv" },
      { match: "**/*.md", as: "text", oversize: "skip" },
    ],
    params: z
      .object({
        /** Who sees the pages: only the person, everyone (read), everyone (edit). */
        access: z.enum(["private", "view", "edit"]).default("private"),
      })
      .strict(),
    isPrivate: (params) => params.access === "private",
    limits: {
      nestedZips: true,
      maxUploadBytes: GB,
      maxDecompressedBytes: 4 * GB,
      previewTimeMs: 10 * 60_000,
    },
  },
}

/** The registry entry of a key, or a refusal naming the ones that exist. */
export function builtinTransform(key: string): BuiltinTransform {
  const def = Object.hasOwn(BUILTIN_TRANSFORMS, key) ? BUILTIN_TRANSFORMS[key] : undefined
  if (!def) {
    throw new ImportError(
      "invalid_source",
      `There is no built-in import ${JSON.stringify(key.slice(0, 64))}; there are ${Object.keys(BUILTIN_TRANSFORMS).join(", ")}.`,
    )
  }
  return def
}

export function isBuiltinKey(key: string): boolean {
  return Object.hasOwn(BUILTIN_TRANSFORMS, key)
}

/** The settings, parsed (defaults filled), or a refusal in words. */
export function builtinParams(key: string, params: unknown): Record<string, unknown> {
  const def = builtinTransform(key)
  const parsed = def.params.safeParse(params ?? {})
  if (!parsed.success) {
    throw new ImportError(
      "invalid_request",
      `The settings of the built-in import ${key} are not valid: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
        .join("; ")}.`,
    )
  }
  return parsed.data
}

/** The shipped code with its settings on the `const PARAMS = ...` line. */
export function builtinCode(key: string, params: unknown): string {
  const def = builtinTransform(key)
  const parsed = builtinParams(key, params)
  const code = readFileSync(join(import.meta.dir, def.file), "utf8")
  const line = /^const PARAMS = .*$/m
  if (!line.test(code)) throw new Error(`built-in import ${key} has no const PARAMS line`)
  // A replacer function: a `$` in a value is inserted as is, never a pattern.
  return code.replace(line, () => `const PARAMS = ${JSON.stringify(parsed)}`)
}

/** The source label the server gives a built-in run of this person. */
export function builtinSourceLabel(key: string, params: unknown, userId: string): string {
  const def = builtinTransform(key)
  const shared = `builtin:${def.label}`
  return def.isPrivate(builtinParams(key, params)) ? `${shared}:u:${userId}` : shared
}
