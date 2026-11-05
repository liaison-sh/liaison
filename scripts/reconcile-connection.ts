// SPDX-License-Identifier: FSL-1.1-ALv2
//
// reconcile-connection.ts — ops CLI to re-drive an app connection's post-connect
// initialization WITHOUT a browser re-OAuth.
//
// Why this exists: an app's `onConnectionEstablished` handler (which writes the
// app's own metadata rows and registers upstream provider webhooks) runs off the
// one-shot `kernel/connected_account:create` event. That event is a best-effort
// live pub/sub delivery (outbox Phase 2b) — if the app's subscriber isn't
// registered at the instant it publishes (a boot / redeploy race), it is lost
// and never replays. The connection then looks "active" on the kernel side while
// the app is silently uninitialised (e.g. Shopify: "install_metadata row not
// found", empty Home tab, no webhooks). This CLI re-queues that connect event so
// the RUNNING server's outbox worker re-runs the handler idempotently — the same
// operation the UI's "Reconcile" button and the `POST /connections/:id/reconcile`
// route perform, and the same event `handleOAuthCallback` emits on first connect.
//
// It talks straight to the database (no auth plumbing) and relies on the running
// app process to dispatch. Run it where DATABASE_URL reaches the DB — typically
// on the node, e.g.
//   docker exec -e DATABASE_URL=... liaison-app-1 bun run scripts/reconcile-connection.ts --app shopify
//
// Usage:
//   bun run scripts/reconcile-connection.ts --list                 # show connections
//   bun run scripts/reconcile-connection.ts --connection <id>      # one connection
//   bun run scripts/reconcile-connection.ts --app <name> [--org <id>]
//   bun run scripts/reconcile-connection.ts --all                  # every active connection
//
// Env:
//   DATABASE_URL  (required)
//   BASE_URL / PUBLIC_BASE_URL  public origin used as kernelPublicBaseUrl so apps
//                 can register webhooks back to /webhooks/... (default localhost).
import postgres from "postgres"
import {
  buildConnectedAccountCreateEvent,
  type ConnectedAccountRow,
} from "../apps/api/src/modules/apps/connections/reconcile-event"

const argv = Bun.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const DB_URL = process.env.DATABASE_URL
if (!DB_URL) {
  console.error("DATABASE_URL is required.")
  process.exit(1)
}
const baseUrl = process.env.BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"

interface Row extends ConnectedAccountRow {
  orgId: string
  status: string
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {} })

async function loadRows(): Promise<Row[]> {
  const connectionId = flag("connection")
  const app = flag("app")
  const org = flag("org")
  const rows = await sql<Row[]>`
    SELECT id, org_id AS "orgId", app_name AS "appName", connection_name AS "connectionName",
           owner_type AS "ownerType", owner_id AS "ownerId", provider_type AS "providerType",
           identifier, status
    FROM kernel.connected_accounts
    WHERE 1 = 1
      ${connectionId ? sql`AND id = ${connectionId}` : sql``}
      ${app ? sql`AND app_name = ${app}` : sql``}
      ${org ? sql`AND org_id = ${org}` : sql``}
    ORDER BY app_name, connection_name
  `
  return rows
}

async function main(): Promise<void> {
  const rows = await loadRows()

  if (has("list")) {
    if (rows.length === 0) console.log("No connections match.")
    for (const r of rows) {
      console.log(
        `${r.status === "active" ? "●" : "○"} ${r.id}  ${r.appName}/${r.connectionName}  ${r.identifier}  [${r.status}]  org=${r.orgId}`,
      )
    }
    return
  }

  const scoped = flag("connection") || flag("app") || has("all")
  if (!scoped) {
    console.error(
      "Specify a target: --connection <id>, --app <name> [--org <id>], --all, or --list.",
    )
    process.exit(1)
  }

  const active = rows.filter((r) => r.status === "active")
  const skipped = rows.filter((r) => r.status !== "active")
  for (const r of skipped) {
    console.warn(`skip ${r.id} (${r.appName}/${r.connectionName}) — status=${r.status}, not active`)
  }
  if (active.length === 0) {
    console.error("No ACTIVE connections to reconcile.")
    process.exit(1)
  }

  for (const r of active) {
    const event = buildConnectedAccountCreateEvent(r, r.orgId, null, baseUrl)
    await sql`
      INSERT INTO kernel.pending_events (org_id, payload)
      VALUES (${r.orgId}, ${sql.json(event)})
    `
    console.log(`queued reconcile → ${r.appName}/${r.connectionName}  ${r.identifier}  (${r.id})`)
  }

  console.log(
    `\nQueued ${active.length} reconcile event(s). The running server's outbox worker will re-run ` +
      `each app's onConnectionEstablished within ~1s (writes metadata + registers webhooks). ` +
      `Verify via the app's tables (e.g. app_shopify.install_metadata / webhook subscriptions).`,
  )
}

try {
  await main()
} finally {
  await sql.end({ timeout: 5 })
}
