// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every variable the self-host docs tell an operator to set in deploy/.env must
// reach the app container. Compose only hands the app the variables its
// `environment:` block names (`NAME: ${NAME:-…}`), so a variable that is
// documented but not passed through is silently ignored: the operator sets it,
// the server never sees it (the Google Picker keys and EXA_API_KEY were).
//
// The documented set: every `NAME=` line of deploy/.env.example (commented ones
// too), and every server variable (a key of the api env schema) that the setup
// skill, the production runbook or the push page names.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ENV_KEY_MAP } from "../apps/api/src/modules/agent/credits/platform-key-env"

const ROOT = path.resolve(import.meta.dir, "..")
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

/** Docs that tell an operator which variables to set in deploy/.env. */
const OPERATOR_DOCS = [
  ".claude/skills/setup-liaison/SKILL.md",
  "docs/runbooks/production-bootstrap.md",
  "docs/notifications.md",
  // Legal archive on org delete (LEGAL_ARCHIVE_*): documented here only, and
  // once silently not passed through.
  "docs/admin/backups.md",
]

/** Named in the docs but composed by compose itself from other variables. */
const COMPOSED: Record<string, string> = {
  DATABASE_URL: "built from POSTGRES_PASSWORD / LIAISON_APP_PASSWORD",
  DATABASE_REQUEST_PASSWORD: "built from LIAISON_REQUEST_PASSWORD",
  MIGRATION_DATABASE_URL: "built from POSTGRES_PASSWORD",
}

function serverEnvNames(): Set<string> {
  const src = read("apps/api/src/lib/env.ts")
  const names = new Set([...src.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string))
  for (const name of Object.values(ENV_KEY_MAP)) names.add(name)
  return names
}

function documentedNames(): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of read("deploy/.env.example").matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)) {
    out.set(m[1] as string, "deploy/.env.example")
  }
  const server = serverEnvNames()
  for (const doc of OPERATOR_DOCS) {
    for (const m of read(doc).matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g)) {
      const name = m[1] as string
      if (server.has(name) && !out.has(name)) out.set(name, doc)
    }
  }
  return out
}

describe("compose passes every documented variable to the app", () => {
  const compose = read("deploy/docker-compose.yml")
  const passed = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))

  it("each documented deploy/.env variable appears as ${NAME} in deploy/docker-compose.yml", () => {
    const missing = [...documentedNames()]
      .filter(([name]) => !passed.has(name) && !(name in COMPOSED))
      .map(([name, doc]) => `${name} (named in ${doc})`)
    expect(missing).toEqual([])
  })

  it("the guard reads real files (the documented set is not empty)", () => {
    const names = documentedNames()
    expect(names.has("EMAIL_FROM")).toBe(true)
    expect(names.has("GOOGLE_PICKER_API_KEY")).toBe(true)
    expect(names.has("EXA_API_KEY")).toBe(true)
  })

  it("compose's unset default for LIAISON_TEAM_ENDPOINT is the app's default endpoint", () => {
    // `${NAME-default}` (no colon): unset gives the default, set-but-empty disables sharing.
    // Read from the source: importing env.ts would parse the process environment.
    const m = read("apps/api/src/lib/env.ts").match(/DEFAULT_LIAISON_TEAM_ENDPOINT =\s*"([^"]+)"/)
    const DEFAULT_LIAISON_TEAM_ENDPOINT = m?.[1]
    expect(DEFAULT_LIAISON_TEAM_ENDPOINT).toMatch(/^https:\/\//)
    expect(compose).toContain(`\${LIAISON_TEAM_ENDPOINT-${DEFAULT_LIAISON_TEAM_ENDPOINT}}`)
  })
})
