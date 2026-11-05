// SPDX-License-Identifier: FSL-1.1-ALv2
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto"
import * as argon2 from "argon2"

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password)
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Generate a numeric one-time code (default 6 digits) for passwordless email
 * login and TOTP step-up. Uses `crypto.randomInt` for a uniform, modulo-bias-free
 * distribution and zero-pads to the fixed width so every code is exactly `digits`
 * characters (e.g. "042317"). Low-entropy by design — callers MUST hash-store it
 * and cap verification attempts; never rely on the code alone for brute-force
 * resistance.
 */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits
  return randomInt(0, max).toString().padStart(digits, "0")
}

const AES_ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt a secret with AES-256-GCM, binding the ciphertext to a caller-supplied
 * context via additional authenticated data (AAD).
 *
 * The `context` is authenticated but not stored: decryption must supply the exact
 * same string or GCM tag verification fails. This prevents a ciphertext from being
 * moved across fields, columns, rows, or tenants — a mis-targeted UPDATE or a
 * backup/restore mixup that copies one row's ciphertext into another will fail to
 * decrypt instead of silently returning the wrong secret. Use a stable identifier
 * such as `${schema.table}:${orgId}:${field}`.
 */
export function encryptSecret(plaintext: string, key: string, context: string): string {
  const keyBytes = Buffer.from(key, "hex")
  if (keyBytes.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes (64 hex characters); got ${keyBytes.length} bytes`,
    )
  }
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(AES_ALGORITHM, keyBytes, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  cipher.setAAD(Buffer.from(context, "utf8"))
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`
}

/**
 * Decrypt a secret produced by {@link encryptSecret}. The `context` must match the
 * value passed at encryption time exactly, or GCM authentication fails and this
 * throws — the same failure mode as a tampered ciphertext or wrong key.
 */
export function decryptSecret(encoded: string, key: string, context: string): string {
  const keyBytes = Buffer.from(key, "hex")
  if (keyBytes.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes (64 hex characters); got ${keyBytes.length} bytes`,
    )
  }
  const parts = encoded.split(".")
  if (parts.length !== 3) throw new Error("Invalid ciphertext format")
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64, "base64")
  const authTag = Buffer.from(tagB64, "base64")
  const data = Buffer.from(dataB64, "base64")
  // Validate buffer lengths to prevent native errors leaking implementation details
  if (iv.length !== IV_LENGTH) throw new Error("Invalid ciphertext format")
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error("Invalid ciphertext format")
  const decipher = createDecipheriv(AES_ALGORITHM, keyBytes, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  })
  decipher.setAAD(Buffer.from(context, "utf8"))
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

/**
 * Encrypt bytes with AES-256-GCM under a raw 32-byte key, binding `context` as
 * AAD. The binary twin of {@link encryptSecret} (same algorithm, IV and tag
 * lengths), for `bytea` columns: the output is `iv || tag || ciphertext`.
 */
export function encryptBytes(plaintext: Uint8Array, key: Uint8Array, context: string): Buffer {
  if (key.byteLength !== 32) {
    throw new Error(`Encryption key must be exactly 32 bytes; got ${key.byteLength} bytes`)
  }
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  cipher.setAAD(Buffer.from(context, "utf8"))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

/**
 * Decrypt the output of {@link encryptBytes}. The `context` must match exactly,
 * or GCM authentication fails and this throws.
 */
export function decryptBytes(sealed: Uint8Array, key: Uint8Array, context: string): Buffer {
  if (key.byteLength !== 32) {
    throw new Error(`Encryption key must be exactly 32 bytes; got ${key.byteLength} bytes`)
  }
  if (sealed.byteLength < IV_LENGTH + AUTH_TAG_LENGTH) throw new Error("Invalid ciphertext format")
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const data = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAAD(Buffer.from(context, "utf8"))
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * Stable AAD context strings for {@link encryptSecret} / {@link decryptSecret}.
 *
 * Each constant identifies the logical column a ciphertext belongs to. The SAME
 * constant MUST be used at the encrypt and the decrypt site for a given value,
 * or GCM authentication fails. Using shared named constants (rather than inline
 * strings) guarantees the encrypt/decrypt sites — which often live in different
 * files — can never drift apart. Pre-launch: no ciphertext exists yet, so these
 * can be refined freely until the first customer data is written.
 */
export const CryptoContext = {
  /** app_mcp_manager connections `secrets_encrypted` (written by mcp-manager, read by mcp-client). */
  mcpConnectionSecrets: "app_mcp_manager.connections:secrets_encrypted",
  /** kernel.connected_accounts `access_token_encrypted`. */
  connectedAccountAccessToken: "kernel.connected_accounts:access_token_encrypted",
  /** kernel.connected_accounts `refresh_token_encrypted`. */
  connectedAccountRefreshToken: "kernel.connected_accounts:refresh_token_encrypted",
  /** kernel.connected_accounts `credentials_encrypted`. */
  connectedAccountCredentials: "kernel.connected_accounts:credentials_encrypted",
  /** kernel.oauth_providers `client_secret_encrypted`. */
  oauthProviderClientSecret: "kernel.oauth_providers:client_secret_encrypted",
  /** kernel.users `totp_secret` (persisted, confirmed TOTP). */
  totpSecret: "kernel.users:totp_secret",
  /** Pending TOTP setup secret held in Redis (`totp:setup:*`) before confirmation. */
  totpSetupSecret: "redis:totp_setup:secret",
  /** Per-org BYOK provider API keys (encrypted with the BYOK key). */
  byokApiKey: "kernel.org_settings:byok_api_key",
  /** Per-org Google OAuth client secret. */
  googleClientSecret: "kernel.org_settings:google_client_secret",
  /** Generic org-settings secret values stored in kernel.organizations.settings JSONB. */
  orgSettingsSecret: "kernel.organizations:settings_secret",
  /**
   * App-connection secrets mirrored into `kernel.apps.config` JSONB — the OAuth
   * client secret (`clientSecretConfigKey`) and the kernel-minted webhook secret
   * (`webhookSecretConfigKey`). Written by `connections/service.ts` (OAuth
   * callback + credential connect) and decrypted ONLY at the two `config_get`
   * bridges (webhooks/routes.ts verifier, sandbox rpc-bridge `ctx.config.get`)
   * before the plaintext secret is handed to the (sandboxed) consumer. Non-secret
   * config keys in the same JSONB are never encrypted/decrypted.
   */
  appConfigConnectionSecret: "kernel.apps:config_connection_secret",
  /**
   * kernel.mailbox_server_keys `wrapped_key`: a managed mailbox's data key.
   * Always used through {@link mailboxServerKeyContext}, which binds the org,
   * the account and the key version, so a wrapped key cannot be moved to
   * another mailbox.
   */
  mailboxServerKey: "kernel.mailbox_server_keys:wrapped_key",
} as const

/** The full AAD of one managed mailbox data key (see `CryptoContext.mailboxServerKey`). */
export function mailboxServerKeyContext(orgId: string, accountId: string, keyVersion: number) {
  return `${CryptoContext.mailboxServerKey}:${orgId}:${accountId}:${keyVersion}`
}
