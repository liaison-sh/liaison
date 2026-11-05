#!/usr/bin/env python3
"""Build an owner-facing board page from a catalog and per-card proof records.

Usage: proof-board.py <board-dir>

Inputs, under <board-dir>:
  catalog.json                 array of cards (or catalog/*.json, concatenated)
  proof/<ITEM-ID>/result.json  {verdict, summary, evidence:[{kind,file|text,caption}], defects:[{text,status}], by}
  config.json                  optional: title, intro, facts{}, round_note
Output:
  site/index.html plus site/proof/_m/<hash>.<ext> (images to jpg, audio to mp3; text inlined)

Card kinds: "check" (proof board: owner answers ok / issue / skip) and "decision" (owner picks
an option). The page writes the owner's answers to the artifact database, collection
`verdicts`, one document per card id: {id, verdict, note, at}. Publish with the Artifact tool
with `capabilities: {db: {}}`; republish to the same URL each round.
"""
import glob
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys

VERDICT_LABEL = {"pass": "Proven", "fail": "Defect found", "partial": "Partly proven",
                 "human": "Needs your hands", "blocked": "Blocked", "untested": "Not yet run",
                 "open": "Your call", "info": "Status"}
NOTE_HINT = {False: "What is wrong, what you expected, or a wish. Saved when you leave the field.",
             True: "Something else, a condition, or a question. Saved when you leave the field."}
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def clean_text(raw, cap):
    raw = ANSI.sub("", raw)
    raw = "".join(ch for ch in raw if ch in "\t\n\r" or ord(ch) >= 32).replace("�", "?")
    return raw if len(raw) <= cap else raw[:cap] + "\n... (truncated)"


