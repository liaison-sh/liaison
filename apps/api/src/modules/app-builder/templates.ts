// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The starters apps_build_create emits: complete, working drafts that pass
// apps_build_check and apps_build_preview as they are, written for the org's
// own app name (scopes and store read scopes must start with it).
//
//  - "store-crud": one ctx.store collection `items` (declared, readable by the
//    agent under `<app>:items:read`), a read tool `items_list` and a write tool
//    `items_add`, each logging a line.
//  - "read-only": one read tool `summary` that counts the collection's
//    documents; no write.

import type { DraftFiles } from "~/modules/app-builder/build/build-draft"

export const DRAFT_TEMPLATES = ["store-crud", "read-only"] as const
export type DraftTemplate = (typeof DRAFT_TEMPLATES)[number]

function manifest(appName: string, title: string, tools: Record<string, unknown>, write: boolean) {
  const read = `${appName}:items:read`
  return `${JSON.stringify(
    {
      name: appName,
      version: "0.1.0",
      packageFormat: 1,
      host: "^1",
      license: "UNLICENSED",
      displayName: title,
      description: title,
      scopes: write ? [read, `${appName}:items:write`] : [read],
      store: {
        collections: {
          items: { readScope: read, agentReadable: true },
        },
      },
      tools,
    },
    null,
    2,
  )}\n`
}

const STORE_CRUD_HANDLERS = `import { type AppContext, defineHandlers } from "@liaison/app-sdk"

interface Item {
  title: string
  note: string | null
  createdAt: string
}

/** Lists the items, newest first. */
export async function items_list(params: { limit?: number }, ctx: AppContext) {
  const page = await ctx.store.query<Item>("items", {
    orderBy: { field: "updated_at", dir: "desc" },
    limit: params.limit ?? 50,
  })
  ctx.logger.info("listed items", { count: page.items.length })
  return { items: page.items.map((d) => ({ id: d.id, ...d.data })), nextCursor: page.nextCursor }
}

/** Adds one item. */
export async function items_add(params: { title: string; note?: string }, ctx: AppContext) {
  const id = \`\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 8)}\`
  const doc = await ctx.store.set<Item>(
    "items",
    id,
    { title: params.title, note: params.note ?? null, createdAt: new Date().toISOString() },
    { ifVersion: 0 },
  )
  ctx.logger.info("added an item", { id: doc.id })
  return { id: doc.id, version: doc.version }
}

export default defineHandlers({ items_list, items_add })
`

const READ_ONLY_HANDLERS = `import { type AppContext, defineHandlers } from "@liaison/app-sdk"

/** How many items the app holds. */
export async function summary(_params: Record<string, never>, ctx: AppContext) {
  const count = await ctx.store.count("items")
  ctx.logger.info("counted items", { count })
  return { count }
}

export default defineHandlers({ summary })
`

const README = (title: string) => `# ${title}\n\nBuilt with the Liaison app builder.\n`

/** The files of a starter for `appName`. */
export function templateFiles(template: DraftTemplate, appName: string, title: string): DraftFiles {
  const read = `${appName}:items:read`
  if (template === "read-only") {
    return {
      "app.manifest.json": manifest(
        appName,
        title,
        {
          summary: {
            description: "How many items the app holds.",
            requiredScopes: [read],
            handler: "summary",
            readOnly: true,
            params: { type: "object", properties: {}, additionalProperties: false },
          },
        },
        false,
      ),
      "handlers.ts": READ_ONLY_HANDLERS,
      "README.md": README(title),
    }
  }
  return {
    "app.manifest.json": manifest(
      appName,
      title,
      {
        items_list: {
          description: "List the items, newest first.",
          requiredScopes: [read],
          handler: "items_list",
          readOnly: true,
          params: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
            additionalProperties: false,
          },
        },
        items_add: {
          description: "Add an item with a title and an optional note.",
          requiredScopes: [`${appName}:items:write`],
          handler: "items_add",
          params: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 200 },
              note: { type: "string", maxLength: 2000 },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      true,
    ),
    "handlers.ts": STORE_CRUD_HANDLERS,
    "README.md": README(title),
  }
}
