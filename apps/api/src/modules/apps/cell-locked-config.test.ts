// SPDX-License-Identifier: FSL-1.1-ALv2
// The app config keys a managed cell owns (cell-locked-config.ts): the cell's
// Gmail push and Meta values win over a workspace's stored copy while the
// workspace runs on the cell's clients, and an admin cannot write them.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { checkAppConfigWriteForOrg } from "~/modules/apps/app-config"
import {
  CELL_CONFIG_LOCKED_CODE,
  cellConfigOverride,
  cellLockedConfigValue,
} from "~/modules/apps/cell-locked-config"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"
import { seedOrgRow } from "~/seed/factories/org/rows"

type CellVars = {
  GMAIL_OAUTH_CLIENT_ID?: string
  GMAIL_OAUTH_CLIENT_SECRET?: string
  GMAIL_PUBSUB_TOPIC?: string
  GMAIL_PUSH_AUDIENCE?: string
  GMAIL_PUSH_SERVICE_ACCOUNT?: string
  META_APP_ID?: string
  META_APP_SECRET?: string
  BASE_URL: string
}
const mutableEnv = env as unknown as CellVars
const saved = { ...mutableEnv }
const CELL: Omit<CellVars, "BASE_URL"> = {
  GMAIL_OAUTH_CLIENT_ID: "cell-google.apps.googleusercontent.com",
  GMAIL_OAUTH_CLIENT_SECRET: "cell-google-secret",
  GMAIL_PUBSUB_TOPIC: "projects/cell/topics/gmail",
  GMAIL_PUSH_AUDIENCE: "https://cell.example/webhooks/_cell/gmail-push",
  GMAIL_PUSH_SERVICE_ACCOUNT: "push@cell.iam.gserviceaccount.com",
  META_APP_ID: "cell-meta-id",
  META_APP_SECRET: "cell-meta-secret",
}

let orgId: string

beforeEach(async () => {
  Object.assign(mutableEnv, CELL)
  _setEdition("managed")
  orgId = randomUUID()
  await seedOrgRow({ id: orgId, name: "Cell config org", slug: `cell-config-${orgId}` })
})

afterEach(async () => {
  Object.assign(mutableEnv, saved)
  _setEdition(null)
  await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

describe("managed: the cell's values win", () => {
  it("Gmail push values, while the workspace is on the cell's Google client", async () => {
    for (const app of ["mail", "tickets"]) {
      expect(await cellLockedConfigValue(orgId, app, "gmailPushAudience")).toBe(
        CELL.GMAIL_PUSH_AUDIENCE as string,
      )
      expect(
        await cellConfigOverride(orgId, app, "gmailPushServiceAccount", "me@evil.example"),
      ).toBe(CELL.GMAIL_PUSH_SERVICE_ACCOUNT as string)
    }
    expect(await cellLockedConfigValue(orgId, "mail", "gmailPushTopic")).toBe(
      CELL.GMAIL_PUBSUB_TOPIC as string,
    )
  })

  it("a workspace on its own Google client keeps its own Gmail push values", async () => {
    await saveGoogleIntegrationConfig(orgId, { clientId: "own-id", clientSecret: "own-secret" })
    expect(await cellLockedConfigValue(orgId, "mail", "gmailPushAudience")).toBeNull()
    expect(await cellConfigOverride(orgId, "mail", "gmailPushAudience", "https://own")).toBe(
      undefined,
    )
  })

  it("the Meta callback is always the cell's; the Meta app secret while on the cell's Meta app", async () => {
    expect(await cellLockedConfigValue(orgId, "social", "cellMetaCallbackUrl")).toContain(
      "/webhooks/_cell/meta",
    )
    expect(await cellConfigOverride(orgId, "social", "cellMetaVerifyToken", "forged")).not.toBe(
      "forged",
    )
    expect(await cellConfigOverride(orgId, "social", "socialMetaAppSecret", "enc:own")).toBe(
      "cell-meta-secret",
    )
    await upsertConnectionOAuthClient({
      orgId,
      appName: "social",
      connectionName: "facebook",
      clientId: "own-meta-id",
      clientSecret: "own-meta-secret",
    })
    expect(await cellLockedConfigValue(orgId, "social", "socialMetaAppSecret")).toBeNull()
  })

  it("an admin write of a cell key is refused", () => {
    for (const [app, key] of [
      ["social", "cellMetaCallbackUrl"],
      ["mail", "gmailPushAudience"],
      ["tickets", "gmailPushServiceAccount"],
    ] as const) {
      const check = checkAppConfigWriteForOrg(orgId, app, key, "https://evil.example")
      expect(check.ok).toBe(false)
      expect(!check.ok && check.code).toBe(CELL_CONFIG_LOCKED_CODE)
    }
  })
})

describe("self-hosted", () => {
  it("nothing is locked", async () => {
    _setEdition("self_hosted")
    expect(await cellConfigOverride(orgId, "mail", "gmailPushAudience", "https://own")).toBe(
      undefined,
    )
    const check = checkAppConfigWriteForOrg(orgId, "mail", "gmailPushAudience", "x")
    expect(!check.ok && check.code).not.toBe(CELL_CONFIG_LOCKED_CODE)
  })
})
