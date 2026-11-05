// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts).
import { fromQuery, loadThing, viaDeps } from "./service"

interface Ctx {
  get(key: "orgId"): string
  req: { query(key: string): string }
}
declare const app: { get(path: string, handler: (c: Ctx) => unknown): void }

app.get("/thing", (c) => loadThing(c.get("orgId"), "t1"))
app.get("/other", (c) => viaDeps(c.get("orgId")))
app.get("/query", (c) => fromQuery(c.req.query("org")))
