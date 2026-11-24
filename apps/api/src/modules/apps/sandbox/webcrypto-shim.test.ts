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

  // Bytes cross between QuickJS and the host in strings, which QuickJS cuts at a NUL.
  describe("a zero byte anywhere is a byte like any other", () => {
    const WITH_ZEROS = [
      [0],
      [0, 0, 0],
      [0, 1, 2],
      [1, 0, 2],
      [1, 2, 0],
      [97, 98, 99, 0, 101, 118],
      [255, 0, 128, 0],
    ]
    const buf = (b: readonly number[]) => Buffer.from(b)

    it("digest: the data's zeros count, and an answer that holds one is whole", async () => {
      // Enough texts that every algorithm has answers with a zero first, inside and last.
      const inputs = [
        ...WITH_ZEROS,
        ...Array.from({ length: 1_500 }, (_, i) => [...Buffer.from(`a${i}`)]),
      ]
      const out = (await run(
        `${GUEST_HELPERS}
        async function main(p) {
          var r = {};
          for (var alg of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
            r[alg] = [];
            for (var i = 0; i < p.inputs.length; i++) r[alg].push(hexOf(await crypto.subtle.digest(alg, p.inputs[i])));
          }
          return r;
        }`,
        { inputs },
      )) as Record<string, string[]>
      for (const [alg, node] of [
        ["SHA-1", "sha1"],
        ["SHA-256", "sha256"],
        ["SHA-384", "sha384"],
        ["SHA-512", "sha512"],
      ] as const) {
        const want = inputs.map((b) => createHash(node).update(buf(b)).digest())
        for (const at of [(d: Buffer) => d[0], (d: Buffer) => d[9], (d: Buffer) => d.at(-1)]) {
          expect(want.some((d) => at(d) === 0)).toBe(true)
        }
        expect(out[alg]).toEqual(want.map((d) => d.toString("hex")))
      }
    })

    it("HMAC: key, data and signature keep their zeros; data that differs after one does not verify", async () => {
      const cases = WITH_ZEROS.flatMap((key) => WITH_ZEROS.map((data) => ({ key, data })))
      const signatures = Array.from({ length: 600 }, (_, i) => [
        ...createHmac("sha256", "k").update(`m${i}`).digest(),
      ])
      expect(signatures.some((b) => b.includes(0))).toBe(true)
      const out = (await run(
        `${GUEST_HELPERS}
        async function main(p) {
          var sigs = [], longer = [], other = [], exported = [];
          for (var c of p.cases) {
            var k = await crypto.subtle.importKey("raw", c.key, { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
            var s = await crypto.subtle.sign("HMAC", k, c.data);
            sigs.push(hexOf(s));
            exported.push(hexOf(await crypto.subtle.exportKey("raw", k)) + ":" + k.algorithm.length);
            longer.push(await crypto.subtle.verify("HMAC", k, s, c.data.concat([0, 120])));
            other.push(await crypto.subtle.verify("HMAC", k, s.slice(0, 1).concat([0], s.slice(2)), c.data));
          }
          var kk = await crypto.subtle.importKey("raw", utf8("k"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
          var ok = 0, forged = 0;
          for (var i = 0; i < p.signatures.length; i++) {
            if (await crypto.subtle.verify("HMAC", kk, p.signatures[i], utf8("m" + i))) ok++;
            if (await crypto.subtle.verify("HMAC", kk, p.signatures[i], utf8("m" + i).concat([0, 101, 118]))) forged++;
          }
          return { sigs: sigs, exported: exported, longer: longer, other: other, ok: ok, forged: forged };
        }`,
        { cases, signatures },
      )) as {
        sigs: string[]
        exported: string[]
        longer: boolean[]
        other: boolean[]
        ok: number
        forged: number
      }
      const want = cases.map((c) =>
        createHmac("sha256", buf(c.key)).update(buf(c.data)).digest("hex"),
      )
      expect(out.sigs).toEqual(want)
      expect(out.exported).toEqual(
        cases.map((c) => `${buf(c.key).toString("hex")}:${c.key.length * 8}`),
      )
      expect(out.longer).not.toContain(true)
      // The one case in 256 whose second byte is zero already is the same signature.
      expect(out.other).toEqual(want.map((h) => h.slice(2, 4) === "00"))
      expect({ ok: out.ok, forged: out.forged }).toEqual({ ok: signatures.length, forged: 0 })
    })

    it("a text the host hands over is whole past a NUL, and is never read as code", async () => {
      for (const text of ["a\0b", "\0", '"\0"); throw 1; //', "\0\u2028\u2029\\` x"]) {
        expect(
          await run(
            `function main(p) { return p.split("").map(function (c) { return c.charCodeAt(0); }); }`,
            text,
          ),
        ).toEqual(text.split("").map((c) => c.charCodeAt(0)))
      }
    })

    it("getRandomValues fills the whole array, zeros included", async () => {
      const out = (await run(
        `function main() {
          var tails = 0, zeros = 0;
          for (var i = 0; i < 1000; i++) {
            var a = crypto.getRandomValues(new Array(64).fill(-1));
            if (a.indexOf(-1) >= 0) tails++;
            if (a.indexOf(0) >= 0) zeros++;
          }
          return { unfilled: tails, withZero: zeros > 0, none: crypto.getRandomValues([]).length };
        }`,
      )) as Record<string, unknown>
      expect(out).toEqual({ unfilled: 0, withZero: true, none: 0 })
    })
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
    for (const notHex of ["abc", "0g", "AB", 7]) {
      expect(webcryptoHostCall("digest", "SHA-256", notHex)).toStartWith("0TypeError\n")
    }
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
