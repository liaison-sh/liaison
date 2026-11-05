// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts): job dispatch with run options,
// and a forwarding wrapper.
import { withPrivilegedDb } from "./db"

interface Ctx {
  get(key: "orgId"): string
  req: { query(key: string): string }
}
declare const app: { get(path: string, handler: (c: Ctx) => unknown): void }
declare function lookUp(name: string): { handler: (p: unknown, o?: object) => Promise<void> }
declare function track<T>(fn: () => T): T

/** A tool handler, reached by name from the job dispatch below. */
async function jobToolHandler(_params: unknown, ctx: { orgId: string }) {
  await withPrivilegedDb(ctx.orgId, "job-tool", async () => 1)
}
export const jobTool = { handler: jobToolHandler }

/** The job runner: the payload, plus run options that carry no org. */
export async function runJob(job: { name: string; data: unknown }, signal: AbortSignal) {
  const { handler } = lookUp(job.name)
  await handler(job.data, { signal })
}

/** Run options beside a value that is not a job payload: still untraced. */
async function plainToolHandler(_params: unknown, ctx: { orgId: string }) {
  await withPrivilegedDb(ctx.orgId, "plain-tool", async () => 1)
}
export const plainTool: { plainHandler(params: unknown, opts: object): Promise<void> } = {
  plainHandler: plainToolHandler,
}
export async function callPlain(params: unknown, signal: AbortSignal) {
  const { plainHandler } = plainTool
  await plainHandler(params, { signal })
}

/** Reached through `(...args) => inner(...args)`: traced to the wrapper's callers. */
async function forwardedInner(orgId: string) {
  return withPrivilegedDb(orgId, "forwarded", async () => 2)
}
export function forwardingWrapper(...args: Parameters<typeof forwardedInner>) {
  return track(() => forwardedInner(...args))
}
async function forwardedQuery(orgId: string) {
  return withPrivilegedDb(orgId, "forwarded-query", async () => 3)
}
export function forwardingQueryWrapper(...args: Parameters<typeof forwardedQuery>) {
  return track(() => forwardedQuery(...args))
}

app.get("/forwarded", (c) => forwardingWrapper(c.get("orgId")))
app.get("/forwarded-query", (c) => forwardingQueryWrapper(c.req.query("org")))
