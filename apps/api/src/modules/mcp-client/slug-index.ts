// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-memory `<orgId>:<slug>` → `connectionId` map.
//
// Owned by the kernel module; the only writers are:
//   - `ToolProjector.registerTools` (sets on every successful project)
//   - `ToolProjector.retireSlug` (deletes when the slug is retired)
//   - `initMcpClient` boot hydration (sets every persisted connection)
//   - `retireMcpConnection` (deletes when the connection is removed, on every node)
//
// Read by the health-gate in `buildToolSet` to map a registry key
// (`mcp:<slug>:<tool>`) back to the connectionId so it can look up health +
// disabled state.

const map = new Map<string, string>()

function key(orgId: string, slug: string): string {
  return `${orgId}:${slug}`
}

export const slugIndex = {
  set(orgId: string, slug: string, connectionId: string): void {
    map.set(key(orgId, slug), connectionId)
  },
  get(orgId: string, slug: string): string | undefined {
    return map.get(key(orgId, slug))
  },
  delete(orgId: string, slug: string): void {
    map.delete(key(orgId, slug))
  },
  clear(): void {
    map.clear()
  },
  /** Iteration helper for test introspection + boot wiring. */
  entries(): IterableIterator<[string, string]> {
    return map.entries()
  },
  size(): number {
    return map.size
  },
}
