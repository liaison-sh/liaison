// SPDX-License-Identifier: FSL-1.1-ALv2
import { FolderKanban } from "lucide-solid"
import type { Component } from "solid-js"

export const ProjectsIcon: Component<{ size?: number }> = (props) => (
  <FolderKanban size={Math.max(props.size ?? 20, 16)} />
)
