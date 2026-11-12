// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WebCrypto for the QuickJS sandbox.
 *
 * WebCrypto (`crypto.subtle`, `crypto.getRandomValues`, `crypto.randomUUID`)
 * is the crypto primitive of sandboxed apps: a Workers isolate has it
 * natively, QuickJS has none. This installs the subset apps need as
 * `globalThis.crypto` in a QuickJS context, backed by host functions
 * (node:crypto, synchronous, no bridge round trip), with WebCrypto's method
 * names, algorithm identifiers, key objects, promises and error names:
 *
 *  - `crypto.subtle.digest(alg, data)`: SHA-1, SHA-256, SHA-384, SHA-512.
 *  - `crypto.subtle.importKey("raw", keyData, {name: "HMAC", hash, length?}, extractable, usages)`
 *  - `crypto.subtle.sign("HMAC", key, data)` / `crypto.subtle.verify("HMAC", key, signature, data)`
 *  - `crypto.subtle.exportKey("raw", key)` (an extractable key only)
 *  - `crypto.getRandomValues(array)` (at most 65,536 entries) / `crypto.randomUUID()`
 *
 * One difference, forced by the sandbox: QuickJS contexts have no typed
 * arrays (pool.ts BLOCKED_GLOBALS: they allocate outside the heap limit). So
 * where WebCrypto takes a BufferSource, this takes an array of byte values
 * (0-255), and where it answers an ArrayBuffer, this answers such an array.
 * `@liaison/app-sdk/bytes` turns text into bytes and bytes into hex the same
 * way on every executor, so app code that goes through it is identical.
 *
 * Anything else (another algorithm or key format, encrypt/decrypt, deriveKey)
 * rejects with a `NotSupportedError`, as WebCrypto does for an algorithm it
 * does not know.
 *
 * Dependency free apart from node:crypto: the sandbox worker subprocess
 * (sandbox-worker.ts) imports it on a minimal env.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten"

/** The hashes `digest` and HMAC keys accept, WebCrypto name -> node:crypto name. */
const HASHES: Readonly<Record<string, string>> = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
}

/** WebCrypto's own cap on one getRandomValues call. */
const MAX_RANDOM_BYTES = 65_536

/** One input (data, key, signature) at most this long. The guest heap limit binds first. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024

/**
 * The host side. Bytes cross as "binary strings" (one char per byte, code
 * 0-255). The answer is a string: "1" + the value on success ("t"/"f" for a
 * boolean), or "0" + error name + "\n" + message, so the host function never
 * throws into QuickJS.
 */
export function webcryptoHostCall(op: unknown, ...args: unknown[]): string {
  try {
    return `1${hostOp(op, args)}`
  } catch (err) {
    const name = err instanceof HostCryptoError ? err.cryptoName : "OperationError"
    const message = err instanceof Error ? err.message : String(err)
    return `0${name}\n${message}`
  }
}

class HostCryptoError extends Error {
  constructor(
    readonly cryptoName: string,
    message: string,
  ) {
    super(message)
  }
}

function hashOf(name: unknown): string {
  const node = typeof name === "string" ? HASHES[name] : undefined
  if (!node) throw new HostCryptoError("NotSupportedError", `Unsupported hash: ${String(name)}`)
  return node
}

function bytesOf(value: unknown, what: string): Buffer {
  if (typeof value !== "string") throw new HostCryptoError("TypeError", `${what} is not bytes`)
  if (value.length > MAX_INPUT_BYTES) {
    throw new HostCryptoError("QuotaExceededError", `${what} is over ${MAX_INPUT_BYTES} bytes`)
  }
  return Buffer.from(value, "latin1")
}

function hostOp(op: unknown, args: unknown[]): string {
  switch (op) {
    case "digest":
      return createHash(hashOf(args[0]))
        .update(bytesOf(args[1], "data"))
        .digest()
        .toString("latin1")
    case "hmac":
      return createHmac(hashOf(args[0]), bytesOf(args[1], "key"))
        .update(bytesOf(args[2], "data"))
        .digest()
        .toString("latin1")
    case "hmacVerify": {
      const expected = createHmac(hashOf(args[0]), bytesOf(args[1], "key"))
        .update(bytesOf(args[3], "data"))
        .digest()
      const given = bytesOf(args[2], "signature")
      return given.length === expected.length && timingSafeEqual(given, expected) ? "t" : "f"
    }
    case "random": {
      const n = args[0]
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_RANDOM_BYTES) {
        throw new HostCryptoError(
          "QuotaExceededError",
          `getRandomValues takes at most ${MAX_RANDOM_BYTES} bytes`,
        )
      }
      return randomBytes(n).toString("latin1")
    }
    case "uuid":
      return randomUUID()
    default:
      throw new HostCryptoError("NotSupportedError", `Unknown crypto operation: ${String(op)}`)
  }
}

