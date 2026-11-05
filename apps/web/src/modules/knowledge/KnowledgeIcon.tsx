// SPDX-License-Identifier: FSL-1.1-ALv2
import { BookOpen } from "lucide-solid"
import type { Component } from "solid-js"

const KnowledgeIcon: Component<{ size?: number }> = (props) => {
  return <BookOpen size={props.size ?? 20} />
}

export default KnowledgeIcon
