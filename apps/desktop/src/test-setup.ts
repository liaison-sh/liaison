// SPDX-License-Identifier: FSL-1.1-ALv2
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@solidjs/testing-library"
import { afterEach } from "vitest"

// Unmount everything between tests, and take the overlay's own portal root
// with it: the overlay appends to document.body rather than to a container the
// testing library owns, so cleanup alone would leave it behind.
afterEach(() => {
  cleanup()
  for (const node of Array.from(document.body.children)) node.remove()
})

// NODE'S OWN WEB STORAGE SHADOWS JSDOM'S.
//
// Node 22 and later define `localStorage` on the global itself. When the
// process was not given `--localstorage-file` it is present but unusable, and
// because it is defined on the global BEFORE the jsdom environment populates
// its own globals, jsdom's working Storage never lands: every `localStorage`
// call in a test throws "clear is not a function", which reads as a broken
// test rather than as a runtime shadowing a browser API.
//
// So the window's own Storage is installed over it when the global one cannot
// do what a Storage does. A runtime with a working `localStorage` is left
// exactly as it is.
function storageIsUsable(candidate: unknown): boolean {
  const storage = candidate as Storage | undefined
  if (!storage) return false
  try {
    storage.setItem("liaison:test-setup", "1")
    storage.removeItem("liaison:test-setup")
    return typeof storage.clear === "function"
  } catch {
    return false
  }
}

// ONE LIVE STORAGE, ON BOTH GLOBALS, FOR EVERY FILE (P6d-FX7, SK-1).
//
// This used to install a storage only when `globalThis.localStorage` was
// unusable, which is true for the FIRST file in a worker and false for every
// file after it: the previous file's jsdom Storage was still on the global, it
// still worked, so nothing was installed and `globalThis.localStorage` and
// `window.localStorage` were two different live objects. A module reading one
// and a test arranging the other then quietly disagreed, and a storage guard
// passed by never reaching the code it claimed to pin.
//
// So the two are pointed at the same object unconditionally, every file: the
// window's own Storage when jsdom gave one, the global's when it did not, and
// a memory Storage when neither can do what a Storage does.
const fromWindow = typeof window === "undefined" ? undefined : window.localStorage
const fromGlobal = (globalThis as { localStorage?: unknown }).localStorage
const store = storageIsUsable(fromWindow)
  ? (fromWindow as Storage)
  : storageIsUsable(fromGlobal)
    ? (fromGlobal as Storage)
    : memoryStorage()
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: store,
})
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: store,
  })
}

/** A Storage of last resort, for a jsdom that has none either. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  } as Storage
}
