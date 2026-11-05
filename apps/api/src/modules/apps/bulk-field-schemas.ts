// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The slice of a manifest's tool schemas the bulk form needs, and nothing else.
 *
 * The web bulk toolbar picks each shared field's widget from the underlying
 * tool's param schema (a <select> for an enum such as a ticket's closedReason).
 * The manifests endpoint never shipped tool schemas, so every field fell back to
 * a free-text input. This projects, per bulk underlying tool, only the shared
 * fields' `type`/`enum` and their editable-field `label`/`widget`, so the web
 * gets the widget hints without the rest of the tool catalog.
 */

export interface BulkToolSchema {
  params: { properties: Record<string, { type?: string; enum?: string[] }> }
  editableFields: Array<{ field: string; label?: string; widget?: string }>
}

interface ToolLike {
  params?: { properties?: Record<string, { type?: unknown; enum?: unknown }> }
  editableFields?: Array<{ field?: string; label?: string; widget?: string }>
}

export function projectBulkToolSchemas(
  bulk: Record<string, { underlyingTool?: string; sharedFields?: string[] }> | undefined,
  tools: Record<string, ToolLike> | undefined,
): Record<string, BulkToolSchema> | undefined {
  if (!bulk || !tools) return undefined
  const out: Record<string, BulkToolSchema> = {}
  for (const decl of Object.values(bulk)) {
    const toolName = decl.underlyingTool
    if (!toolName) continue
    const tool = tools[toolName]
    if (!tool) continue
    const entry = out[toolName] ?? { params: { properties: {} }, editableFields: [] }
    for (const field of decl.sharedFields ?? []) {
      const p = tool.params?.properties?.[field]
      if (p) {
        const spec: { type?: string; enum?: string[] } = {}
        if (typeof p.type === "string") spec.type = p.type
        if (Array.isArray(p.enum)) spec.enum = p.enum.map(String)
        entry.params.properties[field] = spec
      }
      const ed = tool.editableFields?.find((e) => e.field === field)
      if (ed && !entry.editableFields.some((e) => e.field === field)) {
        entry.editableFields.push({
          field,
          ...(ed.label ? { label: ed.label } : {}),
          ...(ed.widget ? { widget: ed.widget } : {}),
        })
      }
    }
    out[toolName] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}
