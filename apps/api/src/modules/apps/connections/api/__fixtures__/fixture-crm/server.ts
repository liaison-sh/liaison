// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The fixture CRM as a real HTTP server (Bun.serve on 127.0.0.1), for tests
 * and for trying the API connector by hand:
 *
 *   FIXTURE_CRM_API_KEY=dev-key bun run apps/api/src/modules/apps/connections/api/__fixtures__/fixture-crm/server.ts
 *
 * listens on port 4010 (FIXTURE_CRM_PORT overrides) and serves `/v1/*`,
 * matching `fixture-crm.adapter.yaml`'s baseUrl. It takes the API key in the
 * `X-Api-Key` header: FIXTURE_CRM_API_KEY's value, or `fixture-crm-dev-key`
 * (FIXTURE_CRM_DEFAULT_API_KEY) when the variable is unset. A loopback http
 * baseUrl is only reachable from Liaison when the process making the call sets
 * LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true (development only): the CLI
 * for `api-connector test` and `config verify`, the API server otherwise.
 */
import { FIXTURE_CRM_DEFAULT_API_KEY, FIXTURE_CRM_DEFAULT_PORT } from "./data"
import { createFixtureCrmHandler, type FixtureCrmHandler } from "./handler"

export interface StartFixtureCrmOptions {
  /** 0 (default) picks a free port. */
  port?: number
  apiKey: string
  referenceDate?: Date
}

export interface FixtureCrm {
  port: number
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** `http://127.0.0.1:<port>/v1`, the adapter's baseUrl. */
  baseUrl: string
  handler: FixtureCrmHandler
  stop(): Promise<void>
}

export function startFixtureCrm(options: StartFixtureCrmOptions): FixtureCrm {
  const handler = createFixtureCrmHandler({
    apiKey: options.apiKey,
    referenceDate: options.referenceDate,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch: handler.handle,
  })
  const port = server.port
  if (port === undefined) throw new Error("fixture-crm: server has no port")
  const origin = `http://127.0.0.1:${port}`
  return {
    port,
    origin,
    baseUrl: `${origin}/v1`,
    handler,
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  const port = Number(process.env.FIXTURE_CRM_PORT ?? FIXTURE_CRM_DEFAULT_PORT)
  const apiKey = process.env.FIXTURE_CRM_API_KEY ?? FIXTURE_CRM_DEFAULT_API_KEY
  const crm = startFixtureCrm({ port, apiKey })
  console.log(`fixture CRM listening on ${crm.baseUrl} (header X-Api-Key)`)
}
