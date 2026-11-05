// SPDX-License-Identifier: FSL-1.1-ALv2
// An avatar whose picture fails to load (404) shows its initials or glyph,
// never the browser's broken image.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { AvatarImage } from "~/ui/AvatarImage"
import { Avatar, AvatarStack } from "~/ui/AvatarStack"

afterEach(() => cleanup())

describe("AvatarImage", () => {
  it("shows the picture, then the fallback once it fails to load", () => {
    render(() => <AvatarImage url="/avatars/gone.png" fallback={<span>QD</span>} />)
    const img = document.querySelector("img")
    expect(img?.getAttribute("src")).toContain("/avatars/gone.png")
    expect(screen.queryByText("QD")).toBeNull()

    fireEvent.error(img!)
    expect(document.querySelector("img")).toBeNull()
    expect(screen.getByText("QD")).toBeInTheDocument()
  })

  it("a new URL gets a fresh try", () => {
    const [url, setUrl] = createSignal("/avatars/a.png")
    render(() => <AvatarImage url={url()} fallback={<span>QD</span>} />)
    fireEvent.error(document.querySelector("img")!)
    expect(document.querySelector("img")).toBeNull()

    setUrl("/avatars/b.png")
    expect(document.querySelector("img")?.getAttribute("src")).toContain("/avatars/b.png")
  })
})

describe("the shared Avatar and AvatarStack fall back to initials on a broken picture", () => {
  it("Avatar", () => {
    render(() => <Avatar user={{ id: "u1", name: "Quinn Dupont", avatarUrl: "/a/404.png" }} />)
    fireEvent.error(document.querySelector("img")!)
    expect(document.querySelector("img")).toBeNull()
    expect(screen.getByText("QD")).toBeInTheDocument()
  })

  it("AvatarStack circles", () => {
    render(() => (
      <AvatarStack
        users={[
          { id: "u1", name: "Alice Smith", avatarUrl: "/a/1.png" },
          { id: "u2", name: "Bob Jones", avatarUrl: "/a/2.png" },
        ]}
      />
    ))
    for (const img of Array.from(document.querySelectorAll("img"))) fireEvent.error(img)
    expect(document.querySelectorAll("img")).toHaveLength(0)
    expect(screen.getAllByText("AS").length).toBeGreaterThan(0)
    expect(screen.getAllByText("BJ").length).toBeGreaterThan(0)
  })
})
