// SPDX-License-Identifier: FSL-1.1-ALv2
import type Ajv from "ajv"

// The string formats app manifests and import kinds may declare. Ajv knows none
// by default: in strict mode it refuses to compile a schema naming an unknown
// one, and with `strict: false` it prints `unknown format "uuid" ignored in
// schema` on every compile (every CLI command's stdout showed it). Registered by
// hand (same pattern as ajv-formats' "uuid") because ajv-formats is not a
// dependency of this workspace and uuid is the only format any bundled manifest
// uses.
export const UUID_FORMAT = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

/** Register the formats Liaison schemas use on an Ajv instance; returns it. */
export function withFormats<T extends Ajv>(ajv: T): T {
  ajv.addFormat("uuid", UUID_FORMAT)
  return ajv
}
