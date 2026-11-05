// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts): a same-named local function,
// called with a request value, is not a caller of service.ts's loadThing.
interface Ctx {
  req: { query(key: string): string }
}
declare const app: { get(path: string, handler: (c: Ctx) => unknown): void }

function loadThing(orgId: string, id: string) {
  return `${orgId}:${id}`
}

app.get("/collision", (c) => loadThing(c.req.query("org"), "x"))
