// Feature checks: mode switching and toggling, progress bar, stored reply records, in-page
// navigation, quote parsing, j/k keyboard order, topic-list unread badges, retrying failed loads.
const { setup, check, finish, nextPaint } = require('./lib');

const day = 864e5;

(async () => {
  const ctx = await setup();
  const now = Date.now();

  // ---- 模式切换、开关、离开再回到帖子、时间线重建
  {
    const page = await ctx.open({});
    const probe = () => page.evaluate(() => {
      const stream = document.querySelector('.post-stream');
      const scrollarea = document.querySelector('.timeline-scrollarea');
      return {
        classes: stream?.className ?? null,
        depth: document.querySelectorAll('[data-ldt-depth]').length,
        relations: document.querySelectorAll('.ldt-relation').length,
        quotes: document.querySelectorAll('.ldt-auto-quote').length,
        lines: document.querySelectorAll('.ldt-connectors path').length,
        modebar: !!document.querySelector('.ldt-modebar'),
        pressed: [...document.querySelectorAll('.ldt-modes .btn')].map(b => b.getAttribute('aria-pressed')).join(','),
        progress: document.documentElement.hasAttribute('data-ldt-progress'),
        nativeHidden: scrollarea ? getComputedStyle(scrollarea).display === 'none' : null,
        panel: !!scrollarea?.nextElementSibling?.classList.contains('ldt-reading-progress'),
        errors: window.__errors.slice(),
      };
    });
    const threadOn = r => r.classes === 'post-stream ldt-active ldt-thread' && r.depth > 0 && r.relations > 0 && r.lines > 0 && r.modebar
      && r.pressed === 'true,false' && r.progress && r.nativeHidden && r.panel;
    let r = await probe();
    check('楼中楼模式正常生效', threadOn(r), r);
    await page.click('.ldt-modes .btn[data-mode="quote"]');
    r = await probe();
    check('切到引用：不再重排，插入引用，恢复原生进度条', r.classes === 'post-stream ldt-active' && r.quotes > 0 && r.lines === 0 && !r.progress && r.nativeHidden === false && r.pressed === 'false,true', r);
    await page.click('.ldt-modes .btn[data-mode="thread"]');
    await nextPaint(page);
    check('切回楼中楼', threadOn(await probe()));
    const rebuilt = await page.evaluate(() => new Promise(resolve => {
      const fresh = document.createElement('div');
      fresh.className = 'timeline-scrollarea';
      fresh.style.height = '280px';
      document.querySelector('.timeline-scrollarea').replaceWith(fresh);
      queueMicrotask(() => queueMicrotask(() => resolve({ hidden: getComputedStyle(fresh).display === 'none', panel: fresh.nextElementSibling?.className || null, height: fresh.nextElementSibling?.style.height })));
    }));
    check('论坛重建时间线：同一帧内隐藏原生进度条、补回阅读进度', rebuilt.hidden && rebuilt.panel === 'ldt-reading-progress' && rebuilt.height === '280px', rebuilt);
    await page.evaluate(() => window.__menu());
    r = await probe();
    check('菜单关闭后不留痕迹', r.classes === 'post-stream' && !r.depth && !r.relations && !r.lines && !r.modebar && !r.progress && r.nativeHidden === false, r);
    await page.evaluate(() => window.__menu());
    check('菜单重新开启', threadOn(await probe()));
    await page.evaluate(() => { window.__stream = document.querySelector('.post-stream'); history.pushState({}, '', '/latest'); window.__stream.remove(); });
    await page.waitForTimeout(50);
    r = await probe();
    check('离开帖子后清理干净', r.classes === null && !r.modebar && !r.progress, r);
    await page.evaluate(() => { history.pushState({}, '', '/t/topic/123'); document.querySelector('.posts-wrapper').append(window.__stream); });
    await page.waitForTimeout(50);
    r = await probe();
    check('回到帖子重新整理', threadOn(r), r);
    check('以上过程没有报错', r.errors.length === 0, r.errors);
    await page.close();
  }

  // ---- 新回复记录清理
  {
    const store = {};
    for (let i = 0; i < 320; i++) store[`topic-updates:${5000 + i}`] = { highest: 10, since: 10, pending: [], seen: [], at: now - i * 2 * 3600e3 };
    for (let i = 0; i < 30; i++) store[`topic-updates:${6000 + i}`] = { highest: 10, since: 10, pending: [], seen: [], at: now - 40 * day };
    for (let i = 0; i < 40; i++) store[`topic-updates:${7000 + i}`] = { highest: 10, since: 10, pending: [], seen: [] };
    const page = await ctx.open({ store });
    await page.waitForTimeout(5500);
    const r = await page.evaluate(() => {
      const ids = [...window.__store.keys()].filter(k => k.startsWith('topic-updates:')).map(k => Number(k.split(':')[1]));
      return { count: ids.length, old: ids.filter(n => n >= 6000 && n < 7000).length, legacy: ids.filter(n => n >= 7000).length,
        oldestKept: Math.max(...ids.filter(n => n >= 5000 && n < 6000)), current: window.__store.get('topic-updates:123'), mode: window.__store.get('reading-mode') };
    });
    check('最多保留 300 个帖子的记录', r.count === 300, r.count);
    check('超过 30 天的记录删除', r.old === 0, r.old);
    check('名额不够时先删没有时间的旧版记录', r.legacy === 0, r.legacy);
    check('保留最近的记录（当前帖子 + 最新 299 个）', !!r.current && r.oldestKept === 5298, { oldestKept: r.oldestKept });
    check('其他设置不受影响', r.mode === 'thread', r.mode);
    await page.close();
  }
  {
    const store = { 'topic-updates:900': 'garbage' };
    for (let i = 0; i < 10; i++) store[`topic-updates:${1000 + i}`] = { highest: 5, since: 5, pending: [], seen: [], at: now - i * day };
    for (let i = 0; i < 5; i++) store[`topic-updates:${2000 + i}`] = { highest: 5, since: 5, pending: [7], seen: [] };
    for (let i = 0; i < 3; i++) store[`topic-updates:${3000 + i}`] = { highest: 5, since: 5, pending: [], seen: [], at: now - 45 * day };
    let page = await ctx.open({ store });
    await page.waitForTimeout(5500);
    const after = await page.evaluate(() => Object.fromEntries(window.__store));
    await page.close();
    check('旧版记录名额够时保留并从现在起算', [0, 1, 2, 3, 4].every(i => Math.abs(after[`topic-updates:${2000 + i}`]?.at - Date.now()) < 60e3));
    check('损坏的记录删除、过期的删除、近期的保留', !('topic-updates:900' in after) && [0, 1, 2].every(i => !after[`topic-updates:${3000 + i}`]) && [...Array(10).keys()].every(i => after[`topic-updates:${1000 + i}`]));
    after['topic-updates:4000'] = { highest: 1, since: 1, pending: [], seen: [], at: now - 50 * day };
    page = await ctx.open({ store: after });
    await page.waitForTimeout(5500);
    check('一天内不重复清理', await page.evaluate(() => window.__store.has('topic-updates:4000')));
    await page.evaluate(() => { window.__writes = []; });
    await page.evaluate(async () => { for (let i = 0; i < 60; i++) { scrollBy(0, 120); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); } });
    const writes = await page.evaluate(() => window.__writes.filter(k => k === 'topic-updates:123').length);
    check('滚动时不会每帧写存储', writes <= 2, writes);
    await page.close();
  }

  // ---- 跳到没加载的楼层：交给论坛站内跳转
  {
    const markProbe = () => {
      for (const w of document.querySelectorAll('.post-stream > [data-post-number]')) {
        const p = window.mockPosts[w.dataset.postNumber - 1];
        const rel = w.querySelector('.ldt-relation');
        if (rel && p.reply_to_post_number && p.reply_to_post_number < 45) { rel.scrollIntoView({ block: 'center' }); rel.id = 'probe'; return p.reply_to_post_number; }
      }
    };
    let page = await ctx.open({ url: '/t/topic/123?from=45', intercept: true });
    const target = await page.evaluate(markProbe);
    await page.waitForTimeout(200);
    await page.click('#probe');
    let r = await page.evaluate(() => ({ routed: window.__routed || ['(整页刷新)'], url: location.pathname, leftover: document.querySelectorAll('.ldt-route').length }));
    check('点"回复 xxx"跳到没加载的楼层：站内跳转', r.routed.at(-1) === `/t/topic/123/${target}` && r.url === '/t/topic/123' && r.leftover === 0, r);
    await page.evaluate(() => { const a = document.createElement('a'); a.className = 'start-date'; a.href = '/t/topic/123/1'; a.textContent = 'start'; document.querySelector('.timeline-container').append(a); });
    await page.click('.timeline-container .start-date');
    r = await page.evaluate(() => ({ routed: window.__routed || ['(整页刷新)'], url: location.pathname }));
    check('点时间线开始日期跳到没加载的首楼：站内跳转', r.routed.at(-1) === '/t/topic/123/1' && r.url === '/t/topic/123', r);
    await page.close();
    page = await ctx.open({ url: '/t/topic/123?from=45' });
    await page.evaluate(markProbe);
    await page.waitForTimeout(200);
    await Promise.all([page.waitForURL(/\/t\/topic\/123\/\d+/, { timeout: 5000 }), page.click('#probe')]).catch(() => {});
    check('论坛没接管时照常打开链接', /\/t\/topic\/123\/\d+/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
    await page.close();
  }

  // ---- 引用模式不下载被回复楼层里的图片
  {
    let page = await ctx.open({});
    const { parent, child } = await page.evaluate(() => {
      const p = window.mockPosts.find(p => p.reply_to_post_number > 2 && p.post_number < 90);
      return { parent: p.reply_to_post_number, child: window.mockPosts.find(q => q.reply_to_post_number === p.reply_to_post_number).post_number };
    });
    await page.close();
    await fetch(`${ctx.base}/__images`);
    page = await ctx.open({ url: `/t/topic/123?imgParent=${parent}`, mode: 'quote' });
    await page.evaluate(n => document.querySelector(`.post-stream > [data-post-number="${n}"]`)?.scrollIntoView(), child);
    await page.waitForTimeout(800);
    const quote = await page.evaluate(n => document.querySelector(`.post-stream > [data-post-number="${n}"] .ldt-auto-quote blockquote`)?.textContent || null, child);
    const images = await (await fetch(`${ctx.base}/__images`)).json();
    check('引用文字照常生成（图片显示为 [图片]）', !!quote && quote.includes('[图片]'), quote?.slice(-20));
    check('没有下载被回复楼层里的图片', images.length === 0, images);
    await page.close();
  }

  // ---- 键盘 j/k 按画面顺序移动
  {
    const page = await ctx.open({});
    const walk = async (key, presses) => {
      const seq = [];
      for (let i = 0; i < presses; i++) {
        await page.keyboard.press(key);
        await page.waitForTimeout(170);
        const hit = await page.evaluate(() => {
          const el = document.querySelector('.post-stream > .selected');
          return el && { n: Number(el.dataset.postNumber), top: el.getBoundingClientRect().top + scrollY };
        });
        if (hit && seq.at(-1)?.n !== hit.n) seq.push(hit);
      }
      return seq;
    };
    const down = await walk('j', 60);
    const downOrdered = down.every((s, i) => !i || s.top > down[i - 1].top);
    check('按 j 依次往下，不跳回前面', down.length >= 10 && downOrdered, down.map(s => s.n).slice(0, 25));
    const up = await walk('k', 25);
    const upOrdered = up.every((s, i) => !i || s.top < up[i - 1].top);
    check('按 k 依次往上', up.length >= 5 && upOrdered, up.map(s => s.n));
    // 首楼折叠时切换栏跟着收起，先回到顶部。
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.click('.ldt-modes .btn[data-mode="quote"]');
    await page.evaluate(() => { document.querySelectorAll('.selected').forEach(n => n.classList.remove('selected')); window.scrollTo(0, 0); });
    const quoteSeq = await walk('j', 15);
    check('引用模式下保持论坛原有的楼号顺序', quoteSeq.length >= 5 && quoteSeq.every((s, i) => !i || s.n > quoteSeq[i - 1].n), quoteSeq.map(s => s.n));
    check('没有报错', (await page.evaluate(() => window.__errors)).length === 0);
    await page.close();
  }

  // ---- 帖子列表上的"未看 N"
  {
    const store = {
      'topic-updates:201': { highest: 60, since: 50, pending: [51, 54], seen: [52, 53], at: now },
      'topic-updates:202': { highest: 100, since: 100, pending: [], seen: [], at: now },
      'topic-updates:203': { highest: 20, since: 10, pending: [11, 12, 13, 14, 15], seen: [], at: now },
      'topic-updates:205': { highest: 40, since: 37, pending: [38, 39, 40], seen: [], at: now },
      'topic-updates:206': { highest: 10, since: 10, pending: [], seen: [], at: now },
    };
    const page = await ctx.open({ url: '/latest', store, intercept: true, before: () => {
      for (const row of [{ id: 201, highest: 65 }, { id: 202, highest: 100 }, { id: 203, highest: 20, unread: 30 }, { id: 204, highest: 9 }, { id: 205, highest: 40, unread: 1 }]) window.addRow(row);
    } });
    const badges = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('tr.topic-list-item')].map(row => {
      const b = row.querySelector('.ldt-unread');
      return [row.dataset.topicId, b ? `${b.textContent}|${b.getAttribute('href')}` : null];
    })));
    let b = await badges();
    check('看过一部分的帖子显示"未看 N"，链接到第一条没看的', b[201] === '未看 7|/t/topic/201/51', b[201]);
    check('都看过的、没记录的不显示', b[202] === null && b[204] === null, { 202: b[202], 204: b[204] });
    check('论坛自己的未读数更大时不显示', b[203] === null, b[203]);
    check('论坛未读数偏少时显示脚本算的', b[205] === '未看 3|/t/topic/205/38', b[205]);
    const sameFrame = await page.evaluate(() => new Promise(resolve => {
      const row = window.addRow({ id: 206, highest: 12 });
      queueMicrotask(() => queueMicrotask(() => resolve(row.querySelector('.ldt-unread')?.textContent || null)));
    }));
    check('论坛新渲染的行在同一帧内补上', sameFrame === '未看 2', sameFrame);
    if (await page.$('tr[data-topic-id="201"] .ldt-unread')) await page.click('tr[data-topic-id="201"] .ldt-unread');
    const routed = await page.evaluate(() => window.__routed || ['(整页刷新)']);
    check('点"未看 N"由论坛站内跳转', routed.at(-1) === '/t/topic/201/51', routed);
    await page.evaluate(() => window.__menu());
    check('菜单关闭后去掉', Object.values(await badges()).every(v => v === null));
    await page.evaluate(() => window.__menu());
    b = await badges();
    check('菜单重新开启后恢复', b[201] === '未看 7|/t/topic/201/51' && b[206] === '未看 2|/t/topic/206/11', b);
    check('没有报错', (await page.evaluate(() => window.__errors)).length === 0);
    await page.close();
  }

  // ---- 补拉被回复楼层：服务器出错时稍后重试，楼层不存在时不再请求
  // 只看页面顶部一直展开着的回复：重试只在需要它的回复展开时发出，折叠的楼层要滚到附近才会再请求。
  {
    const probe = await ctx.open({ url: '/t/topic/124?from=110&initial=130&total=130' });
    const parents = await probe.evaluate(() => {
      const near = new Map();
      for (const p of window.mockPosts) {
        if (p.post_number < 110 || !(p.reply_to_post_number > 1 && p.reply_to_post_number < 110)) continue;
        const top = document.querySelector(`.post-stream > [data-post-number="${p.post_number}"]`).getBoundingClientRect().top + scrollY;
        near.set(p.reply_to_post_number, Math.min(near.get(p.reply_to_post_number) ?? Infinity, top));
      }
      return [...near].filter(([, top]) => top < 2 * innerHeight).sort((a, b) => a[1] - b[1]).map(([n]) => n);
    });
    await probe.close();
    const [gone, ...flaky] = parents;
    for (const n of flaky) await fetch(`${ctx.base}/__fail?path=/t/124/${n}.json&times=1&status=500`);
    await fetch(`${ctx.base}/__fail?path=/t/124/${gone}.json&times=99&status=404`);
    await fetch(`${ctx.base}/__requests?reset=1`);
    const page = await ctx.open({ url: '/t/topic/124?from=110&initial=130&total=130' });
    // 第一轮每秒一个请求，失败的 5 秒后再排队。
    await page.waitForTimeout(30000);
    const requests = await (await fetch(`${ctx.base}/__requests`)).json();
    const labels = await page.evaluate(() => [...document.querySelectorAll('.ldt-relation')].map(n => n.textContent));
    const counts = Object.fromEntries([gone, ...flaky].map(n => [n, requests[`/t/124/${n}.json`] || 0]));
    check('服务器出错的请求过一会儿重试一次，成功后不再请求', flaky.length > 0 && flaky.every(n => counts[n] === 2), counts);
    check('重试成功后"回复 xxx"换成被回复人的名字', flaky.every(n => labels.includes(`回复 SRV${n}`)), labels.slice(0, 8));
    check('楼层不存在（404）时不再重试', counts[gone] === 1, counts[gone]);
    await page.close();
  }

  await ctx.close();
  finish();
})();