class Board:
    def __init__(self, root):
        self.root = root
        self.proof = os.path.join(root, "proof")
        self.site = os.path.join(root, "site")
        self.media = os.path.join(self.site, "proof", "_m")
        cfg_path = os.path.join(root, "config.json")
        self.cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
        self.cfg.setdefault("title", "Proof board")
        self.cfg.setdefault("intro", "One card per thing to prove. My verdict and evidence are on each card; yours goes in with the buttons and saves as you go.")
        self.cfg.setdefault("facts", {})
        self.cfg.setdefault("round_note", "")

    def cards(self):
        paths = [os.path.join(self.root, "catalog.json")] + sorted(glob.glob(os.path.join(self.root, "catalog", "*.json")))
        items = []
        for p in paths:
            if os.path.exists(p):
                items.extend(json.load(open(p)))
        return items

    def result(self, item_id):
        p = os.path.join(self.proof, item_id, "result.json")
        r = {"verdict": "untested", "summary": "", "evidence": [], "defects": [], "by": ""}
        if os.path.exists(p):
            try:
                r.update(json.load(open(p)))
            except Exception as e:
                r["summary"] = f"result.json unreadable: {e}"
        return r

    def convert(self, src, kind):
        os.makedirs(self.media, exist_ok=True)
        digest = hashlib.sha1(open(src, "rb").read()).hexdigest()[:16]
        ext = os.path.splitext(src)[1].lower()
        if kind == "image":
            out = os.path.join(self.media, digest + ".jpg")
            if not os.path.exists(out):
                if ext in (".jpg", ".jpeg"):
                    shutil.copyfile(src, out)
                else:
                    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", src, "--out", out],
                                   check=True, capture_output=True)
        elif kind == "audio":
            out = os.path.join(self.media, digest + ".mp3")
            if not os.path.exists(out):
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-codec:a", "libmp3lame", "-b:a", "128k", out], check=True)
        else:
            out = os.path.join(self.media, digest + ext)
            if not os.path.exists(out):
                shutil.copyfile(src, out)
        return os.path.relpath(out, self.site)

    def evidence(self, item_id, ev, idx):
        kind = ev.get("kind", "text")
        cap = esc(ev.get("caption", ""))
        src = os.path.join(self.proof, item_id, ev.get("file", "")) if ev.get("file") else ""
        if kind == "text":
            if ev.get("text"):
                txt = ev["text"]
            elif src and os.path.exists(src):
                txt = open(src, "rb").read().decode("utf-8", errors="replace")
            else:
                return f'<p class="nocap">Evidence missing: {esc(ev.get("file", ""))} {cap}</p>'
            return f'<figure class="ev ev-text"><pre>{esc(clean_text(txt, 12000))}</pre><figcaption>{cap}</figcaption></figure>'
        if not src or not os.path.exists(src):
            return f'<p class="nocap">Evidence missing: {esc(ev.get("file", ""))} {cap}</p>'
        rel = self.convert(src, kind)
        if kind == "image":
            return (f'<figure class="shot"><img class="shot-img" loading="lazy" src="{rel}" alt="{cap}" '
                    f'data-group="{esc(item_id)}" data-index="{idx}" data-caption="{cap}" tabindex="0" role="button">'
                    f'<figcaption>{cap}<a class="openfile" href="{rel}" target="_blank" rel="noopener">open file</a></figcaption></figure>')
        if kind == "audio":
            return (f'<figure class="ev ev-audio"><audio controls preload="none" src="{rel}"></audio>'
                    f'<figcaption>{cap}<a class="openfile" href="{rel}" target="_blank" rel="noopener">open file</a></figcaption></figure>')
        return f'<figure class="ev"><a href="{rel}" target="_blank" rel="noopener">{cap or esc(ev.get("file"))}</a></figure>'

    def card(self, n, it, pr):
        iid = it["id"]
        kind = it.get("kind", "check")
        # A status card reports where something stands; it has no check to have run.
        v = "open" if kind == "decision" else "info" if kind == "info" else pr.get("verdict", "untested")
        prio = esc(it.get("priority", ""))
        tags = "".join(f'<span class="chip">{esc(t)}</span>' for t in it.get("tags", []))
        defects = "".join(
            f'<p class="bug {"fixed" if str(d.get("status", "open")).startswith("fixed") else "open"}"><b>Defect, {esc(d.get("status", "open"))}</b>{esc(d.get("text", ""))}</p>'
            for d in pr.get("defects", []))
        ev_html = "".join(self.evidence(iid, ev, i) for i, ev in enumerate(pr.get("evidence", []) or it.get("evidence", [])))
        if not ev_html and kind != "decision":
            ev_html = '<p class="nocap">No proof attached yet.</p>'
        by = esc(pr.get("by", ""))
        if kind == "decision":
            opts = it.get("options", [])
            btns = "".join(
                f'<button type="button" data-v="{esc(o["id"])}">{esc(o["id"])}. {esc(o.get("label", ""))}{" (recommended)" if o.get("recommended") else ""}</button>'
                for o in opts)
            whys = "".join(f'<dt>{esc(o["id"])}</dt><dd>{esc(o.get("why", ""))}</dd>' for o in opts)
            body = f'<p class="what">{esc(it.get("what", ""))}</p><dl>{whys}</dl>'
            summary = ""
        else:
            btns = ('<button type="button" data-v="ok">Looks right</button>'
                    '<button type="button" data-v="issue">Needs work</button>'
                    '<button type="button" data-v="skip">Skip</button>')
            body = (f'<p class="what">{esc(it.get("what", ""))}</p>'
                    f'<p class="proof"><b>What I did and saw{(" (" + by + ")") if by else ""}</b>{esc(pr.get("summary", "")) or "Not run yet."}</p>'
                    f'{defects}<dl><dt>Where</dt><dd>{esc(it.get("where", ""))}</dd><dt>Passes when</dt><dd>{esc(it.get("check", ""))}</dd>'
                    f'<dt>Gate</dt><dd><code>{esc(it.get("gate", ""))}</code></dd><dt>Source</dt><dd>{esc(it.get("source", ""))}</dd></dl>')
            summary = ""
        return f'''
<article class="card" id="{esc(iid)}" data-id="{esc(iid)}" data-kind="{kind}" data-group="{esc(slug(it.get("group", "")))}" data-my="{esc(v)}" data-prio="{prio}">
  <header class="card-head"><span class="num">{n}</span><h3>{esc(it.get("title", iid))} <span class="iid">{esc(iid)}</span></h3>
    {f'<span class="chip prio-{prio}">{prio}</span>' if prio else ""}{tags}<span class="my my-{esc(v)}">{esc(VERDICT_LABEL.get(v, v))}</span><span class="state" data-state></span></header>
  <div class="card-body{"" if ev_html else " solo"}"><div class="text">{body}</div>{f'<div class="shots">{ev_html}</div>' if ev_html else ""}</div>
  <footer class="verdict"><div class="verdict-row"><div class="btns" role="group" aria-label="Verdict">{btns}</div>
    <textarea id="note-{esc(iid)}" placeholder="{NOTE_HINT[kind == "decision"]}"></textarea><span class="saved" data-saved></span></div></footer>
</article>'''

    def build(self):
        items = self.cards()
        if not items:
            sys.exit("no catalog cards")
        os.makedirs(self.site, exist_ok=True)
        groups = []
        for it in items:
            g = it.get("group", "")
            if g not in groups:
                groups.append(g)
        counts = {k: 0 for k in VERDICT_LABEL}
        body, nav, n = [], [], 0
        for g in groups:
            gid = "g-" + (slug(g) or "all")
            if g:
                nav.append(f'<a href="#{gid}">{esc(g)}</a>')
            body.append(f'<section class="area" id="{gid}">' + (f'<h2>{esc(g)}</h2>' if g else ""))
            for it in [x for x in items if x.get("group", "") == g]:
                n += 1
                pr = self.result(it["id"])
                if pr["verdict"] == "untested" and it.get("automatable") == "human":
                    pr["verdict"] = "human"
                    pr["summary"] = pr["summary"] or "Needs your hands: " + it.get("check", "")
                v = "open" if it.get("kind") == "decision" else pr["verdict"]
                counts[v] = counts.get(v, 0) + 1
                body.append(self.card(n, it, pr))
            body.append("</section>")
        facts = "".join(f'<div class="fact"><b>{esc(k)}</b>{esc(v)}</div>' for k, v in self.cfg["facts"].items())
        tally = " ".join(f'<span class="t-{k}">{c} {VERDICT_LABEL[k].lower()}</span>' for k, c in counts.items() if c)
        decisions_only = all(it.get("kind") == "decision" for it in items)
        bar = DECISION_BAR if decisions_only else PROOF_BAR
        if not decisions_only or self.cfg["round_note"]:
            bar = ROUND_BOX + bar
        page = TEMPLATE.replace("%BAR%", bar).replace("%TITLE%", esc(self.cfg["title"])).replace("%INTRO%", esc(self.cfg["intro"])) \
            .replace("%FACTS%", facts).replace("%ROUND%", esc(self.cfg["round_note"])).replace("%TALLY%", tally) \
            .replace("%TOTAL%", str(n)).replace("%NAV%", "".join(nav)).replace("%BODY%", "".join(body))
        open(os.path.join(self.site, "index.html"), "w").write(page.replace("�", "?"))
        print(f"cards {n}; my verdicts {json.dumps({k: c for k, c in counts.items() if c})}; page {os.path.join(self.site, 'index.html')}")


