// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Loads + validates a `catalog.yaml` file into a `ReadCatalog` (db-core).
// Malformed YAML or a catalog failing `validateCatalog` (incl. the
// secret-column guard) throws with as much line info as `yaml` gives us.

import { readFileSync } from "node:fs"
import { CatalogValidationError, type ReadCatalog, validateCatalog } from "@liaison/db-core"
import { parse as parseYaml } from "yaml"

export class CatalogLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CatalogLoadError"
  }
}

export function loadCatalogFromFile(path: string): ReadCatalog {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (err) {
    throw new CatalogLoadError(
      `Could not read catalog file at "${path}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return loadCatalogFromYaml(raw, path)
}

export function loadCatalogFromYaml(yamlText: string, sourceLabel = "<catalog>"): ReadCatalog {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CatalogLoadError(`Malformed YAML in "${sourceLabel}": ${message}`)
  }
  try {
    return validateCatalog(parsed)
  } catch (err) {
    if (err instanceof CatalogValidationError) {
      throw new CatalogLoadError(`Catalog validation failed in "${sourceLabel}": ${err.message}`)
    }
    throw err
  }
}
