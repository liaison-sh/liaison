// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * A dot-path segment that reaches the object machinery instead of data:
 * writing through one changes the prototype every object in the process shares.
 * Every helper that walks a caller-supplied path refuses these.
 */
export function isUnsafePathSegment(segment: string): boolean {
  return segment === "__proto__" || segment === "constructor" || segment === "prototype"
}

/**
 * An option read that ignores inherited properties. Use it for flags that widen
 * access (`allowPrivate`, `trustedHost`, ...): a value inherited from a polluted
 * `Object.prototype` must never switch a guard off.
 */
export function ownOption<T extends object, K extends keyof T>(opts: T, key: K): T[K] | undefined {
  return Object.hasOwn(opts, key) ? opts[key] : undefined
}
