// Flicker and jump checks. Scrolls the mock topic in fixed steps and samples after every paint:
// - every visible, expanded reply must already carry its decorations (depth attribute, "回复 xxx",
//   楼主 tag, connector line, auto quote in quote mode);
// - visible posts must move exactly by the scroll distance (no layout jumps).
// Discourse collapses posts far from the viewport and re-renders them when they come back, so
// this exercises the re-render path continuously.
const { setup, check, finish } = require('./lib');

// Runs in the page.
function drive({ step, frames, mode, idleFrames = 0, appendAt = -1, appendCount = 0, prependAt = -1, prependCount = 0, compensateFirst = false, inFrame = false }) {
  const stream = document.querySelector('.post-stream');
  const byNumber = new Map(window.mockPosts.map(p => [p.post_number, p]));
  const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const scrollInFrame = (dy, done) => requestAnimationFrame(() => { const y = scrollY; window.scrollBy(0, dy); done(scrollY - y); });
  // Frames before a prepend are skipped: in that state parents are genuinely missing.
  const countFrom = prependAt >= 0 ? prependAt + 2 : 0;
  const stats = { badFrames: 0, missing: {}, anchorJump: 0, maxJump: 0 };
  const miss = key => { stats.missing[key] = (stats.missing[key] || 0) + 1; return true; };
  const sample = i => {
    const tops = new Map();
    let bad = false;
    for (const w of stream.querySelectorAll(':scope > [data-post-number]')) {
      const r = w.getBoundingClientRect();
      if (!(r.height && r.bottom > 60 && r.top < innerHeight)) continue;
      const n = Number(w.dataset.postNumber);
      tops.set(n, r.top);
      if (i < countFrom || n === 1 || w.classList.contains('post-stream--cloaked')) continue;
      const p = byNumber.get(n);
      if (!w.hasAttribute('data-ldt-depth')) bad = miss('depth');
      if (p.reply_to_post_number > 1) {
        if (mode === 'thread' && !w.querySelector('.ldt-relation')) bad = miss('relation');
        if (mode === 'quote' && !w.querySelector('.ldt-auto-quote')) bad = miss('quote');
        const parent = stream.querySelector(`:scope > [data-post-number="${p.reply_to_post_number}"]`);
        if (mode === 'thread' && parent && !stream.querySelector(`.ldt-connectors path[data-ldt-child="${n}"]`)) bad = miss('connector');
      }
      if (p.username === 'op' && !w.querySelector('.ldt-owner-label')) bad = miss('owner');
    }
    return { tops, bad };
  };
  return (async () => {
    let prev = null, moved = 0;
    for (let i = 0; i < frames; i++) {
      await nextPaint();
      const snap = sample(i);
      if (snap.bad) stats.badFrames++;
      if (prev) {
        const common = [...prev.tops.keys()].filter(n => snap.tops.has(n));
        const anchor = common.sort((a, b) => prev.tops.get(a) - prev.tops.get(b))[0];
        for (const n of common) stats.maxJump = Math.max(stats.maxJump, Math.abs(snap.tops.get(n) - prev.tops.get(n) + moved));
        if (anchor !== undefined) stats.anchorJump = Math.max(stats.anchorJump, Math.abs(snap.tops.get(anchor) - prev.tops.get(anchor) + moved));
      }
      prev = snap;
      if (i === appendAt) window.appendPosts(appendCount);
      if (i === prependAt) window.prependPosts(prependCount, compensateFirst);
      if (inFrame && i >= idleFrames) { moved = await new Promise(r => scrollInFrame(step, r)); await new Promise(r => setTimeout(r, 0)); continue; }
      const y = scrollY;
      if (i >= idleFrames) window.scrollBy(0, step);
      moved = scrollY - y;
    }
    stats.errors = window.__errors;
    return stats;
  })();
}

