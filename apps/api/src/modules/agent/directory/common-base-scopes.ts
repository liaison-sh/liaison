// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Constants only, no imports: tooling reads this without a database or the
// apps/api env schema.

/**
 * The common base every non personal agent's ceiling carries: each role
 * agent on top of its own scopes (roster.md "Common base"), and the org's
 * `@base` system agent as its whole ceiling. It is code, not roster data: it
 * is what the kernel's own agent surface needs, whatever the org.
 *
 * Two entries are NOT in roster.md's prose and are here because the code says
 * they are the base:
 *  - `kernel:threads:read` gates `tool_search` (kernel-tools.ts). Every app
 *    tool is DEFERRED for an agent audience (tool-bridge.ts `isDeferredTool`),
 *    so without it a role agent's catalog holds no app tool AT ALL, and
 *    `threads_list/read/search`, `list_locked_capabilities` and
 *    `request_scope` are gone with it (T26 F2).
 *  - `kernel:threads:write` gates `agents_ask` / `agents_invite`: the
 *    coordination surface (A29/A30) is uncallable without it.
 * And one is the memory epic's (T26 F4): every memory tool and `notify_user`
 * declare `kernel:agent:memory`, so a role agent without it accumulates
 * nothing across turns, which spec-memory.md's per-agent tree assumes it does.
 *
 * None of these is an admin scope: `assertNoAdminScopesInRoleCeiling` still
 * passes on every composed ceiling, and the ceiling remains a CAP, intersected
 * with the room floor and with the acting human's own grants on every turn.
 */
export const COMMON_AGENT_BASE_SCOPES: readonly string[] = [
  "kernel:skills:read",
  "kernel:skills:write",
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:agent:memory",
  "kernel:contacts:read",
  "kernel:files:read",
  "kernel:files:analyze",
  "knowledge:documents:read",
  "knowledge:documents:create",
  "projects:projects:read",
  "projects:tasks:read",
  "projects:tasks:write",
]
