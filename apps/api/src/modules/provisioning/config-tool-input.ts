// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What an agent config tool (`config_<section>`) accepts and returns.
 *
 * Input: the CLI schema of the section (`cli/config/schema.ts`), minus
 *  - every SECRET: a password, a client secret, connection credentials. A
 *    secret never travels as a tool param (it would land in the transcript and
 *    the approval row); the agent asks for it with `request_secret`, which posts
 *    it straight to the credential routes. The entry is applied without it and
 *    reports `pending: credentials`.
 *  - every field that reads the SERVER's disk (`contentFile`, `dir`,
 *    `logoPath`, an adapter path): the server has no config directory for an
 *    agent, so the content comes inline or as an uploaded file id.
 * Each refusal names its path and what to do instead. `${VAR}` is NOT special
 * here: nothing on the tool path interpolates the environment, so a `${...}`
 * inside a value is stored exactly as written.
 *
 * Output: the runner's report without an invite link (a bearer token for the
 * invited person) or an API key.
 */
import { googleOAuthClientIdSchema } from "@liaison/shared"
import { z } from "zod"
import {
  agentSchema,
  atMostOneImapPerOwner,
  einvoicingSchema,
  emailSchema,
  hsCodeSchema,
  IMAP_ONE_PER_OWNER_MESSAGE,
  imapSchema,
  issuerProfileSchema,
  kbCollectionSchema,
  kbInlineDocumentSchema,
  kbSourceSchema,
  kbUploadedDocumentSchema,
  liaisonTeamSchema,
  mailProvidersSchema,
  type ProvisioningConfig,
  roleSchema,
  taxRegimeSchema,
} from "~/cli/config/schema"
import { isRecord } from "~/lib/guards"
import { SETUP_FEATURE_IDS } from "~/modules/connection-guides/setup-features"
import type { ConfigReport } from "~/modules/provisioning/config-sections"

/** The sections an agent can configure, in canonical order. `org`/`admin`
 *  create the tenant (CLI only); BYOK and API keys go through the secret card. */
export const CONFIG_TOOL_SECTIONS = [
  "setup",
  "roles",
  "email",
  "users",
  "mail",
  "tickets",
  "apps",
  "apiConnectors",
  "knowledge",
  "agents",
  "invoicing",
  "liaisonTeam",
] as const

export type ConfigToolSection = (typeof CONFIG_TOOL_SECTIONS)[number]