const desktop = { width: 1280, height: 900 }, mobile = { width: 390, height: 844 };
// moves: visible replies may legitimately move when their parents load (re-parenting).
const scenarios = [
  { name: '电脑 楼中楼 向下滚', viewport: desktop, mode: 'thread', step: 90, frames: 200 },
  { name: '电脑 楼中楼 向上滚', viewport: desktop, mode: 'thread', step: -90, frames: 200, start: 'bottom' },
  { name: '手机 楼中楼 向下滚', viewport: mobile, mode: 'thread', step: 90, frames: 240 },
  { name: '手机 楼中楼 向上滚', viewport: mobile, mode: 'thread', step: -90, frames: 240, start: 'bottom' },
  { name: '电脑 引用 向上滚', viewport: desktop, mode: 'quote', step: -90, frames: 200, start: 'bottom' },
  { name: '手机 引用 向上滚', viewport: mobile, mode: 'quote', step: -90, frames: 240, start: 'bottom' },
  { name: '手机 楼中楼 向上滚（帧内滚动）', viewport: mobile, mode: 'thread', step: -90, frames: 200, start: 'bottom', inFrame: true },
  { name: '电脑 加载后面的楼层', viewport: desktop, mode: 'thread', step: 0, frames: 40, start: 'middle', appendAt: 5, appendCount: 30, idleFrames: 1e9 },
  { name: '电脑 加载前面的楼层（论坛先补偿）', query: '?from=45', viewport: desktop, mode: 'thread', step: 0, frames: 40, start: 'nearTop', prependAt: 5, prependCount: 44, compensateFirst: true, idleFrames: 1e9, moves: true },
  { name: '电脑 加载前面的楼层（论坛后补偿）', query: '?from=45', viewport: desktop, mode: 'thread', step: 0, frames: 40, start: 'nearTop', prependAt: 5, prependCount: 44, idleFrames: 1e9, moves: true },
  { name: '手机 加载前面的楼层', query: '?from=45', viewport: mobile, mode: 'thread', step: 0, frames: 40, start: 'nearTop', prependAt: 5, prependCount: 44, compensateFirst: true, idleFrames: 1e9, moves: true },
  { name: '电脑 引用 加载前面的楼层', query: '?from=45', viewport: desktop, mode: 'quote', step: 0, frames: 40, start: 'nearTop', prependAt: 5, prependCount: 44, idleFrames: 1e9, moves: true },
];

(async () => {
  const ctx = await setup();
  for (const sc of scenarios) {
    const page = await ctx.open({ url: `/t/topic/123${sc.query || ''}`, mode: sc.mode, viewport: sc.viewport });
    if (sc.start === 'nearTop') await page.evaluate(async () => { window.scrollTo(0, 600); await new Promise(r => setTimeout(r, 400)); });
    if (sc.start === 'bottom' || sc.start === 'middle') {
      // Walk there so posts behind us get collapsed like on the real site.
      await page.evaluate(async target => {
        const goal = () => target === 'bottom' ? document.documentElement.scrollHeight : document.documentElement.scrollHeight * 0.45;
        while (scrollY + innerHeight < goal() - 5) {
          window.scrollBy(0, 400);
          await new Promise(r => setTimeout(r, 30));
          if (target === 'middle' && scrollY > goal() - innerHeight) break;
        }
        await new Promise(r => setTimeout(r, 400));
      }, sc.start);
    }
    const r = await page.evaluate(drive, sc);
    const detail = { badFrames: r.badFrames, missing: r.missing, anchorJump: +r.anchorJump.toFixed(1), maxJump: +r.maxJump.toFixed(1) };
    check(`${sc.name}：没有缺标注的帧`, r.badFrames === 0, detail);
    check(`${sc.name}：阅读位置不跳`, r.anchorJump <= 1 && (sc.moves || r.maxJump <= 1), detail);
    check(`${sc.name}：没有报错`, r.errors.length === 0, r.errors);
    await page.close();
  }
  await ctx.close();
  finish();
})();
