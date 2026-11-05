// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11c: ENCRYPTION_KEY and BYOK_ENCRYPTION_KEY can be rotated without losing
// what they protect. Changing the key alone makes every stored secret
// unreadable (the first test says so); `liaison keys rotate` re-encrypts them
// under the new key first, with the same algorithm and the same per-field
// context, in one transaction, and a second run changes nothing.
//
// Seeded with random old and new keys, scoped to one test org, so the run
// never touches another test's rows in this namespace's database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  COLUMNS,
  JSON_CONTEXTS,
  looksEncrypted,
  NOT_AT_REST,
  rotateEncryptionKey,
  runKeysRotateCli,
} from "~/cli/keys-rotate"
import { sql } from "~/db"
import { CryptoContext, decryptSecret, encryptSecret, mailboxServerKeyContext } from "~/lib/crypto"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const key = () => randomBytes(32).toString("hex")
const OLD = key()
const NEW = key()
const OLD_BYOK = key()
const NEW_BYOK = key()

let admin: minimal.Person
let accountId = ""
let appRowId = ""
const mailboxAccountId = crypto.randomUUID()

const PLAIN = {
  totp: "JBSWY3DPEHPK3PXP",
  access: "ya29.access-token",
  refresh: "1//refresh-token",
  google: "google-client-secret",
  orgSetting: "an-app-setting-secret",
  userSetting: "a-user-app-setting-secret",
  appConfig: "whsec_app_webhook_secret",
  byok: "sk-ant-byok-key",
  mailboxKey: "ab".repeat(32),
}

async function stored() {
  const [user] = await sql<{ totp_secret: string; settings: Record<string, any> }[]>`
    SELECT totp_secret, settings FROM kernel.users WHERE id = ${admin.id}`
  const [account] = await sql<{ access: string; refresh: string }[]>`
    SELECT access_token_encrypted AS access, refresh_token_encrypted AS refresh
    FROM kernel.connected_accounts WHERE id = ${accountId}`
  const [org] = await sql<{ settings: Record<string, any> }[]>`
    SELECT settings FROM kernel.organizations WHERE id = ${admin.orgId}`
  const [appRow] = await sql<{ config: Record<string, any> }[]>`
    SELECT config FROM kernel.apps WHERE id = ${appRowId}`
  const [mailboxKey] = await sql<{ wrapped_key: string }[]>`
    SELECT wrapped_key FROM kernel.mailbox_server_keys WHERE account_id = ${mailboxAccountId}`
  return {
    mailboxKey: mailboxKey!.wrapped_key,
    totp: user!.totp_secret,
    userSetting: user!.settings.keysRotateTest.token as string,
    access: account!.access,
    refresh: account!.refresh,
    google: org!.settings.integrations.google.clientSecretEncrypted as string,
    orgSetting: org!.settings.keysRotateTest.token as string,
    plainSetting: org!.settings.keysRotateTest.note as string,
    byok: org!.settings.providerKeys.anthropic.encrypted as string,
    appConfig: appRow!.config.webhookSecret as string,
    plainConfig: appRow!.config.mode as string,
  }
}

function opens(value: string, k: string, context: string): string | null {
  try {
    return decryptSecret(value, k, context)
  } catch {
    return null
  }
}

