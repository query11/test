// Connector line checks: after every paint while scrolling, each drawn line must end at its
// child's avatar and start at its parent's avatar, including sticky (stuck) avatars on desktop.
const { setup, check, finish } = require('./lib');

(async () => {
  const ctx = await setup();
  for (const [label, viewport] of [['电脑', { width: 1280, height: 900 }], ['手机', { width: 390, height: 844 }]]) {
    const page = await ctx.open({ viewport });
    const r = await page.evaluate(async () => {
      const stream = document.querySelector('.post-stream');
      const sel = ':scope > .boxed > .row > .topic-avatar .avatar';
      const pairs = window.mockPosts.filter(p => p.reply_to_post_number > 1 && stream.querySelector(`:scope > [data-post-number="${p.reply_to_post_number}"]`)
        && stream.querySelector(`:scope > [data-post-number="${p.post_number}"]`)).length;
      const initial = stream.querySelectorAll('.ldt-connectors path').length;
      let checks = 0, worstEnd = 0, worstStart = 0;
      const visible = el => { const r = el.getBoundingClientRect(); return r.bottom > 60 && r.top < innerHeight; };
      const frame = () => {
        const o = stream.getBoundingClientRect();
        for (const path of stream.querySelectorAll('.ldt-connectors path')) {
          const n = path.dataset.ldtChild;
          const child = stream.querySelector(`:scope > [data-post-number="${n}"]`);
          const parent = stream.querySelector(`:scope > [data-post-number="${window.mockPosts[n - 1].reply_to_post_number}"]`);
          // M sx sy H lane V v Q lane y lane+8 y H x
          const [, sy, , , , , , ey, ex] = path.getAttribute('d').match(/-?[\d.]+/g).map(Number);
          const c = child?.querySelector(sel)?.getBoundingClientRect();
          if (c && visible(child)) {
            checks++;
            worstEnd = Math.max(worstEnd, Math.abs(ex - (c.left - o.left - 4)), Math.abs(ey - (c.top - o.top + c.height / 2)));
          }
          const p = parent?.querySelector(sel)?.getBoundingClientRect();
          if (p && c && visible(parent)) {
            const expected = c.left > p.left + 3 ? p.bottom - o.top + 5 : p.top - o.top + p.height / 2;
            worstStart = Math.max(worstStart, Math.abs(sy - expected));
          }
        }
      };
      for (const dir of [1, -1]) for (let i = 0; i < 150; i++) {
        window.scrollBy(0, dir * 100);
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        frame();
      }
      return { pairs, initial, checks, worstEnd, worstStart, errors: window.__errors };
    });
    check(`${label}：一打开所有父子楼层都有连线（含被折叠的）`, r.initial === r.pairs, { lines: r.initial, pairs: r.pairs });
    check(`${label}：滚动中连线终点对准回复的头像`, r.checks > 100 && r.worstEnd <= 1, { checks: r.checks, worst: +r.worstEnd.toFixed(2) });
    check(`${label}：滚动中连线起点对准被回复的头像（含吸顶）`, r.worstStart <= 1, { worst: +r.worstStart.toFixed(2) });
    check(`${label}：没有报错`, r.errors.length === 0, r.errors);
    await page.close();
  }
  await ctx.close();
  finish();
})();
