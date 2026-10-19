// Minimal emulation of a Discourse topic page, enough to exercise the userscript:
// - post-stream DOM shaped like Discourse's Post component;
// - cloaking copied from post-stream-viewport-tracker.js (IntersectionObserver margin of one
//   viewport, boundaries by post-number range, render in rAF + microtask like Glimmer);
// - controller:topic model, service:keyboard-shortcuts with _moveSelection/_findArticles
//   ported from services/keyboard-shortcuts.js.
// Query parameters: total, initial, from (first loaded post), imgParent (a parent post kept in
// the model but not rendered, with an image in its cooked HTML).
(() => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const words = '的 一 是 在 不 了 有 和 人 这 中 大 为 上 个 国 我 以 要 他 时 来 用 们 生 到 作 地 于 出 就 分 对 成 会 可 主 发 年 动 同 工 也 能 下 过 子 说 产 种 面 而 方 后 多 定 行 学 法 所 民 得 经'.split(' ');
  const para = () => Array.from({ length: 20 + Math.floor(rnd() * 120) }, () => words[Math.floor(rnd() * words.length)]).join('');
  const TOTAL = Number(new URLSearchParams(location.search).get('total') || 130);
  const INITIAL = Number(new URLSearchParams(location.search).get('initial') || 100);
  const FROM = Number(new URLSearchParams(location.search).get('from') || 1);
  const all = [];
  for (let n = 1; n <= TOTAL; n++) {
    let parent = null;
    if (n > 3 && rnd() < 0.65) parent = Math.max(2, n - 1 - Math.floor(rnd() * rnd() * Math.min(n - 2, 40)));
    if (n > 100 && rnd() < 0.5) parent = 2 + Math.floor(rnd() * 30); // late replies to early posts
    const user = n === 1 || rnd() < 0.12 ? 'op' : 'user' + (1 + Math.floor(rnd() * 25));
    all.push({ id: 1000 + n, post_number: n, reply_to_post_number: parent, username: user, name: user.toUpperCase(),
      cooked: Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => `<p>${para()}</p>`).join(''), reply_to_user: null });
  }
  // A parent that is in the model but never rendered, with an image in its cooked HTML.
  const IMG_PARENT = Number(new URLSearchParams(location.search).get('imgParent') || 0);
  if (IMG_PARENT) all[IMG_PARENT - 1].cooked += `<p><img src="/img/${IMG_PARENT}.png" alt=""></p>`;
  for (const p of all) if (p.reply_to_post_number) { const q = all[p.reply_to_post_number - 1]; p.reply_to_user = { username: q.username, name: q.name }; }
  window.mockPosts = all;
  const loaded = all.slice(FROM - 1, INITIAL);
  const TOPIC_ID = Number(location.pathname.split('/').filter(Boolean)[2]) || 123;
  const model = { id: TOPIC_ID, posts_count: TOTAL, highest_post_number: TOTAL, postStream: { posts: loaded, filteredPostsCount: TOTAL } };
  window.Discourse = { lookup: name => name === 'controller:topic' ? { model } : name === 'service:keyboard-shortcuts' ? keyboard : null };

  const mobile = innerWidth <= 640;
  const stream = document.querySelector('.post-stream');
  const sentinel = document.createElement('div');
  sentinel.className = 'load-more-sentinel';
  sentinel.style.height = '1px';
  stream.append(sentinel);
  const wrappers = new Map();
  const classes = p => ['topic-post', 'clearfix', mobile ? '' : 'post--sticky-avatar sticky-avatar', p.username === 'op' ? 'post--topic-owner topic-owner' : '', 'regular'].filter(Boolean).join(' ');
  function article(p) {
    const a = document.createElement('article');
    a.className = 'boxed onscreen-post';
    a.dataset.postId = p.id;
    a.innerHTML = `<div class="post__row row"><div class="topic-avatar"><a class="trigger-user-card"><img class="avatar" width="48" height="48" alt=""></a></div>` +
      `<div class="topic-body clearfix"><div class="topic-meta-data"><div class="names trigger-user-card"><span class="first username"><a>${p.name}</a></span><span class="second username">${p.username}</span></div><div class="post-infos"><div class="post-info post-date">1天</div></div></div>` +
      `<div class="regular contents"><div class="cooked">${p.cooked}</div>` +
      (p.post_number === 1 ? `<div class="topic-map"><div class="topic-map__stats"><span>浏览 100</span><div class="topic-map__users-list">用户</div></div></div>` : '') +
      `<section class="post-menu-area clearfix"><nav class="post-controls"><div class="actions"><button class="btn">赞</button><button class="btn">回复</button></div></nav></section></div></div></div>`;
    return a;
  }
  function wrapper(p) {
    const w = document.createElement('div');
    w.className = classes(p);
    w.dataset.postNumber = p.post_number;
    w.append(article(p));
    wrappers.set(p.post_number, w);
    return w;
  }

  const cloakStyle = new Map(), uncloaked = new Set(), onScreen = new Set();
  const cloaked = new Set();
  let above = 0, below = 0, debounce = 0;
  window.mockStats = { renders: 0, cloaks: 0, uncloaks: 0 };
  const cloakIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      const n = Number(e.target.dataset.postNumber);
      if (e.isIntersecting) {
        if ((e.intersectionRect.height >= 1 && e.intersectionRatio >= 0.05) || e.intersectionRect.height >= 5) { uncloaked.add(n); cloakStyle.delete(n); }
      } else {
        uncloaked.delete(n);
        cloakStyle.set(n, { height: e.target.getBoundingClientRect().height, margin: getComputedStyle(e.target).margin });
      }
    }
    clearTimeout(debounce);
    debounce = setTimeout(updateBoundaries, 10);
  }, { rootMargin: `${Math.ceil(innerHeight)}px 0px`, threshold: [0, 0.05, 1] });
  const screenIO = new IntersectionObserver(entries => {
    for (const e of entries) { const n = Number(e.target.dataset.postNumber); if (e.isIntersecting) onScreen.add(n); else onScreen.delete(n); }
  }, { threshold: 0 });
  function updateBoundaries() {
    const nums = [...uncloaked];
    let a = nums[0] || 0, b = a;
    for (const x of nums) { a = Math.min(a, x); b = Math.max(b, x); }
    requestAnimationFrame(() => {
      if (a === above && b === below) return;
      above = a; below = b;
      queueMicrotask(render);
    });
  }
  function render() {
    mockStats.renders++;
    for (const p of model.postStream.posts) {
      const n = p.post_number, w = wrappers.get(n), style = cloakStyle.get(n);
      if (!w) continue;
      const cloak = !!style && !onScreen.has(n) && (n < above || n > below);
      if (cloak && !cloaked.has(n)) {
        cloaked.add(n); mockStats.cloaks++;
        w.className = 'post-stream--cloaked';
        w.setAttribute('style', `height:${style.height}px !important;margin:${style.margin} !important;box-sizing: border-box !important;`);
        w.querySelector(':scope > article')?.remove();
      } else if (!cloak && cloaked.has(n)) {
        cloaked.delete(n); mockStats.uncloaks++;
        w.className = classes(p);
        w.removeAttribute('style');
        w.append(article(p));
      }
    }
  }
  for (const p of loaded) { if (p.post_number !== IMG_PARENT) stream.insertBefore(wrapper(p), sentinel); }
  for (const w of wrappers.values()) { cloakIO.observe(w); screenIO.observe(w); }
  // Emulates loadMoreBelow: model updated, Glimmer appends new wrappers in one render.
  // Emulates PostStream#loadMoreAbove: captureAnchor before insert, scrollBy(shift) after, then afterRender pass.
  window.prependPosts = (k, compensateFirst) => {
    const first = model.postStream.posts[0].post_number;
    const add = all.slice(Math.max(0, first - 1 - k), first - 1);
    const anchorEl = [...onScreen].sort((a, b) => a - b).map(n => wrappers.get(n))[0];
    const anchorTop = anchorEl?.getBoundingClientRect().top;
    model.postStream.posts = add.concat(model.postStream.posts);
    const firstEl = wrappers.get(first);
    const compensate = () => { if (anchorTop == null) return; const shift = anchorEl.getBoundingClientRect().top - anchorTop; if (shift !== 0) { window.scrollBy(0, shift); mockStats.discourseShift = (mockStats.discourseShift || 0) + shift; } };
    queueMicrotask(() => {
      for (const p of add) { const w = wrapper(p); stream.insertBefore(w, firstEl); cloakIO.observe(w); screenIO.observe(w); }
      if (compensateFirst) compensate(); else queueMicrotask(() => queueMicrotask(compensate));
    });
    return add.length;
  };
  window.appendPosts = k => {
    const start = all.indexOf(model.postStream.posts.at(-1)) + 1;
    const add = all.slice(start, start + k);
    model.postStream.posts = model.postStream.posts.concat(add);
    queueMicrotask(() => {
      for (const p of add) { const w = wrapper(p); stream.insertBefore(w, sentinel); cloakIO.observe(w); screenIO.observe(w); }
    });
    return add.length;
  };

  // Keyboard shortcuts j/k: _moveSelection is Discourse's code with imports inlined
  // (headerOffset, domUtils.offset, appEvents) and instant instead of smooth scrolling.
  const animationDuration = 100;
  const headerOffset = () => 60;
  const offsetTop = element => element.getBoundingClientRect().top + window.scrollY;
  const keyboard = {
    _lastMoveTime: 0,
    _findArticles() {
      if (document.querySelector('.posts-wrapper')) {
        return document.querySelectorAll('.posts-wrapper .topic-post, .posts-wrapper .post-stream--cloaked, .topic-list tbody tr');
      }
    },
    _scrollTo(scrollTop) { window.scrollTo({ top: scrollTop, behavior: 'auto' }); },
    selectDown() { this._moveSelection({ direction: 1, scrollWithinPosts: true }); },
    selectUp() { this._moveSelection({ direction: -1, scrollWithinPosts: true }); },
    _moveSelection({ direction, scrollWithinPosts }) {
      const now = +new Date();
      const fast = this._lastMoveTime && now - this._lastMoveTime < 1.5 * animationDuration;
      this._lastMoveTime = now;
      let articles = this._findArticles();
      if (articles === undefined) return;
      articles = Array.from(articles);
      let selected = articles.find(element => element.classList.contains('selected'));
      if (selected && !fast) {
        const rect = selected.getBoundingClientRect();
        if (rect.bottom < headerOffset() || rect.top > window.innerHeight) selected = null;
      }
      if (!selected) {
        const offset = headerOffset();
        selected = articles.find(article => direction > 0 ? article.getBoundingClientRect().top >= offset : article.getBoundingClientRect().bottom >= offset);
        if (!selected) selected = articles[articles.length - 1];
        direction = 0;
      }
      const index = articles.indexOf(selected);
      let article = selected;
      if (!fast && direction !== 0 && article && scrollWithinPosts) {
        const beginArticle = article.classList.contains('topic-post') && article.querySelector('#post_1') ? 0 : offsetTop(article);
        const endArticle = offsetTop(article) + article.offsetHeight;
        const beginScreen = window.scrollY;
        const endScreen = beginScreen + window.innerHeight;
        if (direction < 0 && beginScreen > beginArticle) {
          return this._scrollTo(Math.max(beginScreen - window.innerHeight + 3 * headerOffset(), beginArticle - headerOffset()));
        } else if (direction > 0 && endScreen < endArticle - headerOffset()) {
          return this._scrollTo(Math.min(endScreen - 3 * headerOffset(), endArticle - window.innerHeight));
        }
      }
      if (!selected) {
        if (direction === -1 && index === 0) return;
        if (direction === 1 && index === articles.length - 1) return;
      }
      let newIndex = index;
      while (true) {
        newIndex += direction;
        article = articles[newIndex];
        if (!article) return;
        if (article.getBoundingClientRect().height > 0) break;
        if (direction === 0) break;
      }
      for (const a of articles) { a.classList.remove('selected'); a.removeAttribute('tabindex'); }
      article.classList.add('selected');
      article.setAttribute('tabindex', '0');
      article.focus();
      const articleTop = offsetTop(article), articleTopPosition = articleTop - headerOffset();
      if (scrollWithinPosts && !fast && direction < 0 && article.offsetHeight > window.innerHeight) {
        return this._scrollTo(articleTop + article.offsetHeight - window.innerHeight);
      } else if (article.classList.contains('topic-post')) {
        return this._scrollTo(article.querySelector('#post_1') ? 0 : articleTopPosition);
      }
    },
  };
  document.addEventListener('keydown', event => {
    if (event.target.closest?.('input, textarea')) return;
    if (event.key === 'j') keyboard.selectDown();
    if (event.key === 'k') keyboard.selectUp();
  });
})();
