// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Reference transforms: shipped EXAMPLES the agent reads (`import_reference`)
 * before writing its own transform, never importers in the product. Each is a
 * plain transform script in this folder, run through the real runner on
 * fictional data by `reference.test.ts` so it cannot rot. The CLI runs the
 * Freshdesk one for `liaison tickets import --freshdesk-xml`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { FileRule } from "~/modules/imports/transform-run"

/** A reference must fit one string of a tool result (LIVE_RESULT_LIMITS). */
export const REFERENCE_SOURCE_MAX_CHARS = 40_000

export interface ReferenceTransform {
  file: string
  sourceType: "upload" | "api"
  /** The kinds it emits, in the order they are written. */
  kinds: string[]
  /** One line: what it reads and writes. */
  about: string
  /** Upload references: the file rules to preview and start it with. */
  files?: FileRule[]
  /** API references: the api-connector connection it pulls from, shipped with its adapter. */
  connection?: ReferenceConnection
  /**
   * The settings a save may change without retyping the code
   * (`import_transform_save({ fromReference, params })`): each is one
   * top-level `const NAME = ...` line of the script.
   */
  params?: Record<string, ReferenceParam>
}

export interface ReferenceParam {
  about: string
  schema: z.ZodType
}

/**
 * The api-connector connection an API reference pulls from. It ships with the
 * adapter document, so a weak model never writes one: the only input is the
 * person's own site (asked, never guessed), and the save of the adapter goes
 * through `connector_adapter_save` and its approval card like any other.
 */
export interface ReferenceConnection {
  /** The connection's identifier: every reference of one tool shares it. */
  identifier: string
  /** One line: what the connection is and how it signs in. */
  about: string
  /** The setting that names the person's site, passed in `params` of the save. */
  siteParam: string
  siteAbout: string
  /** The site in the person's words to the API's base URL, or null when it is not one. */
  baseUrl: (site: string) => string | null
  /** The adapter document for that base URL. */
  adapter: (baseUrl: string) => Record<string, unknown>
}

/** "acme", "acme.atlassian.net" or any URL on it, to https://acme.atlassian.net. */
export function atlassianBaseUrl(site: string): string | null {
  const raw = site.trim().toLowerCase()
  const host = (() => {
    if (!raw.includes(".") && !raw.includes("/")) return `${raw}.atlassian.net`
    try {
      return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
    } catch {
      return null
    }
  })()
  if (!host) return null
  const m = /^([a-z0-9][a-z0-9-]{0,62})\.atlassian\.net$/.exec(host)
  return m ? `https://${m[1]}.atlassian.net` : null
}

/**
 * One Jira Cloud connection serves both Jira references: basic auth (an
 * account's email and an API token, entered on the secret card), the
 * attachment redirect host, and the opt-in header the service desk API asks
 * for (ignored by the platform API). Its read operations are the ones a test
 * call checks the connection with.
 */
function jiraAdapter(baseUrl: string): Record<string, unknown> {
  return {
    id: "jira",
    name: "Jira",
    version: "1",
    description: "Jira Cloud: the platform REST API v3 and the service desk API, for imports.",
    baseUrl,
    auth: { type: "basic" },
    redirectHosts: ["api.media.atlassian.com"],
    headers: { "X-ExperimentalApi": "opt-in" },
    operations: [
      {
        name: "list_projects",
        description: "The site's projects (key and name), to check the connection.",
        kind: "read",
        method: "GET",
        path: "/rest/api/3/project/search",
        params: { type: "object", properties: {} },
        items: "/values",
        fields: ["key", "name"],
      },
      {
        name: "list_service_desks",
        description: "The site's service desks (project key and name).",
        kind: "read",
        method: "GET",
        path: "/rest/servicedeskapi/servicedesk",
        params: { type: "object", properties: {} },
        items: "/values",
        fields: ["id", "projectKey", "projectName"],
      },
    ],
  }
}

const JIRA_CONNECTION: ReferenceConnection = {
  identifier: "jira",
  about:
    "The api-connector connection jira: https://<site>.atlassian.net, signed in with an account's email and an API token entered on a secret card.",
  siteParam: "SITE",
  siteAbout:
    'The person\'s Jira Cloud site, e.g. "acme" or "https://acme.atlassian.net": ask them for it, never guess it from an email domain.',
  baseUrl: atlassianBaseUrl,
  adapter: jiraAdapter,
}

/** Jira project keys: `NWA`, `OPS_2`. */
const projectKeys = z
  .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/, "a Jira project key such as NWA"))
  .max(200)

