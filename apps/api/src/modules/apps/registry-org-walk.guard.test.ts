// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A per-org read of an app registry walks that org's bucket (`entriesOf`),
// never every org's entries (`entries()`) filtered back down to one.
//
// The bug class. A process holds the registrations of every org it has served
// (hundreds of visitor workspaces on a busy demo, each with a few hundred
// tools). `entries()` yields every one of them and splits each key, so a walk
// filtered to one org costs O(all orgs a process holds), and every agent turn
// made several: building the tool set, the deferred catalog, the canonical
// name map. Under a launch's signup burst the api spent a seventh of its CPU
// in `entries()`, and the cost per turn grew with every new workspace.
//
// The ratchet below lists the only reviewed full walks; a new one fails here.

import { describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { canonicalToolNamesBySdkName, listGatewayTools } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"

const SRC = resolve(import.meta.dir, "../..")

/** Full walks that are correct: every org's entries, or an org's plus the wildcard's in registry order. */
const ALLOWED: Array<{ file: string; registry: string; why: string }> = [
  {
    file: "modules/permissions/roles.ts",
    registry: "dimensionDefRegistry",
    why: "the org's or the wildcard's definition, first match in registration order wins",
  },
  {
    file: "modules/permissions/dimension-catalog.ts",
    registry: "dimensionDefRegistry",
    why: "the org's and the wildcard's definitions, deduplicated in registration order",
  },
  {
    file: "modules/apps/routes.ts",
    registry: "dimensionDefRegistry",
    why: "the org's and the wildcard's definitions, in registration order",
  },
  {
    file: "modules/apps/catalog-derivations.ts",
    registry: "manifestFileParentRegistry",
    why: "every org's file parents: the policy is built across orgs",
  },
  {
    file: "modules/apps/org-runtime-release.ts",
    registry: "eventSubscriptionDisposers",
    why: "a release batch of several orgs at once",
  },
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "tests") sourceFiles(path, out)
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(path)
  }
  return out
}

describe("app registries: per-org reads walk one org", () => {
  it("no source walks a whole typed registry outside the reviewed list", () => {
    const files = sourceFiles(SRC)
    const registries = new Set<string>()
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/const (\w+) = createTypedRegistry\b/g)) {
        if (m[1]) registries.add(m[1])
      }
    }
    expect(registries.has("toolRegistry")).toBe(true)
    const found: string[] = []
    for (const file of files) {
      // Code lines only: a comment may name a walk.
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n")
      for (const name of registries) {
        if (!text.includes(`${name}.entries()`)) continue
        const rel = relative(SRC, file)
        if (!ALLOWED.some((a) => a.file === rel && a.registry === name))
          found.push(`${rel}: ${name}.entries()`)
      }
    }
    expect(found).toEqual([])
  })

  it("the tool catalog reads of one org never walk the other orgs' tools", () => {
    const org = randomUUID()
    const others = Array.from({ length: 50 }, () => randomUUID())
    const def = (app: string, name: string) =>
      ({
        appName: app,
        name,
        description: name,
        requiredScopes: [`${app}:${name}:read`],
      }) as unknown as Parameters<typeof toolRegistry.set>[1]
    toolRegistry.set([org, "walktest", "mine"], def("walktest", "mine"))
    for (const o of others) toolRegistry.set([o, "walktest", "theirs"], def("walktest", "theirs"))
    const walk = spyOn(toolRegistry, "entries")
    try {
      const names = canonicalToolNamesBySdkName(org)
      expect([...names.values()].some((n) => n.includes("mine"))).toBe(true)
      expect([...names.values()].some((n) => n.includes("theirs"))).toBe(false)
      listGatewayTools(org)
      expect(walk).toHaveBeenCalledTimes(0)
    } finally {
      walk.mockRestore()
      toolRegistry.delete([org, "walktest", "mine"])
      for (const o of others) toolRegistry.delete([o, "walktest", "theirs"])
    }
  })
})
