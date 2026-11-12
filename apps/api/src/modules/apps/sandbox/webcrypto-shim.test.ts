// SPDX-License-Identifier: FSL-1.1-ALv2
// WebCrypto in the QuickJS sandbox (webcrypto-shim.ts): run in a hardened pool
// slot (no typed arrays), every answer equals node:crypto's, and the
// @liaison/app-sdk/bytes helpers give the same hex here as on a runtime with
// native WebCrypto (this Bun process, as a Workers isolate).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bytesToHex, digestHex, hmacHex, utf8Bytes } from "@liaison/app-sdk/bytes"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
import { webcryptoHostCall } from "~/modules/apps/sandbox/webcrypto-shim"

let pool: SandboxPool
const SDK_BYTES = join(import.meta.dir, "../../../../../../packages/app-sdk/src/bytes.ts")

beforeAll(async () => {
  pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
}, 60_000)

afterAll(async () => {
  await pool.shutdown()
})

async function run(source: string, params: unknown = {}): Promise<unknown> {
  return executeInSandbox({
    pool,
    bundleSource: source,
    exportName: "main",
    params,
    bridge: {},
  })
}

const TEXT = "Héllo, wörld — 𝄞 audience@example.com"
const KEY = "s3cr3t-kéy"
const hex = (alg: string, text: string) => createHash(alg).update(text, "utf8").digest("hex")
const hmac = (alg: string, key: string, text: string) =>
  createHmac(alg, key).update(text, "utf8").digest("hex")

// The guest's own byte helpers, written against the sandbox's byte arrays.
const GUEST_HELPERS = `
function utf8(s) { var out = []; var e = unescape(encodeURIComponent(s)); for (var i = 0; i < e.length; i++) out.push(e.charCodeAt(i)); return out; }
function hexOf(b) { var s = ""; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
`