ROUND_BOX = '<div class="round-note"><p>%ROUND%</p><p class="tally">All %TOTAL% cards: %TALLY%</p></div>\n'
PROOF_BAR = '''<div class="bar">
  <div class="progress"><span data-count="done">0</span>of %TOTAL% judged <span class="ok" data-count="ok">0 right</span><span class="issue" data-count="issue">0 need work</span><span class="skip" data-count="skip">0 skipped</span></div>
  <div class="filters" role="group" aria-label="Filter">
    <button type="button" data-f="all" aria-pressed="true">All</button><button type="button" data-f="open">Not yet judged</button>
    <button type="button" data-f="issue">Needs work</button><button type="button" data-f="ok">Looks right</button>
    <button type="button" data-f="my:fail">My defects</button><button type="button" data-f="my:human">Need your hands</button>
  </div>
'''
DECISION_BAR = '''<div class="bar">
  <div class="progress"><span data-count="done">0</span>of %TOTAL% chosen</div>
  <div class="filters" role="group" aria-label="Filter">
    <button type="button" data-f="all" aria-pressed="true">All</button><button type="button" data-f="open">Not yet chosen</button><button type="button" data-f="chosen">Chosen</button>
  </div>
'''


TEMPLATE = r'''<title>%TITLE%</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e4e1da;--accent:#1f6f8b;--accent-ink:#fff;--ok:#2f7d4f;--issue:#b3462a;--skip:#8a8680;--warn:#b7791f;--chip:#eceae4;--shadow:0 1px 2px rgba(20,18,12,.06),0 8px 24px rgba(20,18,12,.06);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15161a;--panel:#1e2026;--ink:#ecebe6;--muted:#a09d95;--line:#2e3139;--accent:#5fb3d1;--accent-ink:#0f1a1f;--ok:#5fc48a;--issue:#f08a6c;--skip:#8a8f99;--warn:#e0a94a;--chip:#2a2d35;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.3);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15161a;--panel:#1e2026;--ink:#ecebe6;--muted:#a09d95;--line:#2e3139;--accent:#5fb3d1;--accent-ink:#0f1a1f;--ok:#5fc48a;--issue:#f08a6c;--skip:#8a8f99;--warn:#e0a94a;--chip:#2a2d35;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.3);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding-inline:16px;padding-block:0 64px}
h1,h2,h3{text-wrap:balance;margin:0} a{color:var(--accent)} code{font-size:13px;word-break:break-all}
.wrap{max-width:1180px;margin:0 auto}
.hero{padding-block:40px 20px;display:grid;gap:14px} .hero h1{font-size:clamp(28px,4vw,40px);font-weight:800;letter-spacing:-.01em} .hero p{margin:0;max-width:72ch;color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px} .fact{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14px}
.fact b{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.bar{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding-block:10px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.progress{font-weight:700;font-variant-numeric:tabular-nums} .progress span{margin-right:12px} .progress .ok{color:var(--ok)} .progress .issue{color:var(--issue)} .progress .skip{color:var(--skip)}
.filters button{background:var(--chip);border:1px solid transparent;color:var(--ink);border-radius:999px;padding:4px 12px;font:inherit;font-size:14px;cursor:pointer} .filters button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink)}
.jump{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px;padding-block:10px} .jump a{text-decoration:none;color:var(--muted)} .jump a:hover{color:var(--accent)}
.round-note{margin:0;max-width:80ch;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:15px}
.tally{font-weight:700;font-size:14px;margin:8px 0 0;display:flex;flex-wrap:wrap;gap:6px 14px}
.t-pass{color:var(--ok)} .t-fail{color:var(--issue)} .t-partial{color:var(--warn)} .t-human,.t-open{color:var(--accent)} .t-blocked{color:var(--skip)} .t-untested{color:var(--muted)}
.area{padding-block:28px 8px} .area h2{font-size:22px;font-weight:800;margin-bottom:14px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);margin-bottom:18px;overflow:hidden}
.card[data-verdict="ok"]{border-color:var(--ok)} .card[data-verdict="issue"]{border-color:var(--issue)} .card[data-verdict="skip"]{opacity:.75} .card[data-kind="decision"][data-verdict]{border-color:var(--accent)} .card.hidden{display:none}
.card-head{display:flex;align-items:center;gap:8px 12px;padding:14px 18px 8px;flex-wrap:wrap}
.num{font-weight:800;font-size:13px;background:var(--chip);border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums}
.card-head h3{font-size:18px;font-weight:700;flex:1 1 auto;min-width:0} .iid{font-size:12px;color:var(--muted);font-weight:600;margin-left:6px}
.chip{font-size:12px;color:var(--muted);background:var(--chip);border-radius:999px;padding:2px 10px;white-space:nowrap} .chip.prio-P0{color:var(--issue);font-weight:700}
.my{font-size:12px;font-weight:800;border-radius:6px;padding:2px 8px;color:#fff;background:var(--muted)}
.my-pass{background:var(--ok)} .my-fail{background:var(--issue)} .my-partial{background:var(--warn)} .my-human,.my-open{background:var(--accent)} .my-blocked{background:var(--skip)}
.state{font-size:12px;font-weight:700}
.card[data-verdict="ok"] .state::before{content:"Looks right";color:var(--ok)} .card[data-verdict="issue"] .state::before{content:"Needs work";color:var(--issue)} .card[data-verdict="skip"] .state::before{content:"Skipped";color:var(--skip)}
.card[data-kind="decision"][data-verdict] .state::before{content:"Chosen: " attr(data-verdict);color:var(--accent)}
.card-body{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,1.8fr);gap:18px;padding:6px 18px 14px} @media (max-width:820px){.card-body{grid-template-columns:1fr}} .card-body.solo{grid-template-columns:minmax(0,1fr)} .card-body.solo .text{max-width:80ch}
.what{margin:0 0 10px;font-weight:600;white-space:pre-line}
.proof{margin:0 0 10px;font-size:14px;padding:8px 10px;border-left:3px solid var(--accent);background:var(--chip);border-radius:0 8px 8px 0;white-space:pre-wrap}
.proof b,.bug b{font-size:11px;letter-spacing:.08em;text-transform:uppercase;display:block;margin-bottom:2px;white-space:normal}
.bug{margin:0 0 10px;font-size:14px;padding:8px 10px;border-left:3px solid var(--issue);background:var(--chip);border-radius:0 8px 8px 0} .bug.fixed{border-left-color:var(--ok)} .bug.fixed b{color:var(--ok)} .bug.open b{color:var(--issue)}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:14px} dt{color:var(--muted);font-size:12px;letter-spacing:.06em;text-transform:uppercase;padding-top:3px} dd{margin:0}
.shots{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start} .shot{margin:0;flex:1 1 480px;min-width:280px;max-width:100%}
.shot img{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:8px;background:#000;cursor:zoom-in}
.shot figcaption,.ev figcaption{font-size:13px;color:var(--muted);margin-top:4px;display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px} .openfile{font-size:12px;margin-left:auto}
.ev{margin:0;flex:1 1 100%} .ev-audio audio{width:100%} .ev-text pre{margin:0;font-size:12px;line-height:1.35;background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.nocap{font-size:14px;color:var(--muted);margin:0;padding:10px 12px;border:1px dashed var(--line);border-radius:8px;flex:1 1 100%}
.verdict{border-top:1px solid var(--line);padding:12px 18px} .verdict-row{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}
.btns{display:flex;gap:6px;flex-wrap:wrap} .btns button{font:inherit;font-size:14px;font-weight:600;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;min-height:44px} .card[data-kind="decision"] .btns{flex-direction:column;align-items:stretch} .card[data-kind="decision"] .btns button{text-align:left;white-space:normal}
.btns button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)} .btns button[data-v="ok"][aria-pressed="true"]{background:var(--ok);border-color:var(--ok);color:#fff} .btns button[data-v="issue"][aria-pressed="true"]{background:var(--issue);border-color:var(--issue);color:#fff} .btns button[data-v="skip"][aria-pressed="true"]{background:var(--skip);border-color:var(--skip);color:#fff}
textarea{box-sizing:border-box;width:100%;min-height:72px;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);resize:vertical}
.saved{font-size:12px;color:var(--muted);text-align:right;min-height:1em} .offline{font-size:13px;color:var(--issue)}
.lb{position:fixed;inset:0;z-index:50;background:rgba(10,9,7,.92);display:flex;align-items:center;justify-content:center} .lb[hidden]{display:none}
.lb-frame{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden} .lb.zoomed .lb-frame{overflow:auto;align-items:flex-start;justify-content:flex-start}
.lb-frame img{max-width:100vw;max-height:100vh;object-fit:contain;cursor:zoom-in} .lb.zoomed .lb-frame img{max-width:none;max-height:none;cursor:zoom-out}
.lb-cap{position:absolute;left:0;right:0;bottom:0;padding:10px 56px 14px 16px;color:#f3f1ec;font-size:14px;background:linear-gradient(transparent,rgba(0,0,0,.55));pointer-events:none}
.lb-close,.lb-prev,.lb-next{position:absolute;background:rgba(0,0,0,.5);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:999px;width:44px;height:44px;font-size:20px;cursor:pointer}
.lb-close{top:12px;right:12px} .lb-prev{left:12px;top:50%;transform:translateY(-50%)} .lb-next{right:12px;top:50%;transform:translateY(-50%)}
</style>
<div class="wrap">
<header class="hero"><h1>%TITLE%</h1><p>%INTRO%</p><div class="facts">%FACTS%</div></header>
%BAR%
  <span class="offline" data-offline hidden>Verdicts are not saving in this view. Keep going, I will read them from your notes.</span>
</div>
<nav class="jump" aria-label="Groups">%NAV%</nav>
%BODY%
</div>
<div class="lb" data-lb hidden role="dialog" aria-modal="true" aria-label="Screenshot viewer">
  <div class="lb-frame" data-lb-frame><img data-lb-img src="" alt=""></div><div class="lb-cap" data-lb-cap></div>
  <button type="button" class="lb-prev" data-lb-prev aria-label="Previous">&#8249;</button><button type="button" class="lb-next" data-lb-next aria-label="Next">&#8250;</button><button type="button" class="lb-close" data-lb-close aria-label="Close">&times;</button>
</div>
<script>
(() => {
  const cards = [...document.querySelectorAll(".card")];
  const state = new Map();
  let db = null, hydrated = false, filter = "all";
  const pending = [], writing = new Map();
  const counts = () => {
    const c = {ok:0, issue:0, skip:0, chosen:0};
    for (const [id, v] of state) { const card = cards.find(x => x.dataset.id === id); if (!v.verdict) continue; if (card && card.dataset.kind === "decision") c.chosen++; else if (c[v.verdict] !== undefined) c[v.verdict]++; }
    const put = (k, t) => { const el = document.querySelector('[data-count="' + k + '"]'); if (el) el.textContent = t; };
    put("done", c.ok + c.issue + c.skip + c.chosen);
    put("ok", c.ok + " right"); put("issue", c.issue + " need work"); put("skip", c.skip + " skipped");
  };
  const paint = (card, v) => {
    if (v.verdict) card.dataset.verdict = v.verdict; else delete card.dataset.verdict;
    for (const b of card.querySelectorAll(".btns button")) b.setAttribute("aria-pressed", String(b.dataset.v === v.verdict));
    const ta = card.querySelector("textarea");
    if (document.activeElement !== ta && typeof v.note === "string" && ta.value !== v.note) ta.value = v.note;
  };
  const applyFilter = () => {
    for (const card of cards) {
      const v = state.get(card.dataset.id) || {};
      let show = true;
      if (filter === "open") show = !v.verdict;
      else if (filter === "chosen") show = !!v.verdict;
      else if (filter === "issue" || filter === "ok") show = v.verdict === filter;
      else if (filter.startsWith("my:")) show = card.dataset.my === filter.slice(3);
      card.classList.toggle("hidden", !show);
    }
  };
  for (const b of document.querySelectorAll(".filters button")) b.addEventListener("click", () => {
    filter = b.dataset.f;
    for (const o of document.querySelectorAll(".filters button")) o.setAttribute("aria-pressed", String(o === b));
    applyFilter();
  });
  const save = async (card, field) => {
    const id = card.dataset.id, v = state.get(id) || {};
    const saved = card.querySelector("[data-saved]");
    if (!db) { saved.textContent = "not saved"; return; }
    if (!hydrated) { pending.push([card, field]); return; }
    const key = id + ":" + field;
    if (writing.get(key)) { writing.set(key, "again"); return; }
    writing.set(key, "busy");
    try {
      const patch = { id, at: new Date().toISOString() };
      if (field === "verdict") patch.verdict = v.verdict || null; else patch.note = v.note || "";
      await db.doc("verdicts/" + id).update(patch);
      saved.textContent = "saved";
    } catch (e) {
      try { await db.doc("verdicts/" + id).set({ id, verdict: v.verdict || null, note: v.note || "", at: new Date().toISOString() }); saved.textContent = "saved"; }
      catch (e2) { saved.textContent = "not saved"; }
    }
    const again = writing.get(key) === "again"; writing.delete(key);
    if (again) save(card, field);
  };
  for (const card of cards) {
    const id = card.dataset.id;
    state.set(id, {});
    for (const b of card.querySelectorAll(".btns button")) b.addEventListener("click", () => {
      const v = state.get(id);
      v.verdict = v.verdict === b.dataset.v ? null : b.dataset.v;
      paint(card, v); counts(); applyFilter(); save(card, "verdict");
    });
    const ta = card.querySelector("textarea");
    ta.addEventListener("change", (ev) => {
      if (!ev.isTrusted || !hydrated) return;
      const v = state.get(id); if (v.note !== ta.value) { v.note = ta.value; save(card, "note"); }
    });
  }
  const boot = async () => {
    try { db = await window.claude?.use?.("db"); } catch { db = null; }
    if (!db) { document.querySelector("[data-offline]").hidden = false; return; }
    db.collection("verdicts").onSnapshot((snap) => {
      for (const d of snap.docs) {
        const data = d.data(); if (!data) continue;
        const id = String(data.id);
        const card = cards.find((c) => c.dataset.id === id); if (!card) continue;
        const cur = state.get(id);
        if (snap.metadata.hasPendingWrites && (writing.get(id + ":verdict") || writing.get(id + ":note"))) continue;
        cur.verdict = data.verdict || null; cur.note = data.note || "";
        paint(card, cur);
      }
      counts(); applyFilter();
      if (!hydrated) { hydrated = true; pending.splice(0).forEach(([c, f]) => save(c, f)); }
    }, () => { document.querySelector("[data-offline]").hidden = false; });
  };
  boot();
  const lb = document.querySelector("[data-lb]"), frame = document.querySelector("[data-lb-frame]"), lbImg = document.querySelector("[data-lb-img]"), lbCap = document.querySelector("[data-lb-cap]");
  const groups = {};
  for (const img of document.querySelectorAll(".shot-img")) (groups[img.dataset.group] = groups[img.dataset.group] || []).push(img);
  const s = {group:null, index:0};
  const render = () => { const list = groups[s.group]; const it = list[s.index]; lbImg.src = it.src; lbImg.alt = it.dataset.caption || ""; lbCap.textContent = (it.dataset.caption || "") + (list.length > 1 ? ` (${s.index+1}/${list.length})` : ""); frame.scrollTop = 0; frame.scrollLeft = 0; };
  const openLB = (g, i) => { s.group = g; s.index = i; lb.classList.remove("zoomed"); render(); lb.hidden = false; document.body.style.overflow = "hidden"; };
  const closeLB = () => { lb.hidden = true; document.body.style.overflow = ""; };
  const step = (d) => { const list = groups[s.group]; s.index = ((s.index + d) % list.length + list.length) % list.length; lb.classList.remove("zoomed"); render(); };
  for (const img of document.querySelectorAll(".shot-img")) { const open = () => openLB(img.dataset.group, Number(img.dataset.index)); img.addEventListener("click", open); img.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }); }
  lbImg.addEventListener("click", (e) => { e.stopPropagation(); lb.classList.toggle("zoomed"); });
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLB(); });
  document.querySelector("[data-lb-close]").addEventListener("click", closeLB);
  document.querySelector("[data-lb-prev]").addEventListener("click", () => step(-1));
  document.querySelector("[data-lb-next]").addEventListener("click", () => step(1));
  document.addEventListener("keydown", (e) => { if (lb.hidden) return; if (e.key === "Escape") closeLB(); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); });
})();
</script>'''

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    Board(os.path.abspath(sys.argv[1])).build()
