// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"

/**
 * Mock Google Drive REST v3 server for E2E tests.
 *
 * Routes mounted under /drive/v3 mirroring the production endpoints used by
 * `apps/api/src/apps/google-drive/drive-rest.ts`:
 *   - GET /drive/v3/files                     — list / search
 *   - GET /drive/v3/files/:id                 — metadata (no `alt`)
 *   - GET /drive/v3/files/:id?alt=media       — binary download (production
 *                                               `downloadBytes` issues this)
 *   - GET /drive/v3/files/:id/export          — content export (e.g. Google Docs)
 *
 * Each `startMockDrive(port)` boots an isolated Bun.serve instance with its
 * own fixture map + request log so parallel Playwright workers can't bleed
 * state across each other. Lifecycle mirrors `mock-oidc.ts`.
 */

export interface MockDriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
  resourceKey?: string
  exportBody?: string
  /**
   * Binary download body for non-Google-Doc files (PDF etc.), **base64-encoded**.
   * The `?alt=media` route decodes it back to raw bytes — so this is the exact
   * byte content production `downloadBytes` materialises into `kernel.files`.
   */
  downloadBody?: string
  /**
   * Parent folder id. Synced-source reconciliation walks folder trees via
   * `q: "'<parentId>' in parents and trashed = false"`; this lets fixtures
   * model a folder structure (a file with `parentId` set to a folder fixture's
   * `id`, a subfolder with mimeType `application/vnd.google-apps.folder`).
   * Top-level fixtures may leave this undefined.
   */
  parentId?: string
  /**
   * The shared drive the file lives in, returned as `driveId` like Google does.
   * An organization connection reads only files whose `driveId` is one of its
   * chosen shared drives; leave it undefined for a file in someone's My Drive.
   */
  driveId?: string
}

export interface MockDriveRequest {
  method: string
  path: string
  query: Record<string, string>
  authorization: string | null
}

export interface MockDriveHandle {
  url: string
  port: number
  requestLog: MockDriveRequest[]
  addFixture: (file: MockDriveFile) => void
  resetFixtures: () => void
  resetRequestLog: () => void
  kill: () => Promise<void>
}

/**
 * Boot an isolated mock-Drive server. Pass `0` (the default) to let the OS
 * assign a free port — the returned handle's `url` / `port` reflect the actual
 * bound port, so callers never need to hunt for a free one.
 */
