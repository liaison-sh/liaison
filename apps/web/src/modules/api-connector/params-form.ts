// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An operation's params JSON Schema as a form: one field per property the
// adapter subset allows (string, number, integer, boolean, enum, array of
// scalars), and the typed params object built back from what was typed.
// Nothing is sent that the schema does not describe.
import type { OperationParams, ParamSpec } from "@liaison/api-connector-core/contract"

/** The scalar param types (an array param's items are one of these). */
export type ParamScalarType = Exclude<ParamSpec["type"], "array">

export type ParamFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "array"

export interface ParamField {
  name: string
  kind: ParamFieldKind
  required: boolean
  description?: string
  /** enum, or an array whose items are an enum: the values as the form shows them */
  options?: string[]
  /** enum only: the schema's own values, so a numeric enum is sent as a number */
  enumValues?: Array<string | number>
  /** array only */
  itemType?: ParamScalarType
}

/** Why a value was not accepted; the UI maps each to a message. */
export type ParamError = "required" | "number" | "integer" | "enum"

/** Raw form values: text for every input, a boolean for a checkbox. */
export type RawParams = Record<string, string | boolean | undefined>

function fieldOf(name: string, prop: ParamSpec, required: boolean): ParamField | null {
  const base = { name, required, ...(prop.description ? { description: prop.description } : {}) }
  if ("enum" in prop && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return { ...base, kind: "enum", options: prop.enum.map(String), enumValues: prop.enum }
  }
  switch (prop.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return { ...base, kind: prop.type }
    case "array": {
      const items = prop.items
      const itemType = items.type
      if (itemType !== "string" && itemType !== "number" && itemType !== "integer") return null
      return {
        ...base,
        kind: "array",
        itemType,
        ...("enum" in items && items.enum ? { options: items.enum.map(String) } : {}),
      }
    }
    default:
      return null
  }
}

export function paramFields(schema: OperationParams | undefined): ParamField[] {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const out: ParamField[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const field = fieldOf(name, prop, required.has(name))
    if (field) out.push(field)
  }
  return out
}

function scalar(
  text: string,
  type: ParamScalarType,
  options?: string[],
): { value: string | number } | { error: ParamError } {
  if (type === "number") {
    const n = Number(text)
    return Number.isFinite(n) ? { value: n } : { error: "number" }
  }
  if (type === "integer") {
    const n = Number(text)
    return Number.isInteger(n) ? { value: n } : { error: "integer" }
  }
  if (options && !options.includes(text)) return { error: "enum" }
  return { value: text }
}

export type BuiltParams =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: Record<string, ParamError> }

export function buildParams(fields: ParamField[], raw: RawParams): BuiltParams {
  const params: Record<string, unknown> = {}
  const errors: Record<string, ParamError> = {}

  for (const field of fields) {
    const input = raw[field.name]
    if (field.kind === "boolean") {
      // An unticked optional box sends nothing; a required one sends its state.
      if (input === true) params[field.name] = true
      else if (field.required) params[field.name] = false
      continue
    }
    const text = typeof input === "string" ? input.trim() : ""
    if (!text) {
      if (field.required) errors[field.name] = "required"
      continue
    }
    if (field.kind === "array") {
      const parts = text
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
      const values: Array<string | number> = []
      for (const part of parts) {
        const parsed = scalar(part, field.itemType ?? "string", field.options)
        if ("error" in parsed) {
          errors[field.name] = parsed.error
          break
        }
        values.push(parsed.value)
      }
      if (!errors[field.name]) params[field.name] = values
      continue
    }
    if (field.kind === "enum") {
      const index = (field.options ?? []).indexOf(text)
      if (index < 0) errors[field.name] = "enum"
      else params[field.name] = field.enumValues?.[index] ?? text
      continue
    }
    const parsed = scalar(text, field.kind)
    if ("error" in parsed) errors[field.name] = parsed.error
    else params[field.name] = parsed.value
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, params }
}