beforeAll(async () => {
  await acquireTestLock()
  admin = await minimal.orgAdmin((await createTestOrg()).id)
  await sql`UPDATE kernel.users
    SET totp_secret = ${encryptSecret(PLAIN.totp, OLD, CryptoContext.totpSecret)},
      settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({
        // A per-person app setting with an encrypted schema path (lib/settings.ts).
        keysRotateTest: {
          token: encryptSecret(PLAIN.userSetting, OLD, CryptoContext.orgSettingsSecret),
        },
      })}::jsonb
    WHERE id = ${admin.id}`
  const [acct] = await sql<{ id: string }[]>`
    INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by,
       access_token_encrypted, refresh_token_encrypted)
    VALUES (${admin.orgId}, 'keys-rotate-test', 'google', 'org', 'oauth2', ${`acct-${admin.orgId}`},
      ${admin.id},
      ${encryptSecret(PLAIN.access, OLD, CryptoContext.connectedAccountAccessToken)},
      ${encryptSecret(PLAIN.refresh, OLD, CryptoContext.connectedAccountRefreshToken)})
    RETURNING id`
  accountId = acct!.id
  const settings = {
    integrations: {
      google: {
        clientId: "client-id.apps.googleusercontent.com",
        clientSecretEncrypted: encryptSecret(PLAIN.google, OLD, CryptoContext.googleClientSecret),
      },
    },
    keysRotateTest: {
      token: encryptSecret(PLAIN.orgSetting, OLD, CryptoContext.orgSettingsSecret),
      note: "a plain value stays as it is",
    },
    providerKeys: {
      anthropic: {
        encrypted: encryptSecret(PLAIN.byok, OLD_BYOK, CryptoContext.byokApiKey),
        maskedHint: "yok-key",
      },
    },
  }
  await sql`UPDATE kernel.organizations
    SET settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(settings)}::jsonb
    WHERE id = ${admin.orgId}`
  const [appRow] = await sql<{ id: string }[]>`
    INSERT INTO kernel.apps (org_id, name, version, config)
    VALUES (${admin.orgId}, 'keys-rotate-test', '0.0.1', ${JSON.stringify({
      webhookSecret: encryptSecret(PLAIN.appConfig, OLD, CryptoContext.appConfigConnectionSecret),
      mode: "live",
    })}::jsonb)
    RETURNING id`
  appRowId = appRow!.id
  // A server-managed mailbox data key: its AAD is bound to its row.
  await sql`INSERT INTO kernel.mailbox_server_keys (org_id, account_id, key_version, wrapped_key)
    VALUES (${admin.orgId}, ${mailboxAccountId}, 1, ${encryptSecret(
      PLAIN.mailboxKey,
      OLD,
      mailboxServerKeyContext(admin.orgId, mailboxAccountId, 1),
    )})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.mailbox_server_keys WHERE account_id = ${mailboxAccountId}`
  await sql`DELETE FROM kernel.apps WHERE id = ${appRowId}`
  await sql`DELETE FROM kernel.connected_accounts WHERE id = ${accountId}`
  await releaseTestLock()
})

const only = () => [admin.orgId]

