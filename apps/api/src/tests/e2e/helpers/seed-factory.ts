// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The api end-to-end scenarios' client for the seed engine: `POST
// /api/_test/seed` runs one named factory (test-support/seed/factories.ts) in
// the server under test, through the same product services every seed tier
// uses. A scenario runs in another process from that server, so a row the
// server must recognise is asked for here, never written by raw SQL.
import { api, type WorkerEnv } from "@liaison/test-helpers"

/** Run the factory `name` on `orgId`; its typed result, or a thrown error naming the factory. */
export async function seedFactory<T = unknown>(
  env: Pick<WorkerEnv, "serverUrl">,
  orgId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await api(env.serverUrl, "/api/_test/seed", {
    method: "POST",
    body: { factory: name, orgId, args },
  })
  if (res.status !== 200) {
    throw new Error(`seed ${name} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return (res.body as { data: T }).data
}
