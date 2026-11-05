// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  accountsAtPath,
  chooseUserinfoAccount,
  oauthManifestKnobErrors,
  resolveAuthorizeConfigParams,
} from "~/modules/apps/connections/oauth-manifest-knobs"
import { validateAppManifest } from "~/modules/apps/contract"

const CONFIG_ID = { config_id: { configKey: "loginConfigurationId", pattern: "^[0-9]{1,30}$" } }

describe("authorizeConfigParams", () => {
  it("reads the parameter from the app's config", () => {
    expect(
      resolveAuthorizeConfigParams(CONFIG_ID, { loginConfigurationId: " 1667793288 " }),
    ).toEqual({ ok: true, params: { config_id: "1667793288" } })
  })

  it("refuses a missing value", () => {
    expect(resolveAuthorizeConfigParams(CONFIG_ID, {})).toEqual({
      ok: false,
      configKey: "loginConfigurationId",
      reason: "missing",
    })
  })

  it("refuses a value that does not match the pattern (no injection into the URL)", () => {
    expect(
      resolveAuthorizeConfigParams(CONFIG_ID, { loginConfigurationId: "1&redirect_uri=x" }),
    ).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("matches the WHOLE value: an alternative in the pattern cannot widen it", () => {
    // As a bare RegExp, "^1|2$" matches any value that starts with 1.
    const loose = { config_id: { configKey: "k", pattern: "^1|2$" } }
    expect(resolveAuthorizeConfigParams(loose, { k: "1" })).toMatchObject({ ok: true })
    expect(resolveAuthorizeConfigParams(loose, { k: "1&prompt=none" })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
  })

  it("is empty without a declaration", () => {
    expect(resolveAuthorizeConfigParams(undefined, {})).toEqual({ ok: true, params: {} })
  })
})

describe("identifierFromUserinfoPath", () => {
  const body = {
    data: [
      { id: "17841400000000001", username: "brand_one" },
      { id: 17841400000000002, username: "brand_two" },
      { id: "17841400000000001", username: "brand_one" },
      { username: "no_id" },
    ],
  }

  it("reads every account at the path with its name, deduplicated", () => {
    expect(accountsAtPath(body, "data[].id", "username")).toEqual([
      { id: "17841400000000001", name: "brand_one" },
      { id: "17841400000000002", name: "brand_two" },
    ])
  })

  it("reads a plain nested path", () => {
    expect(accountsAtPath({ owner: { id: "42" } }, "owner.id")).toEqual([{ id: "42", name: null }])
  })

  it("connects the only account", () => {
    const one = accountsAtPath({ data: [body.data[0]] }, "data[].id", "username")
    expect(chooseUserinfoAccount(one)).toEqual({ kind: "one", account: one[0] })
  })

  it("never picks one of several silently: it asks", () => {
    const accounts = accountsAtPath(body, "data[].id", "username")
    expect(chooseUserinfoAccount(accounts)).toEqual({ kind: "choose", accounts })
  })

  it("takes the one the flow was started for, by id or by name", () => {
    const accounts = accountsAtPath(body, "data[].id", "username")
    expect(chooseUserinfoAccount(accounts, "17841400000000002")).toEqual({
      kind: "one",
      account: accounts[1],
    })
    expect(chooseUserinfoAccount(accounts, "@Brand_One")).toEqual({
      kind: "one",
      account: accounts[0],
    })
  })

  it("asks when the hint names none of the accounts", () => {
    const accounts = accountsAtPath(body, "data[].id", "username")
    expect(chooseUserinfoAccount(accounts, "someone_else").kind).toBe("choose")
  })

  it("reports no account", () => {
    expect(chooseUserinfoAccount(accountsAtPath({ data: [] }, "data[].id"))).toEqual({
      kind: "none",
    })
  })
})

describe("manifest rules", () => {
  const base = (conn: Record<string, unknown>, configKeys: unknown[] = []) => ({
    name: "demo",
    connections: {
      login: {
        type: "oauth2",
        authorizationUrl: "https://provider.example/authorize",
        tokenUrl: "https://provider.example/token",
        allowedDomains: ["provider.example"],
        ...conn,
      },
    },
    configKeys,
  })

  it("accepts a declared, anchored config parameter and an identifier path", () => {
    const m = base(
      {
        authorizeConfigParams: CONFIG_ID,
        userinfoUrl: "https://provider.example/me/accounts",
        identifierFromUserinfoPath: "data[].id",
        accountNameField: "username",
      },
      [{ key: "loginConfigurationId", type: "string" }],
    )
    expect(oauthManifestKnobErrors(m)).toEqual([])
    // The manifest schema knows both fields (no "additional property" refusal).
    const verdict = validateAppManifest({ ...m, version: "1.0.0" })
    expect(verdict.error ?? "").not.toContain("authorizeConfigParams")
    expect(verdict.error ?? "").not.toContain("identifierFromUserinfoPath")
  })

  it("refuses an undeclared key, an unanchored pattern and a kernel parameter", () => {
    const errors = oauthManifestKnobErrors(
      base({
        authorizeConfigParams: {
          redirect_uri: { configKey: "nowhere", pattern: "[0-9]+" },
        },
      }),
    )
    expect(errors).toEqual([
      'connections.login.authorizeConfigParams.redirect_uri: "redirect_uri" is an OAuth protocol parameter and cannot come from config',
      'connections.login.authorizeConfigParams.redirect_uri.configKey: "nowhere" must be declared in configKeys',
      "connections.login.authorizeConfigParams.redirect_uri.pattern: must be an anchored regular expression (^...$)",
    ])
  })

  it("refuses every OAuth/OIDC protocol parameter, not only the ones the kernel sets", () => {
    for (const param of ["response_mode", "nonce", "prompt", "code", "request_uri"]) {
      const errors = oauthManifestKnobErrors(
        base({ authorizeConfigParams: { [param]: { configKey: "k", pattern: "^[a-z]+$" } } }, [
          { key: "k", type: "string" },
        ]),
      )
      expect(errors).toEqual([
        `connections.login.authorizeConfigParams.${param}: "${param}" is an OAuth protocol parameter and cannot come from config`,
      ])
    }
  })

  it("is enforced when a manifest is validated", () => {
    const verdict = validateAppManifest({
      ...base({ authorizeConfigParams: { config_id: { configKey: "nowhere", pattern: "^1$" } } }),
      version: "1.0.0",
    })
    expect(verdict.success).toBe(false)
    expect(verdict.error).toContain('"nowhere" must be declared in configKeys')
  })

  it("refuses an identifier path without userinfoUrl or beside another identifier source", () => {
    const errors = oauthManifestKnobErrors(
      base({ identifierFromUserinfoPath: "data[]", identifierFromTokenField: "user_id" }),
    )
    expect(errors).toEqual([
      "connections.login.identifierFromUserinfoPath: needs userinfoUrl",
      "connections.login.identifierFromUserinfoPath: cannot be combined with identifierFromTokenField",
      "connections.login.identifierFromUserinfoPath: the last segment names the id field (e.g. data[].id)",
    ])
  })
})
