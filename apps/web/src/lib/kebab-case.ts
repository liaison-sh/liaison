// SPDX-License-Identifier: FSL-1.1-ALv2

/** Normalize a free-text input to a server-acceptable kebab-case slug
 *  (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, max 60). Lowercases, replaces runs of
 *  non-alnum with a single hyphen, trims leading/trailing hyphens. Used by the
 *  skill/routine/memory edit surfaces so the user never hits a raw 400. */
export function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
}