export async function startMockDrive(port = 0): Promise<MockDriveHandle> {
  const fixtures = new Map<string, MockDriveFile>()
  const requestLog: MockDriveRequest[] = []

  const app = new Hono()

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url)
    const query: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })
    requestLog.push({
      method: c.req.method,
      path: url.pathname,
      query,
      authorization: c.req.header("authorization") ?? null,
    })
    const auth = c.req.header("authorization") ?? ""
    if (!auth.toLowerCase().startsWith("bearer ") || auth.length < "bearer ".length + 1) {
      return c.json({ error: { message: "Unauthorized", code: 401 } }, 401)
    }
    return next()
  })

  app.get("/drive/v3/files", (c) => {
    const q = c.req.query("q") ?? ""
    const all = [...fixtures.values()]

    // Two query shapes the production adapter emits:
    //   - federated search: `name contains 'X'` or `fullText contains 'X'`
    //   - synced-source folder enumeration: `'<parentId>' in parents and trashed = false`
    //
    // The `q` filter is permissive: when neither clause matches, we return the
    // full fixture list so legacy "no filter" tests still work.
    const parentId = extractInParents(q)
    let files: MockDriveFile[]
    if (parentId !== null) {
      files = all.filter((f) => f.parentId === parentId)
    } else {
      const term = extractNameTerm(q).toLowerCase()
      files = term ? all.filter((f) => f.name.toLowerCase().includes(term)) : all
    }

    return c.json({
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime ?? new Date().toISOString(),
        webViewLink: f.webViewLink ?? `http://localhost:${port}/drive/v3/files/${f.id}`,
        resourceKey: f.resourceKey,
        ...(f.driveId ? { driveId: f.driveId } : {}),
      })),
      incompleteSearch: false,
    })
  })

  app.get("/drive/v3/files/:id", (c) => {
    const file = fixtures.get(c.req.param("id"))
    if (!file) return c.json({ error: { message: "Not Found", code: 404 } }, 404)

    // Binary download path. Production `downloadBytes` issues
    // `GET /files/{id}?alt=media`; serve the fixture's `downloadBody`
    // base64-DECODED into a real binary body with the fixture's mimeType so
    // the imported `kernel.files` row carries the true bytes + content type.
    if (c.req.query("alt") === "media") {
      if (file.downloadBody === undefined) {
        return c.json({ error: { message: "Not downloadable", code: 400 } }, 400)
      }
      return c.body(Buffer.from(file.downloadBody, "base64"), 200, {
        "Content-Type": file.mimeType,
      })
    }

    return c.json({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime ?? new Date().toISOString(),
      webViewLink: file.webViewLink ?? `http://localhost:${port}/drive/v3/files/${file.id}`,
      resourceKey: file.resourceKey,
      ...(file.driveId ? { driveId: file.driveId } : {}),
      // The production adapter's `fetchRemoteContent` gates downloads on
      // `metadata.capabilities.canDownload` (a real-Drive concept). Anything
      // with a `downloadBody` (or an `exportBody` for Google Docs export) is
      // considered fetchable by the mock so synced-source reconciliation can
      // pull text bodies into Knowledge documents.
      capabilities: {
        canDownload: file.downloadBody !== undefined || file.exportBody !== undefined,
      },
    })
  })

  app.get("/drive/v3/files/:id/export", (c) => {
    const file = fixtures.get(c.req.param("id"))
    if (!file) return c.json({ error: { message: "Not Found", code: 404 } }, 404)
    if (!file.exportBody && !file.downloadBody) {
      return c.json({ error: { message: "Not exportable", code: 400 } }, 400)
    }
    return c.text(file.exportBody ?? file.downloadBody ?? "", 200)
  })

  // Direct download path for binary files (drive-rest may use alt=media). Optional.
  app.get("/drive/v3/files/:id/download", (c) => {
    const file = fixtures.get(c.req.param("id"))
    if (!file) return c.json({ error: { message: "Not Found", code: 404 } }, 404)
    return c.text(file.downloadBody ?? "", 200)
  })

  const server = Bun.serve({ fetch: app.fetch, port })
  // Reflect the actually-bound port back into the closure so `webViewLink`
  // fallbacks (and the returned handle) carry the real port when `0` was passed.
  port = Number(server.port)

  return {
    url: `http://localhost:${port}`,
    port,
    requestLog,
    addFixture: (file) => {
      fixtures.set(file.id, file)
    },
    resetFixtures: () => fixtures.clear(),
    resetRequestLog: () => {
      requestLog.length = 0
    },
    kill: async () => {
      server.stop(true)
    },
  }
}

/**
 * Extract a search term from a Drive `q` clause like `name contains 'Foo'` or
 * `fullText contains 'Foo'` (the production adapter uses the latter).
 * Falls back to the raw query if no pattern is found.
 */
function extractNameTerm(q: string): string {
  const m = q.match(/(?:name|fullText)\s+contains\s+'([^']+)'/i)
  if (m) return m[1] ?? ""
  return q.trim()
}

/**
 * Extract the parent folder id from an `in parents` clause:
 *   "'1ABC-XYZ' in parents and trashed = false"
 * Returns null when no `in parents` clause is present.
 *
 * The route layer Zod regex restricts folderRef to `[A-Za-z0-9_-]{8,128}`, so
 * legitimate production payloads never contain quotes inside the parent id.
 * The adapter also defensively re-validates against the same pattern.
 */
function extractInParents(q: string): string | null {
  const m = q.match(/'([A-Za-z0-9_-]+)'\s+in\s+parents/i)
  return m ? (m[1] ?? null) : null
}
