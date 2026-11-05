// SPDX-License-Identifier: FSL-1.1-ALv2
import type postgres from "postgres"
import { api } from "./http"

interface BootstrapResult {
  accessToken: string
  userId: string
  orgId: string
}

interface CreateUserOpts {
  email?: string
  password?: string
  name?: string
  scopes?: string[]
  dimensions?: Record<string, string[]>
}

interface CreatedUser {
  id: string
  email: string
  token: string
  name: string
}

interface BootstrapOpts {
  email?: string
  password?: string
  name?: string
  /**
   * The instance is already bootstrapped with this admin (a shared e2e lane
   * registered it and snapshotted the result): sign in instead of registering.
   */
  existing?: boolean
}

export async function bootstrap(serverUrl: string, opts?: BootstrapOpts): Promise<BootstrapResult> {
  const email = opts?.email ?? "admin@e2e.test"
  const password = opts?.password ?? "SecurePass1!"
  const name = opts?.name ?? "E2E Admin"
  if (opts?.existing) {
    const { accessToken } = await login(serverUrl, email, password)
    const me = await api(serverUrl, "/api/users/me", { token: accessToken })
    if (me.status !== 200) {
      throw new Error(`Bootstrap /api/users/me failed: ${me.status} ${JSON.stringify(me.body)}`)
    }
    return { accessToken, userId: me.body.data.id, orgId: me.body.data.orgId }
  }
  const res = await api(serverUrl, "/api/auth/register", {
    body: { email, password, name },
  })
  if (res.status !== 200) {
    throw new Error(`Bootstrap failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const { accessToken } = res.body.data
  const me = await api(serverUrl, "/api/users/me", { token: accessToken })
  if (me.status !== 200) {
    throw new Error(`Bootstrap /api/users/me failed: ${me.status} ${JSON.stringify(me.body)}`)
  }

  // Set rate limit high for E2E — the default org setting (100/min)
  // overrides the env-var limit when org settings are merged via PATCH
  const orgUpdate = await api(serverUrl, "/api/org", {
    token: accessToken,
    method: "PATCH",
    body: { settings: { rateLimitPerMinute: 10000 } },
  })
  if (orgUpdate.status !== 200) {
    throw new Error(
      `Bootstrap /api/org failed: ${orgUpdate.status} ${JSON.stringify(orgUpdate.body)}`,
    )
  }

  return { accessToken, userId: me.body.data.id, orgId: me.body.data.orgId }
}

export async function login(
  serverUrl: string,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string } & Record<string, any>> {
  const res = await api(serverUrl, "/api/auth/login", { body: { email, password } })
  if (res.status !== 200) {
    throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.data
}

export async function createUserWithScopes(
  serverUrl: string,
  db: ReturnType<typeof postgres>,
  adminToken: string,
  orgId: string,
  opts: CreateUserOpts & { schemaPrefix?: string },
): Promise<CreatedUser> {
  const email =
    opts.email ?? `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`
  const password = opts.password ?? "Pass1234!"
  const name = opts.name ?? email.split("@")[0]
  const scopes = opts.scopes ?? ["kernel:threads:read", "kernel:threads:write"]

  // Schema-prefixed queries use db.unsafe() so the schema name can be interpolated.
  // For worker isolation: `schemaPrefix` is "w{N}_", so we target "w{N}_kernel".
  // For non-worker runs: `schemaPrefix` is undefined/empty, so we target "kernel".
  const ks = opts.schemaPrefix ? `"${opts.schemaPrefix}kernel"` : "kernel"

  // Create role with scopes (requires superuser DB)
  const [role] = await db.unsafe(
    `INSERT INTO ${ks}.roles (org_id, name, description)
     VALUES ($1, $2, 'E2E test role') RETURNING id`,
    [orgId, `e2e-role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  )

  for (const scope of scopes) {
    await db.unsafe(`INSERT INTO ${ks}.role_scope_grants (role_id, scope) VALUES ($1, $2)`, [
      role.id,
      scope,
    ])
  }

  if (opts.dimensions) {
    for (const [key, values] of Object.entries(opts.dimensions)) {
      // `to_jsonb($3::text[])` is load-bearing: postgres.js serializes a
      // stringified array (even under a ::jsonb cast) as a jsonb STRING scalar
      // ("[\"x\"]", jsonb_typeof 'string'), and every consumer that
      // jsonb_array_elements_text()s the column (eligibleApproversWithDimension)
      // dies with "cannot extract elements from a scalar". Passing the values
      // as a real text[] and converting in SQL yields a true jsonb array.
      // Latent until the first e2e exercised a dimension-constrained approval
      // (2026-08-06).
      await db.unsafe(
        `INSERT INTO ${ks}.role_dimension_grants (role_id, dimension_key, dimension_values)
         VALUES ($1, $2, to_jsonb($3::text[]))`,
        [role.id, key, `{${values.map((v) => `"${v}"`).join(",")}}`],
      )
    }
  }

  // Invite via API
  const inviteRes = await api(serverUrl, "/api/admin/invites", {
    token: adminToken,
    body: { email, roleId: role.id },
  })
  if (inviteRes.status !== 200 && inviteRes.status !== 201) {
    throw new Error(`Invite failed: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`)
  }

  // Register via API
  const regRes = await api(serverUrl, "/api/auth/register", {
    body: { inviteToken: inviteRes.body.data.inviteToken, password, name },
  })
  if (regRes.status !== 200) {
    throw new Error(`Register failed: ${regRes.status} ${JSON.stringify(regRes.body)}`)
  }

  const me = await api(serverUrl, "/api/users/me", { token: regRes.body.data.accessToken })

  return {
    id: me.body.data.id,
    email,
    token: regRes.body.data.accessToken,
    name,
  }
}
