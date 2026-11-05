// SPDX-License-Identifier: FSL-1.1-ALv2
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@solidjs/testing-library"
import { afterEach } from "vitest"

// Unmount all components rendered by @solidjs/testing-library between tests.
// Without this, jsdom keeps prior trees in the document, causing "Found multiple
// elements with text X" errors when later tests query for the same text.
afterEach(() => {
  cleanup()
})

// Polyfill window.matchMedia for jsdom. Tests can override per-spec via vi.fn().
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any
}

// Polyfill scrollIntoView for jsdom. DOM-free test files opt into the node
// environment (`// @vitest-environment node`), where there is no HTMLElement.
if (
  typeof HTMLElement !== "undefined" &&
  typeof HTMLElement.prototype.scrollIntoView === "undefined"
) {
  HTMLElement.prototype.scrollIntoView = () => {}
}

// Ensure localStorage is always a proper in-memory implementation.
// vi.stubGlobal in individual test files can replace it with a partial mock,
// corrupting it for other test files in the same worker.
const memoryStorage: Record<string, string> = {}
const memoryLocalStorage = {
  getItem: (key: string) => memoryStorage[key] ?? null,
  setItem: (key: string, val: string) => {
    memoryStorage[key] = val
  },
  removeItem: (key: string) => {
    delete memoryStorage[key]
  },
  clear: () => {
    for (const key of Object.keys(memoryStorage)) delete memoryStorage[key]
  },
  get length() {
    return Object.keys(memoryStorage).length
  },
  key: (index: number) => Object.keys(memoryStorage)[index] ?? null,
}

// Set as the default — tests can still override with vi.stubGlobal
if (typeof globalThis.localStorage === "undefined" || !globalThis.localStorage?.getItem) {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryLocalStorage,
    writable: true,
    configurable: true,
  })
}

// Clear localStorage between tests to prevent cross-test pollution
afterEach(() => {
  try {
    localStorage.clear()
  } catch {}
})

// jsdom installs Node's TextEncoder, whose output is a Uint8Array from the Node
// realm, so `new TextEncoder().encode(x) instanceof Uint8Array` is FALSE here
// while it is true in every real browser. Library code that branches on
// `instanceof Uint8Array` (the mailbox crypto package does, to tell raw key
// material from a CryptoKey) then takes the wrong branch under test only.
// Re-wrap the output in the realm's own Uint8Array so the test environment
// matches the browser.
if (typeof TextEncoder !== "undefined" && !(new TextEncoder().encode("") instanceof Uint8Array)) {
  const NodeTextEncoder = TextEncoder
  class RealmTextEncoder extends NodeTextEncoder {
    // The return type is inferred rather than annotated: copying through a
    // freshly allocated ArrayBuffer is what makes it exactly the base method's
    // `Uint8Array<ArrayBuffer>`, where slicing an `ArrayBufferLike` is not.
    encode(input?: string) {
      const out = super.encode(input)
      const buffer = new ArrayBuffer(out.byteLength)
      const copy = new Uint8Array(buffer)
      copy.set(out)
      return copy
    }
  }
  Object.defineProperty(globalThis, "TextEncoder", {
    value: RealmTextEncoder,
    writable: true,
    configurable: true,
  })
}
