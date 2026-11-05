// SPDX-License-Identifier: FSL-1.1-ALv2
/** Adapter documents arrive as JSON or YAML text (YAML is a JSON superset). */
import { parse as parseYaml } from "yaml"
import {
  MAX_ADAPTER_BYTES,
  type ValidateOptions,
  type ValidateResult,
  validateAdapter,
} from "./schema"

export function parseAdapterText(text: string, opts: ValidateOptions = {}): ValidateResult {
  if (new TextEncoder().encode(text).byteLength > MAX_ADAPTER_BYTES) {
    return {
      ok: false,
      issues: [{ path: "", message: `adapter document exceeds ${MAX_ADAPTER_BYTES} bytes` }],
    }
  }
  let doc: unknown
  try {
    // No custom tags, unique keys, and a small alias budget against expansion bombs.
    doc = parseYaml(text, { maxAliasCount: 50, uniqueKeys: true, customTags: [], merge: false })
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "unparseable document"
    return { ok: false, issues: [{ path: "", message: `not valid JSON or YAML: ${message}` }] }
  }
  return validateAdapter(doc, opts)
}
