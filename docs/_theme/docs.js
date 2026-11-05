// SPDX-License-Identifier: FSL-1.1-ALv2
// Liaison docs: phone menu toggle, code copy buttons and the built-in search.
// Everything else on the page works without this script.
;(() => {
  const root = document.documentElement.dataset.root || "./"

  // Phone menu: shows or hides the sidebar.
  const menu = document.querySelector(".menu-btn")
  const side = document.getElementById("side")
  if (menu && side) {
    menu.addEventListener("click", () => {
      const open = side.classList.toggle("open")
      menu.setAttribute("aria-expanded", String(open))
      if (open) side.querySelector("input")?.focus({ preventScroll: true })
    })
  }

  // Copy buttons on code blocks.
  for (const btn of document.querySelectorAll(".code .copy")) {
    btn.hidden = false
    btn.addEventListener("click", () => {
      const code = btn.closest(".code")?.querySelector("pre code")
      if (!code || !navigator.clipboard) return
      navigator.clipboard.writeText(code.textContent || "").then(() => {
        btn.textContent = "Copied"
        setTimeout(() => {
          btn.textContent = "Copy"
        }, 1500)
      })
    })
  }

  // Search: loads search-index.json on first focus, matches every word of
  // the query against titles, sections and headings.
  let index = null
  let loading = null
  const load = () => {
    if (!loading) {
      loading = fetch(`${root}search-index.json`)
        .then((r) => r.json())
        .then((data) => {
          index = data
        })
        .catch(() => {
          index = []
        })
    }
    return loading
  }
  const norm = (s) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  const search = (q) => {
    const words = norm(q).split(/\s+/).filter(Boolean)
    if (words.length === 0 || !index) return []
    const hits = []
    for (const page of index) {
      const title = norm(page.title)
      const hay = `${title} ${norm(page.section)} ${norm(page.text)}`
      if (words.every((w) => title.includes(w))) hits.push({ score: 3, page })
      else if (words.every((w) => hay.includes(w))) hits.push({ score: 1, page })
      for (const h of page.headings) {
        const ht = norm(h.text)
        if (words.every((w) => ht.includes(w))) hits.push({ score: 2, page, heading: h })
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 8)
  }
  const esc = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

  const boxes = document.querySelectorAll("[data-search]")
  for (const box of boxes) {
    if (!box.querySelector("input")) {
      box.innerHTML =
        '<input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false"><ul class="results" role="listbox" hidden></ul>'
    }
    box.hidden = false
    const input = box.querySelector("input")
    const list = box.querySelector(".results")
    let active = -1
    const render = () => {
      const q = input.value.trim()
      if (!q) {
        list.hidden = true
        return
      }
      const hits = search(q)
      active = -1
      list.innerHTML = hits.length
        ? hits
            .map((h) => {
              const href = root + h.page.url + (h.heading ? `#${h.heading.id}` : "")
              const label = h.heading ? h.heading.text : h.page.title
              const sub = h.heading ? h.page.title : h.page.section
              return `<li role="option"><a href="${esc(href)}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</a></li>`
            })
            .join("")
        : '<li class="empty">No results</li>'
      list.hidden = false
    }
    const move = (d) => {
      const links = list.querySelectorAll("a")
      if (links.length === 0) return
      active = (active + d + links.length) % links.length
      links.forEach((a, i) => {
        a.setAttribute("aria-selected", String(i === active))
      })
      links[active].scrollIntoView({ block: "nearest" })
    }
    input.addEventListener("focus", () => {
      load().then(render)
    })
    input.addEventListener("input", () => {
      if (index) render()
      else load().then(render)
    })
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        move(1)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        move(-1)
      } else if (e.key === "Enter") {
        const links = list.querySelectorAll("a")
        const target = links[Math.max(active, 0)]
        if (target) location.href = target.href
      } else if (e.key === "Escape") {
        list.hidden = true
        input.blur()
      }
    })
    box.addEventListener("focusout", (e) => {
      if (!box.contains(e.relatedTarget)) {
        setTimeout(() => {
          list.hidden = true
        }, 100)
      }
    })
  }

  // "/" focuses the first visible search box.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    const input = [...document.querySelectorAll("[data-search] input")].find((i) => i.offsetParent)
    if (input) {
      e.preventDefault()
      input.focus()
    }
  })
})()
