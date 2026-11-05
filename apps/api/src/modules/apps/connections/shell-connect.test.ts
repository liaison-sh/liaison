// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { redis } from "~/lib/redis"
import {
  discardOAuthState,
  handleOAuthCallback,
  OAuthBrowserMismatchError,
  receiveOAuthCallback,
  redeemShellConnect,
} from "~/modules/apps/connections/service"
import {
  ConnectHandoffRefusedError,
  claimConnectHandoff,
  parkConnectHandoff,
  parseConnectClient,
} from "~/modules/apps/connections/shell-connect"

const verifierAndChallenge = () => {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

const RETURN_STATE = "app-own-state-0123456789"

async function seedState(extra: Record<string, unknown>): Promise<string> {
  const state = `shell-test-${crypto.randomUUID()}`
  await redis.set(
    `oauth:state:${state}`,
    JSON.stringify({
      orgId: "org-1",
      userId: "user-1",
      appName: "mail",
      connectionName: "gmail",
      codeVerifier: "provider-pkce-verifier",
      tokenUrl: "https://example.invalid/token",
      ...extra,
    }),
    "EX",
    60,
  )
  return state
}

describe("parseConnectClient", () => {
  const { challenge } = verifierAndChallenge()
  const shellBody = {
    client: "desktop",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: RETURN_STATE,
  }

  it("is the browser flow when no shell parameter is present", () => {
    expect(parseConnectClient({ mode: "personal" }, true)).toEqual({ kind: "browser" })
    expect(parseConnectClient(undefined, false)).toEqual({ kind: "browser" })
  })

  it("binds a shell flow from a shell origin", () => {
    expect(parseConnectClient(shellBody, true)).toEqual({
      kind: "shell",
      flow: { codeChallenge: challenge, returnState: RETURN_STATE },
    })
    expect(parseConnectClient({ ...shellBody, client: "mobile" }, true).kind).toBe("shell")
  })

  it("refuses a shell flow a browser tab asks for: its cookie binding stays", () => {
    expect(parseConnectClient(shellBody, false).kind).toBe("invalid")
  })

  it("refuses a partial or downgraded shell request rather than dropping to the browser flow", () => {
    for (const body of [
      { ...shellBody, code_challenge_method: "plain" },
      { ...shellBody, code_challenge: "short" },
      { ...shellBody, client: "cli" },
      { ...shellBody, client: 1 },
      { ...shellBody, state: undefined },
      { client: "desktop" },
    ]) {
      expect(parseConnectClient(body, true).kind).toBe("invalid")
    }
  })
})

describe("the shell connect handoff", () => {
  it("parks a shell flow's callback without completing it, and never checks a cookie", async () => {
    const { challenge } = verifierAndChallenge()
    const state = await seedState({
      browserBound: false,
      shell: { codeChallenge: challenge, returnState: RETURN_STATE },
    })
    const outcome = await receiveOAuthCallback("provider-code", state, { shop: undefined })
    expect(outcome.kind).toBe("shell-handoff")
    if (outcome.kind !== "shell-handoff") return
    expect(outcome.returnState).toBe(RETURN_STATE)
    expect(outcome.code).toMatch(/^[0-9a-f]{64}$/)
    // The state is consumed: the callback cannot be replayed.
    expect(await redis.get(`oauth:state:${state}`)).toBeNull()
    await expect(receiveOAuthCallback("provider-code", state)).rejects.toThrow(/Invalid or expired/)
  })

  it("refuses a parked code redeemed without the shell's verifier, and burns it", async () => {
    const { verifier, challenge } = verifierAndChallenge()
    const code = await parkConnectHandoff({
      record: { orgId: "org-1", userId: "user-1" },
      providerCode: "p",
      callbackParams: {},
      codeChallenge: challenge,
    })
    for (const codeVerifier of [undefined, "x".repeat(43), verifierAndChallenge().verifier]) {
      const again = await parkConnectHandoff({
        record: { orgId: "org-1", userId: "user-1" },
        providerCode: "p",
        callbackParams: {},
        codeChallenge: challenge,
      })
      await expect(
        claimConnectHandoff({ code: again, codeVerifier, orgId: "org-1", userId: "user-1" }),
      ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
      // Burned by the refused attempt: the right verifier cannot use it either.
      await expect(
        claimConnectHandoff({
          code: again,
          codeVerifier: verifier,
          orgId: "org-1",
          userId: "user-1",
        }),
      ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
    }
    // The untouched code is released to its verifier exactly once.
    const claimed = await claimConnectHandoff({
      code,
      codeVerifier: verifier,
      orgId: "org-1",
      userId: "user-1",
    })
    expect(claimed.providerCode).toBe("p")
    await expect(
      claimConnectHandoff({ code, codeVerifier: verifier, orgId: "org-1", userId: "user-1" }),
    ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
  })

  it("refuses a parked code redeemed by another user or org, even with the verifier", async () => {
    const { verifier, challenge } = verifierAndChallenge()
    for (const who of [
      { orgId: "org-1", userId: "user-2" },
      { orgId: "org-2", userId: "user-1" },
    ]) {
      const code = await parkConnectHandoff({
        record: { orgId: "org-1", userId: "user-1" },
        providerCode: "p",
        callbackParams: {},
        codeChallenge: challenge,
      })
      await expect(
        claimConnectHandoff({ code, codeVerifier: verifier, ...who }),
      ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
    }
  })

  it("refuses a code that is not one, before touching the store", async () => {
    await expect(
      redeemShellConnect({ code: "../x", codeVerifier: "v", orgId: "o", userId: "u" }),
    ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
    await expect(
      redeemShellConnect({ code: 42, codeVerifier: "v", orgId: "o", userId: "u" }),
    ).rejects.toBeInstanceOf(ConnectHandoffRefusedError)
  })

  it("a provider error on a shell flow is reported to the shell, and consumes the state", async () => {
    const { challenge } = verifierAndChallenge()
    const state = await seedState({
      shell: { codeChallenge: challenge, returnState: RETURN_STATE },
    })
    expect(await discardOAuthState(state)).toEqual({
      codeChallenge: challenge,
      returnState: RETURN_STATE,
    })
    expect(await redis.get(`oauth:state:${state}`)).toBeNull()
    const browserState = await seedState({ browserBound: true })
    expect(await discardOAuthState(browserState)).toBeNull()
  })
})

describe("the browser flow is unchanged", () => {
  it("still refuses a browser-bound callback without its cookie", async () => {
    const state = await seedState({ browserBound: true })
    await expect(handleOAuthCallback("code", state, undefined, undefined)).rejects.toBeInstanceOf(
      OAuthBrowserMismatchError,
    )
  })

  it("never treats a browser-bound state as a shell flow", async () => {
    // A state record with a malformed shell field is a browser flow, bound as before.
    const state = await seedState({ browserBound: true, shell: { codeChallenge: "nope" } })
    await expect(receiveOAuthCallback("code", state)).rejects.toBeInstanceOf(
      OAuthBrowserMismatchError,
    )
  })
})
