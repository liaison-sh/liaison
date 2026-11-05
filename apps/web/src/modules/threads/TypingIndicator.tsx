// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, Show } from "solid-js"
import { tNow } from "~/modules/i18n/i18n-context"
import { getTypingUsers } from "~/modules/threads/presence-store"

interface TypingIndicatorProps {
  threadId: string
  currentUserId: string
}

const TypingIndicator: Component<TypingIndicatorProps> = (props) => {
  const typing = () => getTypingUsers(props.threadId, props.currentUserId)

  const text = () => {
    const users = typing()
    if (users.length === 0) return null
    if (users.length === 1) return tNow("kernel.threadsUi.typingOne", { name: users[0].userName })
    if (users.length === 2) {
      return tNow("kernel.threadsUi.typingTwo", { a: users[0].userName, b: users[1].userName })
    }
    return tNow("kernel.threadsUi.typingMany", { count: users.length })
  }

  return (
    <Show when={text()}>
      <div class="px-4 py-1.5 text-[12px] text-text-tertiary">{text()}</div>
    </Show>
  )
}

export default TypingIndicator
