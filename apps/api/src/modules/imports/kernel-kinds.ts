// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Kernel import kinds: kinds whose tables no app manifest owns (agents'
 * skills and routines, chat channels and their messages). Declared here with the same shape and the same rules
 * as a manifest's `import.kinds` (`importDeclarationErrors`), listed for every
 * org by `listImportKinds` and resolved by `lookupImportKind` without any app
 * registration. Their host handlers live in `builtin-import-handlers.ts`.
 *
 * Their tables must be on the kernel allowlist (`KERNEL_IMPORT_TABLES`): undo
 * deletes exactly what a kind declares.
 *
 * Kept free of runtime imports (like kind-schema.ts) so the manifest
 * validator and the app runtime can import it without a cycle.
 */
import { type ImportKindDecl, importDeclarationErrors } from "~/modules/imports/kind-schema"

const SCOPE = { type: "string", minLength: 1, maxLength: 200 }

/** `agents.skill`: one skill (a playbook the agent reads into a turn). */
const skillKind: ImportKindDecl = {
  label: "Skills",
  schema: {
    type: "object",
    required: ["name", "description", "body"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", minLength: 1, maxLength: 100 },
      body: { type: "string", minLength: 1 },
      domain: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 64 },
      requiredScopes: { type: "array", items: SCOPE, maxItems: 100 },
      enabled: { type: "boolean" },
      visibility: { type: "string", enum: ["personal", "org"] },
      authorEmail: { type: "string", maxLength: 320 },
    },
    additionalProperties: false,
  },
  handler: "importSkills",
  dedupKey: "name",
  tables: ["kernel.skills"],
  writeScopes: ["kernel:skills:write"],
  people: ["authorEmail"],
}

/** `agents.routine`: one routine. Imported routines arrive disabled (Q4). */
const routineKind: ImportKindDecl = {
  label: "Routines",
  schema: {
    type: "object",
    required: ["name", "description", "prompt", "kind", "scopes"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", minLength: 1, maxLength: 200 },
      prompt: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["recurring", "scheduled", "event"] },
      cron: { type: "string", minLength: 1, maxLength: 200 },
      timezone: { type: "string", minLength: 1, maxLength: 100 },
      runAt: { type: "string", minLength: 1 },
      event: { type: "string", minLength: 1, maxLength: 200 },
      scopes: { type: "array", items: SCOPE, maxItems: 200 },
      visibility: { type: "string", enum: ["personal", "shared"] },
      ownerEmail: { type: "string", maxLength: 320 },
    },
    additionalProperties: false,
  },
  handler: "importRoutines",
  dedupKey: "name",
  tables: ["kernel.routines"],
  writeScopes: ["kernel:routines:write"],
  people: ["ownerEmail"],
}

const EMAIL = { type: "string", maxLength: 320 }

/** `chat.thread`: one channel (a discoverable chat thread). */
const threadKind: ImportKindDecl = {
  label: "Chat channels",
  schema: {
    type: "object",
    required: ["externalRef", "name"],
    properties: {
      externalRef: { type: "string", minLength: 1, maxLength: 200 },
      name: { type: "string", minLength: 1, maxLength: 200 },
      topic: { type: "string", maxLength: 250 },
      description: { type: "string", maxLength: 2000 },
      createdAt: { type: "string", minLength: 1 },
      creatorEmail: EMAIL,
      memberEmails: { type: "array", items: EMAIL, maxItems: 5000 },
      archived: { type: "boolean" },
      private: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: "importThreads",
  dedupKey: "externalRef",
  tables: ["kernel.threads", "kernel.thread_participants"],
  writeScopes: ["kernel:threads:admin"],
  people: ["creatorEmail", "memberEmails"],
}

/** `chat.message`: one message of a channel the run (or an earlier one) imported. */
const messageKind: ImportKindDecl = {
  label: "Chat messages",
  schema: {
    type: "object",
    required: ["externalRef", "threadRef", "content", "createdAt"],
    properties: {
      externalRef: { type: "string", minLength: 1, maxLength: 200 },
      threadRef: { type: "string", minLength: 1, maxLength: 200 },
      authorEmail: EMAIL,
      authorName: { type: "string", maxLength: 200 },
      botKey: { type: "string", minLength: 1, maxLength: 200 },
      system: { type: "boolean" },
      content: { type: "string", maxLength: 200_000 },
      createdAt: { type: "string", minLength: 1 },
      replyToRef: { type: "string", minLength: 1, maxLength: 200 },
      alsoInChannel: { type: "boolean" },
      editedAt: { type: "string", minLength: 1 },
      deleted: { type: "boolean" },
      reactions: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          required: ["emoji", "userEmails"],
          properties: {
            emoji: { type: "string", minLength: 1, maxLength: 64 },
            userEmails: { type: "array", items: EMAIL, maxItems: 1000 },
          },
          additionalProperties: false,
        },
      },
      attachments: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            fileId: { type: "string", minLength: 1 },
            filePath: { type: "string", minLength: 1 },
            filename: { type: "string", minLength: 1, maxLength: 255 },
            mimeType: { type: "string", minLength: 1, maxLength: 255 },
          },
          additionalProperties: false,
        },
      },
      metadata: { type: "object" },
    },
    additionalProperties: false,
  },
  handler: "importMessages",
  dedupKey: "externalRef",
  tables: ["kernel.messages", "kernel.message_reactions", "kernel.files", "kernel.users"],
  writeScopes: ["kernel:threads:admin"],
  people: ["authorEmail", "reactions.userEmails"],
  files: ["attachments"],
  parent: "thread",
  // A reply that arrived before its root is linked to it after the kind.
  rollupTables: ["kernel.messages"],
}

/** Kernel kinds by full name (`<app>.<kind>`). */
export const KERNEL_IMPORT_KINDS: Readonly<Record<string, ImportKindDecl>> = {
  "agents.skill": skillKind,
  "agents.routine": routineKind,
  "chat.thread": threadKind,
  "chat.message": messageKind,
}

/**
 * The declaration errors of a set of kernel kinds, checked per app part with
 * the manifest rules (tables on the kernel allowlist or the `app_<app>`
 * schema, dedup key, parent, rollupTables). Pinned by kernel-kinds.test.ts.
 */
export function kernelKindDeclarationErrors(
  kinds: Readonly<Record<string, ImportKindDecl>>,
): string[] {
  const byApp = new Map<string, Record<string, ImportKindDecl>>()
  const errors: string[] = []
  for (const [full, decl] of Object.entries(kinds)) {
    const dot = full.indexOf(".")
    if (dot <= 0 || dot === full.length - 1) {
      errors.push(`kernel kind "${full}": the name must be <app>.<kind>`)
      continue
    }
    const app = full.slice(0, dot)
    const group = byApp.get(app) ?? {}
    group[full.slice(dot + 1)] = decl
    byApp.set(app, group)
  }
  for (const [app, group] of byApp) {
    errors.push(...importDeclarationErrors({ kinds: group }, app))
  }
  return errors
}