export const REFERENCE_TRANSFORMS: Record<string, ReferenceTransform> = {
  "jira-software": {
    file: "jira-software.js",
    sourceType: "api",
    kinds: ["projects.project", "projects.task"],
    about:
      "Jira Software (Cloud REST API v3) projects, epics, stories and subtasks with statuses, comments and attachments, into projects.",
    connection: JIRA_CONNECTION,
    params: {
      PROJECT_KEYS: {
        about: 'The project keys to import, e.g. ["NWA", "OPS"]; empty: every software project.',
        schema: projectKeys,
      },
    },
  },
  "jira-service-management": {
    file: "jira-service-management.js",
    sourceType: "api",
    kinds: ["tickets.category", "contacts.contact", "tickets.ticket"],
    about:
      "Jira Service Management through its service desk API (the connection sends X-ExperimentalApi: opt-in): request types, customers with their organization, public replies and internal notes, attachments where the comments show them, into tickets.",
    connection: JIRA_CONNECTION,
    params: {
      DESK_KEYS: {
        about:
          'The service desks to import, by project key, e.g. ["SUP"]; empty: every service desk.',
        schema: projectKeys,
      },
    },
  },
  "freshdesk-xml": {
    file: "freshdesk-xml.js",
    sourceType: "upload",
    kinds: ["tickets.ticket"],
    about:
      "A Freshdesk XML backup (Users, Agents, Tickets XML files) into tickets, with the whole conversation and internal notes.",
    files: [{ match: "Users*.xml" }, { match: "*Agents*.xml" }, { match: "Tickets*.xml" }],
  },
  "invoice-csv": {
    file: "invoice-csv.js",
    sourceType: "upload",
    kinds: ["invoicing.document"],
    about:
      "An example to adapt (made-up columns, no specific product): an invoice CSV with one row per line item plus the original PDFs in a zip, into invoices and credit notes with lines, taxes, customer, status and payment.",
    files: [{ match: "*.csv" }],
  },
  "slack-export": {
    file: "slack-export.js",
    sourceType: "upload",
    kinds: ["chat.thread", "chat.message"],
    about:
      "A standard Slack export zip (users.json, channels.json, groups.json, a folder of daily JSON files per channel) into chat channels with their history: replies, bots, reactions, edits.",
    files: [
      { match: "users.json" },
      { match: "channels.json" },
      { match: "groups.json" },
      { match: "*/*.json" },
    ],
  },
}

export interface ReferenceSource extends ReferenceTransform {
  name: string
  code: string
}

/** One reference with its code, or a throw naming the ones that exist. */
export function readReference(name: string): ReferenceSource {
  const ref = Object.hasOwn(REFERENCE_TRANSFORMS, name) ? REFERENCE_TRANSFORMS[name] : undefined
  if (!ref) {
    throw new Error(
      `No reference transform ${JSON.stringify(name)}; there are ${Object.keys(REFERENCE_TRANSFORMS).join(", ")}.`,
    )
  }
  return { name, ...ref, code: readFileSync(join(import.meta.dir, ref.file), "utf8") }
}

/** A refused reference save, in words the agent can act on. */
export class ReferenceParamError extends Error {}

/**
 * The reference's code with some of its declared settings changed, each
 * `const NAME = ...` line rewritten to the JSON of the value; every other line
 * stays byte for byte. No params: the reference unchanged.
 */
export function referenceWithParams(
  ref: ReferenceSource,
  params: Record<string, unknown> = {},
): string {
  let code = ref.code
  const declared = ref.params ?? {}
  for (const [key, value] of Object.entries(params)) {
    // The site goes to the connection's adapter, never into the code.
    if (ref.connection && key === ref.connection.siteParam) continue
    const param = Object.hasOwn(declared, key) ? declared[key] : undefined
    if (!param) {
      const names = [
        ...Object.keys(declared),
        ...(ref.connection ? [ref.connection.siteParam] : []),
      ]
      throw new ReferenceParamError(
        `${ref.name} has no setting ${key}${names.length > 0 ? ` (it has ${names.join(", ")})` : " (it has none: save it unchanged)"}.`,
      )
    }
    const parsed = param.schema.safeParse(value)
    if (!parsed.success) {
      throw new ReferenceParamError(
        `${key}: ${parsed.error.issues.map((i) => i.message).join("; ")}. ${param.about}`,
      )
    }
    const line = new RegExp(`^const ${key} = .*$`, "m")
    if (!line.test(code))
      throw new Error(`reference ${ref.name} declares ${key} but has no const line for it`)
    // A replacer function: a `$` in a value is inserted as is, never read as a
    // replacement pattern (`$&`, `$1`) that would mangle the code.
    const replacement = `const ${key} = ${JSON.stringify(parsed.data)}`
    code = code.replace(line, () => replacement)
  }
  return code
}

/**
 * The adapter document of an API reference's connection for the person's
 * site, or a refusal in words the agent can act on.
 */
export function referenceConnectionAdapter(
  ref: ReferenceSource,
  site: unknown,
): { identifier: string; adapter: Record<string, unknown> } {
  const conn = ref.connection
  if (!conn)
    throw new ReferenceParamError(`${ref.name} is not an API reference: it needs no connection.`)
  const baseUrl = typeof site === "string" ? conn.baseUrl(site) : null
  if (!baseUrl) {
    throw new ReferenceParamError(
      `${conn.siteParam}: ${JSON.stringify(site)} is not a site this reference reads. ${conn.siteAbout}`,
    )
  }
  return { identifier: conn.identifier, adapter: conn.adapter(baseUrl) }
}
