// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal, type JSX } from "solid-js"
import type { PreviewApi } from "./entity-preview-store"

export interface EntityPreviewRenderer<T = any> {
  fetch: (id: string, api: PreviewApi) => Promise<T>
  render: (data: T) => JSX.Element
}

export const entityPreviewRegistry = new Map<string, EntityPreviewRenderer>()

// Renderers register when their module loads, which can happen after a message
// with a mention has already rendered. Lookups read this version inside
// reactive scopes so mentions re-resolve when a renderer arrives.
const [registryVersion, setRegistryVersion] = createSignal(0)

export function registerEntityPreview<T>(args: {
  app: string
  entityType: string
  fetch: (id: string, api: PreviewApi) => Promise<T>
  render: (data: T) => JSX.Element
}): void {
  entityPreviewRegistry.set(`${args.app}:${args.entityType}`, {
    fetch: args.fetch,
    render: args.render,
  })
  setRegistryVersion((v) => v + 1)
}

export function getEntityPreviewRenderer(
  app: string,
  entityType: string,
): EntityPreviewRenderer | undefined {
  registryVersion()
  return entityPreviewRegistry.get(`${app}:${entityType}`)
}