describe("WebCrypto in the QuickJS sandbox", () => {
  it("has no typed arrays, and has crypto", async () => {
    const out = await run(
      `function main() { return [typeof Uint8Array, typeof ArrayBuffer, typeof crypto, typeof crypto.subtle.digest]; }`,
    )
    expect(out).toEqual(["undefined", "undefined", "object", "function"])
  })

  it("digest: SHA-1, SHA-256, SHA-384 and SHA-512 equal node:crypto's", async () => {
    const out = await run(
      `${GUEST_HELPERS}
      async function main(p) {
        var r = {};
        for (var alg of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) r[alg] = hexOf(await crypto.subtle.digest(alg, utf8(p.text)));
        r.empty = hexOf(await crypto.subtle.digest({ name: "sha-256" }, []));
        return r;
      }`,
      { text: TEXT },
    )
    expect(out).toEqual({
      "SHA-1": hex("sha1", TEXT),
      "SHA-256": hex("sha256", TEXT),
      "SHA-384": hex("sha384", TEXT),
      "SHA-512": hex("sha512", TEXT),
      empty: hex("sha256", ""),
    })
  })

  it("HMAC: importKey raw, sign and verify equal node:crypto's; a wrong signature or usage fails", async () => {
    const out = (await run(
      `${GUEST_HELPERS}
      async function main(p) {
        var r = {};
        for (var h of ["SHA-1", "SHA-256", "SHA-512"]) {
          var k = await crypto.subtle.importKey("raw", utf8(p.key), { name: "HMAC", hash: h }, false, ["sign", "verify"]);
          var sig = await crypto.subtle.sign("HMAC", k, utf8(p.text));
          var bad = sig.slice(); bad[0] = bad[0] ^ 1;
          r[h] = { sig: hexOf(sig), ok: await crypto.subtle.verify({ name: "HMAC" }, k, sig, utf8(p.text)),
            bad: await crypto.subtle.verify("HMAC", k, bad, utf8(p.text)),
            short: await crypto.subtle.verify("HMAC", k, sig.slice(1), utf8(p.text)) };
        }
        var k2 = await crypto.subtle.importKey("raw", utf8(p.key), { name: "HMAC", hash: { name: "SHA-256" } }, false, ["verify"]);
        r.key = { type: k2.type, extractable: k2.extractable, algorithm: k2.algorithm, usages: k2.usages };
        r.signWithVerifyKey = await crypto.subtle.sign("HMAC", k2, [1]).then(function () { return "signed"; }, function (e) { return e.name; });
        r.exportNotExtractable = await crypto.subtle.exportKey("raw", k2).then(function () { return "exported"; }, function (e) { return e.name; });
        return r;
      }`,
      { text: TEXT, key: KEY },
    )) as Record<string, unknown>
    for (const [h, node] of [
      ["SHA-1", "sha1"],
      ["SHA-256", "sha256"],
      ["SHA-512", "sha512"],
    ] as const) {
      expect(out[h]).toEqual({ sig: hmac(node, KEY, TEXT), ok: true, bad: false, short: false })
    }
    expect(out.key).toEqual({
      type: "secret",
      extractable: false,
      algorithm: { name: "HMAC", hash: { name: "SHA-256" }, length: Buffer.byteLength(KEY) * 8 },
      usages: ["verify"],
    })
    expect(out.signWithVerifyKey).toBe("InvalidAccessError")
    expect(out.exportNotExtractable).toBe("InvalidAccessError")
  })

  it("getRandomValues fills bytes, randomUUID is a v4 uuid, and the caps hold", async () => {
    const out = (await run(
      `async function main() {
        var a = crypto.getRandomValues(new Array(64).fill(0));
        var big; try { crypto.getRandomValues(new Array(65537)); big = "filled"; } catch (e) { big = e.name; }
        return { len: a.length, bytes: a.every(function (b) { return b === (b & 255); }), distinct: new Set(a).size > 8,
          uuid: crypto.randomUUID(), other: crypto.randomUUID(), big: big };
      }`,
    )) as Record<string, unknown>
    expect(out).toMatchObject({ len: 64, bytes: true, distinct: true, big: "QuotaExceededError" })
    expect(out.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(out.uuid).not.toBe(out.other)
  })

  it("rejects what WebCrypto rejects, as a rejected promise with WebCrypto's error name", async () => {
    const out = await run(
      `async function main() {
        async function name(p) { try { await p; return "ok"; } catch (e) { return e.name; } }
        return {
          md5: await name(crypto.subtle.digest("MD5", [1])),
          string: await name(crypto.subtle.digest("SHA-256", "abc")),
          notByte: await name(crypto.subtle.digest("SHA-256", [256])),
          encrypt: await name(crypto.subtle.encrypt({ name: "AES-GCM" }, {}, [1])),
          jwk: await name(crypto.subtle.importKey("jwk", {}, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])),
          notAKey: await name(crypto.subtle.sign("HMAC", { algorithm: { name: "HMAC" }, usages: ["sign"] }, [1])),
        };
      }`,
    )
    expect(out).toEqual({
      md5: "NotSupportedError",
      string: "TypeError",
      notByte: "TypeError",
      encrypt: "NotSupportedError",
      jwk: "NotSupportedError",
      notAKey: "TypeError",
    })
  })

  it("the host function never throws: an unknown op and a bad hash answer an error string", () => {
    expect(webcryptoHostCall("nope")).toBe("0NotSupportedError\nUnknown crypto operation: nope")
    expect(webcryptoHostCall("digest", "MD5", "")).toStartWith("0NotSupportedError\n")
    expect(webcryptoHostCall("random", 65_537)).toStartWith("0QuotaExceededError\n")
  })
})

describe("@liaison/app-sdk/bytes: the same hex in QuickJS and on native WebCrypto", () => {
  let dir = ""
  let bundle = ""

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "webcrypto-sdk-"))
    const entry = join(dir, "entry.ts")
    writeFileSync(
      entry,
      // The SDK file by path: the entry sits outside the workspace.
      `import { digestHex, hmacHex, utf8Bytes, bytesToHex } from ${JSON.stringify(SDK_BYTES)}
export async function main(p: { text: string; key: string }) {
  return {
    sha1: await digestHex("SHA-1", p.text),
    sha256: await digestHex("SHA-256", p.text),
    sha512: await digestHex("SHA-512", p.text),
    hmac256: await hmacHex("SHA-256", p.key, p.text),
    utf8: bytesToHex(utf8Bytes(p.text)),
  }
}
`,
    )
    const build = await Bun.build({ entrypoints: [entry], target: "bun", external: ["node:*"] })
    expect(build.success).toBe(true)
    bundle = await (build.outputs[0] as Blob).text()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("digestHex, hmacHex and utf8Bytes agree with node:crypto on both", async () => {
    const expected = {
      sha1: hex("sha1", TEXT),
      sha256: hex("sha256", TEXT),
      sha512: hex("sha512", TEXT),
      hmac256: hmac("sha256", KEY, TEXT),
      utf8: Buffer.from(TEXT, "utf8").toString("hex"),
    }
    const quickjs = await executeInSandbox({
      pool,
      bundleSource: esmExportsToGlobalThis(bundle),
      exportName: "main",
      params: { text: TEXT, key: KEY },
      bridge: {},
    })
    const native = {
      sha1: await digestHex("SHA-1", TEXT),
      sha256: await digestHex("SHA-256", TEXT),
      sha512: await digestHex("SHA-512", TEXT),
      hmac256: await hmacHex("SHA-256", KEY, TEXT),
      utf8: bytesToHex(utf8Bytes(TEXT)),
    }
    expect(quickjs).toEqual(expected)
    expect(native).toEqual(expected)
  })
})