export function isConfigToolSection(value: string): value is ConfigToolSection {
  return (CONFIG_TOOL_SECTIONS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Refusals: secrets and server-disk fields, checked on the raw input so the
// message names the exact path whatever else is wrong with the entry.

function secretMessage(path: string): string {
  return `${path} is a secret: ask for it with request_secret`
}

function diskMessage(path: string, replacement: string): string {
  return `${path} reads the server's disk: upload the file and pass ${replacement}`
}

function entries(v: unknown): Array<[number, Record<string, unknown>]> {
  if (!Array.isArray(v)) return []
  return v.flatMap(
    (item, i): Array<[number, Record<string, unknown>]> => (isRecord(item) ? [[i, item]] : []),
  )
}

function has(o: unknown, key: string): boolean {
  return isRecord(o) && o[key] !== undefined
}

/** Every refusal for this section's raw input, in input order. */
export function findRefusals(section: ConfigToolSection, raw: unknown): string[] {
  const out: string[] = []
  const boxes = (base: string, list: unknown) => {
    for (const [i, m] of entries(list)) {
      if (has(m.imap, "password")) out.push(secretMessage(`${base}[${i}].imap.password`))
      if (has(m.google, "clientSecret")) {
        out.push(secretMessage(`${base}[${i}].google.clientSecret`))
      }
    }
  }
  switch (section) {
    case "users":
      for (const [i, u] of entries(raw)) {
        if (u.password !== undefined) out.push(secretMessage(`users[${i}].password`))
        if (u.mode === "create") {
          out.push(
            `users[${i}].mode create needs a password, which is a secret: invite the person instead`,
          )
        }
      }
      break
    case "mail":
      if (isRecord(raw)) boxes("mail.mailboxes", raw.mailboxes)
      break
    case "tickets":
      if (isRecord(raw)) boxes("tickets.inboxes", raw.inboxes)
      break
    case "apps":
      for (const [i, a] of entries(raw)) {
        if (has(a.connection, "credentials")) {
          out.push(secretMessage(`apps[${i}].connection.credentials`))
        }
        if (isRecord(a.connection) && has(a.connection.oauthClient, "clientSecret")) {
          out.push(secretMessage(`apps[${i}].connection.oauthClient.clientSecret`))
        }
      }
      break
    case "apiConnectors":
      for (const [i, c] of entries(raw)) {
        if (c.credentials !== undefined) out.push(secretMessage(`apiConnectors[${i}].credentials`))
        if (typeof c.adapter === "string") {
          out.push(
            `apiConnectors[${i}].adapter reads the server's disk: pass the adapter document inline`,
          )
        }
      }
      break
    case "knowledge":
      if (isRecord(raw)) {
        for (const [i, d] of entries(raw.documents)) {
          if (d.contentFile !== undefined) {
            out.push(diskMessage(`knowledge.documents[${i}].contentFile`, "contentFileId"))
          }
          if (d.dir !== undefined) {
            out.push(diskMessage(`knowledge.documents[${i}].dir`, "contentFileId"))
          }
        }
      }
      break
    case "invoicing":
      if (isRecord(raw)) {
        for (const [i, p] of entries(raw.issuerProfiles)) {
          if (p.logoPath !== undefined) {
            out.push(diskMessage(`invoicing.issuerProfiles[${i}].logoPath`, "logoFileId"))
          }
        }
      }
      break
    default:
      break
  }
  return out
}

// ---------------------------------------------------------------------------
// Tool-path schemas: the CLI section schemas without secrets or disk fields,
// strict throughout: an unknown key is refused, never silently dropped.

const toolImapSchema = imapSchema.omit({ password: true }).strict()
const toolGoogleClientSchema = z.object({ clientId: googleOAuthClientIdSchema }).strict()

const toolMailboxSchema = z
  .object({
    address: z.string().min(1),
    provider: z.enum(["gmail", "imap"]),
    owner: z.string().min(1).optional(),
    google: toolGoogleClientSchema.optional(),
    imap: toolImapSchema.optional(),
  })
  .strict()
  .refine((m) => m.provider !== "imap" || m.imap !== undefined, {
    message: "imap config is required when provider is 'imap'",
    path: ["imap"],
  })
  // A personal mailbox is its owner's to connect: a Gmail one needs the
  // owner's Google consent, and the password card the tool path asks with
  // connects a SHARED mailbox only. Accepting `owner` here approved a
  // "personal" mailbox that was then connected as the organization's.
  .refine((m) => m.owner === undefined, {
    message:
      "a personal mailbox is connected by its owner, in their own conversation: a Gmail one on a card, kernel__request_secret kind oauth_connect (app mail, connection gmail, mode personal); an IMAP one in Settings > Mail. Leave owner out to connect a shared mailbox",
    path: ["owner"],
  })

const toolInboxSchema = z
  .object({
    address: z.string().min(1),
    provider: z.enum(["gmail", "imap"]),
    google: toolGoogleClientSchema.optional(),
    imap: toolImapSchema.optional(),
    name: z.string().min(1).optional(),
    fromDisplayName: z.string().optional(),
    defaultTeam: z.string().min(1).optional(),
    default: z.boolean().optional(),
  })
  .strict()
  .refine((m) => m.provider !== "imap" || m.imap !== undefined, {
    message: "imap config is required when provider is 'imap'",
    path: ["imap"],
  })

const toolConnectionSchema = z
  .object({
    name: z.string().min(1),
    identifier: z.string().optional(),
    ownerType: z.enum(["org", "user"]).optional(),
  })
  .strict()

const toolAppSchema = z
  .object({
    name: z.string().min(1),
    enable: z.boolean(),
    connection: toolConnectionSchema.optional(),
    providers: mailProvidersSchema.optional(),
    config: z.record(z.string().min(1), z.unknown()).optional(),
    // Org fields of the app's settings page by path, e.g. { "fullOrderHistory": true }.
    settings: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .strict()
  .refine((a) => a.providers === undefined || a.name === "mail", {
    message: "providers is only supported on the 'mail' app",
    path: ["providers"],
  })
  .refine(
    (a) =>
      (a.providers === undefined && a.config === undefined && a.settings === undefined) || a.enable,
    {
      message: "providers, config and settings require enable: true",
      path: ["enable"],
    },
  )

const toolUserSchema = z
  .object({
    email: z.string().min(1),
    name: z.string().min(1),
    role: z.string().min(1),
    mode: z.literal("invite").default("invite"),
  })
  .strict()

const toolApiConnectorSchema = z
  .object({
    identifier: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a lowercase slug of at most 40 characters"),
    adapter: z.record(z.string(), z.unknown()),
  })
  .strict()

const toolIssuerProfileSchema = issuerProfileSchema.omit({ logoPath: true }).strict()

const SECTION_SCHEMAS = {
  roles: z.array(roleSchema.strict()),
  // The ids as an enum, so the tool's input schema lists them.
  setup: z
    .object({ features: z.array(z.enum(SETUP_FEATURE_IDS as [string, ...string[]])) })
    .strict(),
  email: emailSchema.unwrap().strict(),
  users: z.array(toolUserSchema),
  mail: z
    .object({
      mailboxes: z
        .array(toolMailboxSchema)
        .optional()
        .refine((list) => atMostOneImapPerOwner(list ?? [], (m) => m.owner), {
          message: IMAP_ONE_PER_OWNER_MESSAGE,
        }),
    })
    .strict(),
  tickets: z
    .object({
      approveRepliesFromHome: z.boolean().optional(),
      inboxes: z
        .array(toolInboxSchema)
        .optional()
        .refine((list) => (list ?? []).filter((i) => i.default === true).length <= 1, {
          message: "at most one inbox can be the default",
        }),
    })
    .strict(),
  apps: z.array(toolAppSchema),
  apiConnectors: z.array(toolApiConnectorSchema),
  knowledge: z
    .object({
      collections: z.array(kbCollectionSchema.strict()).optional(),
      documents: z.array(z.union([kbInlineDocumentSchema, kbUploadedDocumentSchema])).optional(),
      sources: z.array(kbSourceSchema.strict()).optional(),
    })
    .strict(),
  agents: z.array(agentSchema),
  invoicing: z
    .object({
      issuerProfiles: z.array(toolIssuerProfileSchema).optional(),
      taxRegimes: z.array(taxRegimeSchema.strict()).optional(),
      hsCodes: z.array(hsCodeSchema.strict()).optional(),
      einvoicing: einvoicingSchema.optional(),
    })
    .strict(),
  liaisonTeam: liaisonTeamSchema.unwrap(),
} satisfies Record<ConfigToolSection, z.ZodType>

/** The JSON-schema-able param schema of one section (for the tool params). */
export function sectionSchema(section: ConfigToolSection): z.ZodType {
  return SECTION_SCHEMAS[section]
}

/**
 * The section's input as a JSON schema (draft-07, every node inline): what the
 * model reads as the shape of the tool's `<section>` param. The param itself
 * validates nothing (the handler's parse does, so a secret field gets its own
 * refusal instead of "unrecognized key").
 */
export function sectionJsonSchema(section: ConfigToolSection): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(SECTION_SCHEMAS[section], {
    io: "input",
    target: "draft-7",
    unrepresentable: "any",
    reused: "inline",
  }) as Record<string, unknown>
  return schema
}

/** One small valid input per section, shown next to the shape when a call is refused. */
export const SECTION_EXAMPLES: Record<ConfigToolSection, unknown> = {
  roles: [{ name: "Support agent", scopes: ["tickets:tickets:read", "tickets:tickets:write"] }],
  setup: { features: ["email", "support", "import"] },
  email: { from: "Acme Support <support@acme.example>", replyTo: "support@acme.example" },
  users: [{ email: "ana@acme.example", name: "Ana Diaz", role: "Support agent" }],
  mail: {
    mailboxes: [
      {
        address: "support@acme.example",
        provider: "imap",
        imap: {
          email: "support@acme.example",
          imapHost: "imap.acme.example",
          imapPort: 993,
          smtpHost: "smtp.acme.example",
          smtpPort: 465,
          username: "support@acme.example",
        },
      },
    ],
  },
  tickets: {
    inboxes: [
      {
        address: "help@acme.example",
        provider: "imap",
        name: "Help desk",
        default: true,
        imap: {
          email: "help@acme.example",
          imapHost: "imap.acme.example",
          imapPort: 993,
          smtpHost: "smtp.acme.example",
          smtpPort: 465,
          username: "help@acme.example",
        },
      },
    ],
  },
  apps: [{ name: "tickets", enable: true }],
  apiConnectors: [
    {
      identifier: "crm",
      adapter: {
        id: "crm",
        name: "CRM",
        version: "1.0.0",
        baseUrl: "https://crm.acme.example",
        auth: { type: "bearer" },
        operations: [],
      },
    },
  ],
  knowledge: {
    collections: [{ name: "Handbook" }],
    documents: [{ title: "Refund policy", collection: "Handbook", content: "# Refunds\n..." }],
  },
  agents: [{ handle: "support", displayName: "Support agent", purpose: "Answers tickets" }],
  invoicing: {
    taxRegimes: [{ issuerCountry: "FR", treatment: "domestic", defaultRateBp: 2000 }],
  },
  liaisonTeam: { register: true, forwardBugReports: false },
}

const HINT_DEPTH = 5

/** A JSON schema node as a short type: `{ name, scopes: [string], description? }`. */
function hintOf(node: unknown, depth: number): string {
  if (!isRecord(node)) return "any"
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join("|")
  if ("const" in node) return JSON.stringify(node.const)
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = node[key]
    if (Array.isArray(options)) return options.map((o) => hintOf(o, depth)).join(" | ")
  }
  if (node.type === "array") return `[${hintOf(node.items, depth)}]`
  if (node.type === "object" || isRecord(node.properties)) {
    const props = isRecord(node.properties) ? node.properties : {}
    const keys = Object.keys(props)
    if (keys.length === 0) return "{ ... }"
    if (depth >= HINT_DEPTH) return `{ ${keys.join(", ")} }`
    const required = new Set(Array.isArray(node.required) ? node.required : [])
    const fields = keys.map(
      (k) => `${k}${required.has(k) ? "" : "?"}: ${hintOf(props[k], depth + 1)}`,
    )
    return `{ ${fields.join(", ")} }`
  }
  return typeof node.type === "string" ? node.type : "any"
}

/** The section's expected keys and entry shapes in one line (`?` marks an optional key). */
export function sectionShapeHint(section: ConfigToolSection): string {
  return hintOf(sectionJsonSchema(section), 0)
}

function issuePath(section: ConfigToolSection, path: ReadonlyArray<PropertyKey>): string {
  let out: string = section
  for (const p of path) out += typeof p === "number" ? `[${p}]` : `.${String(p)}`
  return out
}

export type ParsedSection = { ok: true; config: ProvisioningConfig } | { ok: false; error: string }

/**
 * Validate one section's tool input and turn it into the provisioning config
 * the runner takes. `org` names the live org (the runner never resolves an org
 * from it on the tool path; it is only there because every provisioner takes
 * the whole config). Never throws.
 */
export function parseSectionInput(
  section: ConfigToolSection,
  raw: unknown,
  org: { slug: string; name: string },
): ParsedSection {
  const refusals = findRefusals(section, raw)
  if (refusals.length > 0) return { ok: false, error: refusals.join("; ") }
  const base: ProvisioningConfig = { org }
  switch (section) {
    case "roles": {
      const r = SECTION_SCHEMAS.roles.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, roles: r.data } } : fail(section, r.error)
    }
    case "setup": {
      const r = SECTION_SCHEMAS.setup.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, setup: r.data } } : fail(section, r.error)
    }
    case "email": {
      const r = SECTION_SCHEMAS.email.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, email: r.data } } : fail(section, r.error)
    }
    case "users": {
      const r = SECTION_SCHEMAS.users.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, users: r.data } } : fail(section, r.error)
    }
    case "mail": {
      const r = SECTION_SCHEMAS.mail.safeParse(raw)
      if (!r.success) return fail(section, r.error)
      const mailboxes = (r.data.mailboxes ?? []).map((m) => ({
        address: m.address,
        provider: m.provider,
        ...(m.owner !== undefined ? { owner: m.owner } : {}),
        ...(m.google ? { google: { clientId: m.google.clientId, clientSecret: "" } } : {}),
        ...(m.imap ? { imap: { ...m.imap, password: "" } } : {}),
      }))
      return { ok: true, config: { ...base, mail: { mailboxes } } }
    }
    case "tickets": {
      const r = SECTION_SCHEMAS.tickets.safeParse(raw)
      if (!r.success) return fail(section, r.error)
      const inboxes = (r.data.inboxes ?? []).map((i) => ({
        ...i,
        google: i.google ? { clientId: i.google.clientId, clientSecret: "" } : undefined,
        imap: i.imap ? { ...i.imap, password: "" } : undefined,
      }))
      return {
        ok: true,
        config: {
          ...base,
          tickets: {
            ...(r.data.approveRepliesFromHome !== undefined
              ? { approveRepliesFromHome: r.data.approveRepliesFromHome }
              : {}),
            ...(r.data.inboxes ? { inboxes } : {}),
          },
        },
      }
    }
    case "apps": {
      const r = SECTION_SCHEMAS.apps.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, apps: r.data } } : fail(section, r.error)
    }
    case "apiConnectors": {
      const r = SECTION_SCHEMAS.apiConnectors.safeParse(raw)
      return r.success
        ? { ok: true, config: { ...base, apiConnectors: r.data } }
        : fail(section, r.error)
    }
    case "knowledge": {
      const r = SECTION_SCHEMAS.knowledge.safeParse(raw)
      return r.success
        ? { ok: true, config: { ...base, knowledge: r.data } }
        : fail(section, r.error)
    }
    case "agents": {
      const r = SECTION_SCHEMAS.agents.safeParse(raw)
      return r.success ? { ok: true, config: { ...base, agents: r.data } } : fail(section, r.error)
    }
    case "invoicing": {
      const r = SECTION_SCHEMAS.invoicing.safeParse(raw)
      return r.success
        ? { ok: true, config: { ...base, invoicing: r.data } }
        : fail(section, r.error)
    }
    case "liaisonTeam": {
      const r = SECTION_SCHEMAS.liaisonTeam.safeParse(raw)
      return r.success
        ? { ok: true, config: { ...base, liaisonTeam: r.data } }
        : fail(section, r.error)
    }
  }
}

function fail(section: ConfigToolSection, error: z.ZodError): ParsedSection {
  return {
    ok: false,
    error: error.issues.map((i) => `${issuePath(section, i.path)}: ${i.message}`).join("; "),
  }
}

// ---------------------------------------------------------------------------
// Result stripping.

/** Keys whose value is a bearer secret: an invite link or an API key. */
const SECRET_RESULT_KEYS = new Set(["inviteUrl", "inviteToken", "key"])

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_RESULT_KEYS.has(k)) continue
    out[k] = strip(v)
  }
  return out
}

/** The report a tool may return: no invite link, no API key, anywhere in it. */
export function stripSecretsFromResult(report: ConfigReport): ConfigReport {
  const sections: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(report.sections)) sections[k] = strip(v)
  return { ...report, sections }
}
