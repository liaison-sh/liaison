// SPDX-License-Identifier: FSL-1.1-ALv2
import { appsLogger as log } from "~/lib/logger"

interface AppDependencyInput {
  name: string
  dependencies?: {
    required?: string[]
    optional?: string[]
  }
}

interface ResolveResult {
  success: boolean
  order?: string[]
  error?: string
  rejectedApps?: string[]
  warnings: string[]
}

/** BFS reachability check: can we reach `target` from `source` using the current adjacency graph? */
function wouldCreateCycle(
  adjacency: Record<string, string[]>,
  source: string,
  target: string,
): boolean {
  const visited = new Set<string>()
  const queue = [source]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === target) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of adjacency[current] ?? []) {
      queue.push(next)
    }
  }
  return false
}

export function resolveAppOrder(apps: AppDependencyInput[]): ResolveResult {
  const appNames = new Set(apps.map((a) => a.name))
  const builtInDependencies = new Set(["kernel"])
  const rejectedApps: string[] = []
  const warnings: string[] = []

  // Check for missing required dependencies
  for (const app of apps) {
    for (const dep of app.dependencies?.required ?? []) {
      if (dep === app.name) {
        return {
          success: false,
          error: `Self-dependency: ${app.name} depends on itself`,
          rejectedApps: [app.name],
          warnings,
        }
      }
      if (!appNames.has(dep) && !builtInDependencies.has(dep)) {
        rejectedApps.push(app.name)
        log.error({ app: app.name, missing: dep }, "Missing required dependency")
      }
    }
    for (const dep of app.dependencies?.optional ?? []) {
      if (!appNames.has(dep)) {
        warnings.push(`${app.name}: optional dependency "${dep}" not found`)
        log.info({ app: app.name, missing: dep }, "Optional dependency not found")
      }
    }
  }

  if (rejectedApps.length > 0) {
    return {
      success: false,
      error: `Missing required dependencies for: ${rejectedApps.join(", ")}`,
      rejectedApps,
      warnings,
    }
  }

  // Topological sort (Kahn's algorithm)
  const inDegree: Record<string, number> = {}
  const adjacency: Record<string, string[]> = {}

  for (const app of apps) {
    inDegree[app.name] = 0
    adjacency[app.name] = []
  }

  for (const app of apps) {
    for (const dep of app.dependencies?.required ?? []) {
      if (appNames.has(dep)) {
        adjacency[dep].push(app.name)
        inDegree[app.name]++
      }
    }
    // Optional dependencies are handled after required edges to detect cycles
  }

  // Add optional dependencies (skip if they'd create a cycle)
  for (const app of apps) {
    for (const dep of app.dependencies?.optional ?? []) {
      if (!appNames.has(dep)) continue // already warned above
      if (wouldCreateCycle(adjacency, app.name, dep)) {
        warnings.push(`Optional dependency ${app.name} → ${dep} skipped (would create cycle)`)
        // Expected, not a fault: two apps may name each other as optional
        // (mail and tickets). The result's warnings carry it; a warn log
        // printed it before every CLI command's own output.
        log.debug({ app: app.name, dep }, "Optional dependency skipped — would create cycle")
        continue
      }
      adjacency[dep].push(app.name)
      inDegree[app.name]++
    }
  }

  const queue: string[] = []
  for (const [name, degree] of Object.entries(inDegree)) {
    if (degree === 0) queue.push(name)
  }

  const order: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    order.push(current)
    for (const dependent of adjacency[current]) {
      inDegree[dependent]--
      if (inDegree[dependent] === 0) queue.push(dependent)
    }
  }

  if (order.length !== apps.length) {
    const remaining = apps.filter((a) => !order.includes(a.name)).map((a) => a.name)
    return {
      success: false,
      error: `Circular dependency detected involving: ${remaining.join(", ")}`,
      rejectedApps: remaining,
      warnings,
    }
  }

  return { success: true, order, warnings }
}
