// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every app event the host queues for an app is one that app declares. The event bus refuses an
// undeclared `<entity>:<action>` (event-bus.ts: "did not declare event type ... in emits"), so the
// outbox retries it and dead-letters it: a write that announces itself this way loses its event in
// production while every unit test that mocks queueAppEvent stays green. This scans the host source
// for literal `queueAppEvent("<app>", "<entity>", "<action>"` calls and checks each against the
// app's manifest `emits`.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API_SRC = path.resolve(import.meta.dir, "..", "..", "..", "..")
const REPO = path.resolve(API_SRC, "..", "..", "..")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "tests") continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

function manifestEmits(app: string): string[] | null {
  for (const dir of [path.join(API_SRC, "apps", app), path.join(REPO, "bundled-apps", app)]) {
    const file = path.join(dir, "app.manifest.json")
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { events?: { emits?: string[] } }
    return manifest.events?.emits ?? []
  }
  return null
}

const CALL = /queueAppEvent\(\s*"([a-z0-9_-]+)",\s*"([a-z0-9_]+)",\s*"([a-z0-9_]+)"/g

describe("host-queued app events", () => {
  it("are declared in the app's manifest emits", () => {
    const missing: string[] = []
    let seen = 0
    for (const file of sourceFiles(API_SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(CALL)) {
        const [, app = "", entity = "", action = ""] = m
        seen++
        const emits = manifestEmits(app)
        const type = `${entity}:${action}`
        if (emits === null)
          missing.push(`${path.relative(API_SRC, file)}: no manifest for app ${app}`)
        else if (!emits.includes(type))
          missing.push(`${path.relative(API_SRC, file)}: ${app} does not declare ${type}`)
      }
    }
    expect(seen).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })
})