describe("liaison keys rotate", () => {
  it("is needed: a new key alone opens none of the stored secrets", async () => {
    const s = await stored()
    expect(opens(s.totp, NEW, CryptoContext.totpSecret)).toBeNull()
    expect(opens(s.access, NEW, CryptoContext.connectedAccountAccessToken)).toBeNull()
    expect(opens(s.google, NEW, CryptoContext.googleClientSecret)).toBeNull()
  })

  it("a dry run reports what it would re-encrypt and changes nothing", async () => {
    const before = await stored()
    const report = await rotateEncryptionKey({
      family: "encryption",
      fromKey: OLD,
      toKey: NEW,
      execute: false,
      onlyOrgIds: only(),
    })
    expect(report.executed).toBe(false)
    const by = Object.fromEntries(report.targets.map((t) => [t.target, t]))
    expect(by["kernel.users.totp_secret"]?.rekeyed).toBe(1)
    expect(by["kernel.connected_accounts.access_token_encrypted"]?.rekeyed).toBe(1)
    expect(by["kernel.connected_accounts.refresh_token_encrypted"]?.rekeyed).toBe(1)
    // google client secret + the app setting; the BYOK value is another family's.
    expect(by["kernel.organizations.settings"]?.rekeyed).toBe(2)
    // The BYOK value (under providerKeys) is the other family's: neither
    // re-keyed nor counted.
    expect(by["kernel.organizations.settings"]?.undecryptable).toBe(0)
    expect(report.undecryptable).toBe(0)
    expect(by["kernel.apps.config"]?.rekeyed).toBe(1)
    expect(await stored()).toEqual(before)
  })

  it("refuses while a value opens with neither key (a wrong old key), and changes nothing", async () => {
    const before = await stored()
    await expect(
      rotateEncryptionKey({
        family: "encryption",
        fromKey: key(),
        toKey: NEW,
        execute: true,
        onlyOrgIds: only(),
      }),
    ).rejects.toThrow(/open with neither key/)
    expect(await stored()).toEqual(before)
  })

  it("re-encrypts every secret under the new key with its own context, and leaves the rest", async () => {
    const report = await rotateEncryptionKey({
      family: "encryption",
      fromKey: OLD,
      toKey: NEW,
      execute: true,
      onlyOrgIds: only(),
    })
    expect(report.executed).toBe(true)
    const s = await stored()
    expect(opens(s.totp, NEW, CryptoContext.totpSecret)).toBe(PLAIN.totp)
    expect(opens(s.access, NEW, CryptoContext.connectedAccountAccessToken)).toBe(PLAIN.access)
    expect(opens(s.refresh, NEW, CryptoContext.connectedAccountRefreshToken)).toBe(PLAIN.refresh)
    expect(opens(s.google, NEW, CryptoContext.googleClientSecret)).toBe(PLAIN.google)
    expect(opens(s.orgSetting, NEW, CryptoContext.orgSettingsSecret)).toBe(PLAIN.orgSetting)
    expect(opens(s.userSetting, NEW, CryptoContext.orgSettingsSecret)).toBe(PLAIN.userSetting)
    expect(opens(s.appConfig, NEW, CryptoContext.appConfigConnectionSecret)).toBe(PLAIN.appConfig)
    const mailboxContext = mailboxServerKeyContext(admin.orgId, mailboxAccountId, 1)
    expect(opens(s.mailboxKey, NEW, mailboxContext)).toBe(PLAIN.mailboxKey)
    // Still bound to its own mailbox: another account's context does not open it.
    expect(
      opens(s.mailboxKey, NEW, mailboxServerKeyContext(admin.orgId, crypto.randomUUID(), 1)),
    ).toBeNull()
    expect(opens(s.totp, OLD, CryptoContext.totpSecret)).toBeNull()
    // The context still binds: a value never opens under another field's context.
    expect(opens(s.access, NEW, CryptoContext.connectedAccountRefreshToken)).toBeNull()
    expect(s.plainSetting).toBe("a plain value stays as it is")
    expect(s.plainConfig).toBe("live")
    // The BYOK key's value is not this family's: untouched, still under its own key.
    expect(opens(s.byok, OLD_BYOK, CryptoContext.byokApiKey)).toBe(PLAIN.byok)
  })

  it("a second run finds everything current and changes nothing", async () => {
    const before = await stored()
    const report = await rotateEncryptionKey({
      family: "encryption",
      fromKey: OLD,
      toKey: NEW,
      execute: true,
      onlyOrgIds: only(),
    })
    expect(report.targets.reduce((n, t) => n + t.rekeyed, 0)).toBe(0)
    expect(report.targets.find((t) => t.target === "kernel.users.totp_secret")?.current).toBe(1)
    expect(await stored()).toEqual(before)
  })

  it("rotates the BYOK key's values on their own", async () => {
    const report = await rotateEncryptionKey({
      family: "byok",
      fromKey: OLD_BYOK,
      toKey: NEW_BYOK,
      execute: true,
      onlyOrgIds: only(),
    })
    expect(report.targets.find((t) => t.target === "kernel.organizations.settings")?.rekeyed).toBe(
      1,
    )
    const s = await stored()
    expect(opens(s.byok, NEW_BYOK, CryptoContext.byokApiKey)).toBe(PLAIN.byok)
    // And left the ENCRYPTION_KEY family's values alone.
    expect(opens(s.google, NEW, CryptoContext.googleClientSecret)).toBe(PLAIN.google)
  })

  it("knows where every encrypted field lives", () => {
    const handled = new Set([
      ...COLUMNS.map((c) => c.context),
      ...JSON_CONTEXTS.encryption,
      ...JSON_CONTEXTS.byok,
      ...Object.keys(NOT_AT_REST),
    ])
    for (const context of Object.values(CryptoContext))
      expect(handled.has(context), context).toBe(true)
  })

  it("recognises encryptSecret's output and nothing shorter", () => {
    expect(looksEncrypted(encryptSecret("x", OLD, "ctx"))).toBe(true)
    expect(looksEncrypted(encryptSecret("", OLD, "ctx"))).toBe(true)
    expect(looksEncrypted("live")).toBe(false)
    expect(looksEncrypted("a.b.c")).toBe(false)
  })
})

describe("the CLI", () => {
  it("reads the keys from the named variables and refuses the same key twice", async () => {
    const same = await runKeysRotateCli(
      ["--family", "encryption", "--from-env", "K_OLD", "--to-env", "K_NEW"],
      { K_OLD: OLD, K_NEW: OLD },
    )
    expect(same.exitCode).toBe(1)
    expect(same.message).toMatch(/new key is the old key/)
    const bad = await runKeysRotateCli(
      ["--family", "encryption", "--from-env", "K_OLD", "--to-env", "K_NEW"],
      { K_OLD: OLD, K_NEW: "not-hex" },
    )
    expect(bad.exitCode).toBe(1)
    expect((await runKeysRotateCli(["--family", "nope"])).exitCode).toBe(2)
    expect((await runKeysRotateCli(["--family", "byok"])).exitCode).toBe(2)
  })
})