/**
 * The guest side: a function of the host function that defines
 * `globalThis.crypto`, unless the context already has one. Intrinsics are
 * captured first, so later bundle code replacing a prototype method cannot
 * bend how bytes reach the host.
 */
export const WEBCRYPTO_SHIM_SOURCE = `(function (host) {
  "use strict";
  if (typeof globalThis.crypto !== "undefined") return;
  var reflectApply = Reflect.apply;
  var fromCharCode = String.fromCharCode;
  var freeze = Object.freeze;
  var defineProperty = Object.defineProperty;
  var create = Object.create;
  var HASHES = { "SHA-1": 1, "SHA-256": 1, "SHA-384": 1, "SHA-512": 1 };
  var MAX_RANDOM = ${MAX_RANDOM_BYTES};
  function cryptoError(name, message) {
    if (name === "TypeError") return new TypeError(message);
    var e = new Error(message);
    e.name = name;
    return e;
  }
  function call() {
    var r = reflectApply(host, null, arguments);
    if (r.charAt(0) === "1") return r.slice(1);
    var nl = r.indexOf("\\n");
    throw cryptoError(r.slice(1, nl), r.slice(nl + 1));
  }
  function toBin(data, what) {
    if (data === null || typeof data !== "object" || typeof data.length !== "number") {
      throw new TypeError(what + " must be an array of bytes (0-255): this sandbox has no typed arrays");
    }
    var n = data.length;
    var out = "";
    for (var i = 0; i < n; i += 4096) {
      var end = i + 4096 < n ? i + 4096 : n;
      var chunk = [];
      for (var j = i; j < end; j++) {
        var b = data[j];
        if (typeof b !== "number" || b !== (b & 255)) throw new TypeError(what + "[" + j + "] is not a byte (0-255)");
        chunk[j - i] = b;
      }
      out += reflectApply(fromCharCode, null, chunk);
    }
    return out;
  }
  function fromBin(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function nameOf(alg, what) {
    var n = typeof alg === "string" ? alg : alg !== null && typeof alg === "object" ? alg.name : undefined;
    if (typeof n !== "string") throw new TypeError(what + " has no name");
    return n.toUpperCase();
  }
  function hashOf(alg, what) {
    var n = nameOf(alg, what);
    if (!HASHES[n]) throw cryptoError("NotSupportedError", "Unsupported hash: " + n);
    return n;
  }
  function settle(fn) {
    return function () {
      var self = this;
      var args = arguments;
      return new Promise(function (resolve) { resolve(reflectApply(fn, self, args)); });
    };
  }
  var keyBytes = new WeakMap();
  function CryptoKey() { throw new TypeError("Illegal constructor"); }
  function hmacKeyOf(key, usage) {
    var bin = keyBytes.get(key);
    if (bin === undefined) throw new TypeError("key is not a CryptoKey");
    if (key.usages.indexOf(usage) < 0) throw cryptoError("InvalidAccessError", "key does not allow " + usage);
    return bin;
  }
  function checkHmac(alg, key) {
    if (nameOf(alg, "algorithm") !== "HMAC") throw cryptoError("NotSupportedError", "Unsupported algorithm: " + nameOf(alg, "algorithm"));
    if (key === null || typeof key !== "object" || key.algorithm === undefined || key.algorithm.name !== "HMAC") {
      throw cryptoError("InvalidAccessError", "key is not an HMAC key");
    }
  }
  var subtle = {
    digest: settle(function (alg, data) {
      return fromBin(call("digest", hashOf(alg, "algorithm"), toBin(data, "data")));
    }),
    importKey: settle(function (format, keyData, alg, extractable, usages) {
      if (format !== "raw") throw cryptoError("NotSupportedError", "Unsupported key format: " + format);
      if (nameOf(alg, "algorithm") !== "HMAC") throw cryptoError("NotSupportedError", "Unsupported algorithm: " + nameOf(alg, "algorithm"));
      var hash = hashOf(alg.hash, "algorithm.hash");
      var bin = toBin(keyData, "keyData");
      if (bin.length === 0) throw cryptoError("DataError", "HMAC key is empty");
      if (usages === null || typeof usages !== "object" || typeof usages.length !== "number") throw new TypeError("usages is not an array");
      var list = [];
      for (var i = 0; i < usages.length; i++) {
        if (usages[i] !== "sign" && usages[i] !== "verify") throw cryptoError("SyntaxError", "Unsupported key usage: " + usages[i]);
        if (list.indexOf(usages[i]) < 0) list.push(usages[i]);
      }
      if (list.length === 0) throw cryptoError("SyntaxError", "usages is empty");
      var length = alg.length === undefined ? bin.length * 8 : alg.length;
      if (length !== bin.length * 8) throw cryptoError("DataError", "length does not match the key data");
      var key = create(CryptoKey.prototype);
      defineProperty(key, "type", { value: "secret", enumerable: true });
      defineProperty(key, "extractable", { value: extractable === true, enumerable: true });
      defineProperty(key, "algorithm", { value: freeze({ name: "HMAC", hash: freeze({ name: hash }), length: length }), enumerable: true });
      defineProperty(key, "usages", { value: freeze(list), enumerable: true });
      keyBytes.set(key, bin);
      return freeze(key);
    }),
    exportKey: settle(function (format, key) {
      if (format !== "raw") throw cryptoError("NotSupportedError", "Unsupported key format: " + format);
      var bin = keyBytes.get(key);
      if (bin === undefined) throw new TypeError("key is not a CryptoKey");
      if (key.extractable !== true) throw cryptoError("InvalidAccessError", "key is not extractable");
      return fromBin(bin);
    }),
    sign: settle(function (alg, key, data) {
      checkHmac(alg, key);
      var bin = hmacKeyOf(key, "sign");
      return fromBin(call("hmac", key.algorithm.hash.name, bin, toBin(data, "data")));
    }),
    verify: settle(function (alg, key, signature, data) {
      checkHmac(alg, key);
      var bin = hmacKeyOf(key, "verify");
      return call("hmacVerify", key.algorithm.hash.name, bin, toBin(signature, "signature"), toBin(data, "data")) === "t";
    })
  };
  ["encrypt", "decrypt", "deriveBits", "deriveKey", "generateKey", "wrapKey", "unwrapKey"].forEach(function (m) {
    subtle[m] = settle(function () { throw cryptoError("NotSupportedError", "crypto.subtle." + m + " is not available in this sandbox"); });
  });
  var api = {
    subtle: freeze(subtle),
    getRandomValues: function (array) {
      if (array === null || typeof array !== "object" || typeof array.length !== "number") {
        throw new TypeError("getRandomValues takes an array: this sandbox has no typed arrays");
      }
      if (array.length > MAX_RANDOM) throw cryptoError("QuotaExceededError", "getRandomValues takes at most " + MAX_RANDOM + " entries");
      var bin = call("random", array.length);
      for (var i = 0; i < bin.length; i++) array[i] = bin.charCodeAt(i);
      return array;
    },
    randomUUID: function () { return call("uuid"); }
  };
  defineProperty(globalThis, "crypto", { value: freeze(api), writable: true, configurable: true, enumerable: false });
})`

/**
 * Define `globalThis.crypto` in a fresh QuickJS context (after hardening,
 * before any app code). The host function is handed to the shim as an
 * argument and never stored on the global object.
 */
export function installWebCrypto(ctx: QuickJSAsyncContext): void {
  const handles: QuickJSHandle[] = []
  try {
    const host = ctx.newFunction("__webcrypto_host", (...argHandles) =>
      ctx.newString(webcryptoHostCall(...argHandles.map((h) => ctx.dump(h)))),
    )
    handles.push(host)
    const shim = ctx.evalCode(WEBCRYPTO_SHIM_SOURCE, "webcrypto-shim.js")
    if (shim.error) {
      const err = ctx.dump(shim.error)
      shim.error.dispose()
      throw new Error(`WebCrypto shim error: ${JSON.stringify(err)}`)
    }
    handles.push(shim.value)
    const r = ctx.callFunction(shim.value, ctx.undefined, host)
    if (r.error) {
      const err = ctx.dump(r.error)
      r.error.dispose()
      throw new Error(`WebCrypto shim error: ${JSON.stringify(err)}`)
    }
    r.value.dispose()
  } finally {
    for (const h of handles) h.dispose()
  }
}
