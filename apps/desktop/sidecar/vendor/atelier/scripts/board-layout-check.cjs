#!/usr/bin/env node
// Renders a generated board at desktop and phone width and fails when any
// card's note field is narrower than 80 % of its card footer.
// Needs ATELIER_PLAYWRIGHT_CORE (path to a playwright-core module) and
// ATELIER_HEADLESS_SHELL (a Chromium headless shell binary).
const { chromium } = require(process.env.ATELIER_PLAYWRIGHT_CORE);
(async () => {
  const page = process.argv[2];
  const browser = await chromium.launch({ executablePath: process.env.ATELIER_HEADLESS_SHELL });
  let bad = 0;
  for (const width of [1280, 390]) {
    const p = await browser.newPage({ viewport: { width, height: 1200 } });
    await p.goto('file://' + page);
    const rows = await p.$$eval('article.card', cs => cs.map(c => {
      const note = c.querySelector('textarea').getBoundingClientRect().width;
      const foot = c.querySelector('.verdict').getBoundingClientRect().width;
      return { id: c.dataset.id, ratio: note / foot };
    }));
    for (const r of rows) {
      const ok = r.ratio >= 0.8;
      if (!ok) bad++;
      console.log(`${width}px ${r.id} note/footer ${r.ratio.toFixed(2)} ${ok ? 'ok' : 'TOO NARROW'}`);
    }
    await p.close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
