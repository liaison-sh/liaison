// SPDX-License-Identifier: FSL-1.1-ALv2
import { hasScope } from "~/modules/permissions/permissions"

/**
 * The single place that decides a tool's declared scope set. Every
 * fail-closed scope check reads a tool's scopes through this function, so a
 * tool resolves the same way everywhere.
 */

export interface ScopeDeclaringToolDef {
  requiredScopes?: readonly string[]
}

/**
 * Returns the tool's deduplicated `requiredScopes`, or `[]` when it declares
 * none. An empty result means the tool declares no required scopes.
 */
export function resolveRequiredScopes(toolDef: ScopeDeclaringToolDef): string[] {
  const { requiredScopes } = toolDef
  return Array.isArray(requiredScopes) ? [...new Set(requiredScopes)] : []
}

/** True when the tool declares no required scopes (the fail-closed trigger). */
export const TOOL_DECLARES_NO_SCOPES = (toolDef: ScopeDeclaringToolDef): boolean =>
  resolveRequiredScopes(toolDef).length === 0

export interface ToolScopeCheck {
  /** The tool's resolved scopes; empty when it declares none. */
  required: string[]
  /** The resolved scopes the actor does not hold. */
  missing: string[]
  /** True only when `required` is non-empty and `missing` is empty. */
  authorized: boolean
}

/**
 * The one authorization rule for a tool, shared by the catalog, the deferred
 * and locked listings and the invoke path: a tool is authorized only when it
 * declares at least one scope and the actor holds every one of them
 * (wildcard-aware). A tool that declares none is refused to everyone.
 */
export function checkToolScopes(
  toolDef: ScopeDeclaringToolDef,
  actorScopes: string[],
): ToolScopeCheck {
  const required = resolveRequiredScopes(toolDef)
  const missing = required.filter((s) => !hasScope(s, actorScopes))
  return { required, missing, authorized: required.length > 0 && missing.length === 0 }
}
