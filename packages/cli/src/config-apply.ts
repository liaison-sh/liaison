// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison config apply <file>` over HTTPS: the part of a liaison config file a
// person may change from their own machine.
//
//  - roles, agents, apps (their config and settings): one gated tool call per
//    section (`kernel:config_<section>`, the same section runner as the
//    server's `liaison config apply`), so each section is an approval card a
//    person decides in Liaison;
//  - skills, routines: created or updated by name through their own tools (gated too);
//  - mail, email, users (seats), invoicing, tickets, knowledge, API connections,
//    model keys and every secret stay on the server: refused here, with where
//    to do it instead. Nothing is sent when anything is refused.

import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { bool, type ParsedArgs } from "./args"
import { clientFor, type Io } from "./auth"
import { CliError, type Client } from "./http"

const SECTION_TOOLS = {
  roles: "config_roles",
  agents: "config_agents",
  apps: "config_apps",
} as const
const BY_NAME = ["skills", "routines"] as const

/** Sections that stay server-side, and what to do instead. */
const SERVER_ONLY: Record<string, string> = {
  mail: "mailboxes carry passwords and OAuth secrets: connect them in Liaison (Settings) or run liaison config apply on the server",
  email: "the sender identity carries provider keys: set it in Liaison (Settings) or on the server",
  users: "seats and invitations: invite people in Liaison (Settings, People) or on the server",
  invoicing: "issuer legal identity and e-invoicing: set it in the Invoicing app or on the server",
  tickets: "ticket inboxes are tied to mailboxes: set them in Liaison or on the server",
  knowledge: "documents read the server's disk: upload them in Liaison or run it on the server",
  apiConnections: "API connections carry secrets: add them in Liaison or on the server",
  secrets: "secrets never travel in a config file sent from your machine",
  models: "model keys stay server-side: set them in Liaison (Settings, Models) or on the server",
  ai: "model keys stay server-side: set them in Liaison (Settings, Models) or on the server",
  credits: "plans and credits are the server operator's",
  setup: "run liaison config apply on the server for setup state",
  liaisonTeam: "run liaison config apply on the server for the Liaison team opt-ins",
}

/** Read a .yaml/.yml/.json config file. */
export function readConfigFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8")
  const data = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text)
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new CliError(`${path}: not a config object`)
  return data as Record<string, unknown>
}

/** What a file asks for, split into what is sent and what is refused (nothing sent if any refusal). */
export function planConfig(data: Record<string, unknown>): {
  sections: Array<{ key: string; value: unknown }>
  refused: string[]
} {
  const sections: Array<{ key: string; value: unknown }> = []
  const refused: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === "org" || key === "version" || key === "$schema") continue
    if (key in SECTION_TOOLS || (BY_NAME as readonly string[]).includes(key)) {
      sections.push({ key, value })
    } else if (key in SERVER_ONLY) {
      refused.push(`${key}: stays server-side (${SERVER_ONLY[key]})`)
    } else {
      refused.push(
        `${key}: not something the remote CLI applies (roles, agents, apps, skills, routines only)`,
      )
    }
  }
  return { sections, refused }
}

interface Gated {
  blocked?: { reason?: string; approvalRequestId?: string; summary?: { lines?: string[] } }
  error?: { message?: string; code?: string } | string
  [k: string]: unknown
}

function describe(r: Gated): string {
  if (r.error)
    return `refused: ${typeof r.error === "string" ? r.error : (r.error.message ?? "error")}`
  const id = r.blocked?.approvalRequestId
  if (id) {
    const lines = (r.blocked?.summary?.lines ?? []).map((l) => `\n    ${l}`).join("")
    return `waiting for approval ${id} (nothing changes until a person approves it in Liaison)${lines}`
  }
  if (r.blocked) return `held: ${r.blocked.reason ?? "blocked"}`
  return typeof r.message === "string" ? r.message : "done"
}

async function byName(
  client: Client,
  kind: "skills" | "routines",
  entries: unknown,
  io: Io,
): Promise<void> {
  if (!Array.isArray(entries)) throw new CliError(`${kind}: a list of entries, each with a name`)
  const existing =
    kind === "skills"
      ? ((
          await client.tool<{ skills?: Array<{ id: string; name: string }> }>(
            "kernel:list_skills",
            { source: "org" },
          )
        ).skills ?? [])
      : [
          ...((
            await client.tool<{ routines?: Array<{ id: string; name: string }> }>(
              "kernel:list_routines",
              { visibility: "shared" },
            )
          ).routines ?? []),
          ...((
            await client.tool<{ routines?: Array<{ id: string; name: string }> }>(
              "kernel:list_routines",
              { visibility: "mine" },
            )
          ).routines ?? []),
        ]
  const single = kind === "skills" ? "skill" : "routine"
  for (const entry of entries as Array<Record<string, unknown>>) {
    const name = String(entry.name ?? "")
    if (!name) throw new CliError(`${kind}: every entry needs a name`)
    const found = existing.find((e) => e.name === name)
    // A config file describes the organization: a new skill is the org's unless it says otherwise.
    const fields =
      kind === "skills" && !found && entry.visibility === undefined
        ? { ...entry, visibility: "org" }
        : entry
    const r = found
      ? await client.tool<Gated>(`kernel:update_${single}`, { ...fields, id: found.id })
      : await client.tool<Gated>(`kernel:create_${single}`, fields)
    io.out(`${single} ${name} (${found ? "update" : "create"}): ${describe(r)}`)
  }
}

export async function configApply(args: ParsedArgs, io: Io): Promise<number> {
  const file = args.positionals[0]
  if (!file) throw new CliError("Usage: liaison config apply <file.yaml|json> [--dry-run]")
  const data = readConfigFile(file)
  const { sections, refused } = planConfig(data)
  if (refused.length > 0) {
    io.err("Not applied: this file has sections the remote CLI does not send.")
    for (const r of refused) io.err(`  ${r}`)
    io.err("Remove them (keep them in a server-side file) and run it again. Nothing was sent.")
    return 1
  }
  if (sections.length === 0) {
    io.out("Nothing to apply (roles, agents, apps, skills, routines).")
    return 0
  }
  if (bool(args, "dry-run")) {
    for (const s of sections) io.out(`would send ${s.key}`)
    return 0
  }
  const client = clientFor(args)
  for (const s of sections) {
    if (s.key === "skills" || s.key === "routines") {
      await byName(client, s.key, s.value, io)
      continue
    }
    const tool = SECTION_TOOLS[s.key as keyof typeof SECTION_TOOLS]
    const r = await client.tool<Gated>(`kernel:${tool}`, { [s.key]: s.value })
    io.out(`${s.key}: ${describe(r)}`)
  }
  return 0
}
