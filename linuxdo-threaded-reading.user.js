// ==UserScript==
// @name         Linux DO 楼中楼阅读
// @namespace    local.linuxdo.threaded-reading
// @version      4.5.0
// @description  楼中楼递进连线、引用切换、阅读进度和新回复定位，保留原生操作。
// @match        https://linux.do/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  GM_addStyle(`
    .post-stream.ldt-thread { display: flex; flex-direction: column; overflow-anchor: none; }
    .post-stream.ldt-thread > [data-post-number]:not([data-post-number="1"]):not([data-ldt-depth]),
    .post-stream.ldt-thread > :not([data-post-number]):not([data-ldt-rank]):not(.ldt-modebar):not(.ldt-connectors) { order: 1000000; }
    .post-stream.ldt-thread > .ldt-modebar { order: 1; }
    .post-stream.ldt-active .embedded-posts,
    .post-stream.ldt-active .show-replies,
    .post-stream.ldt-active .post__collapse-button,
    .post-stream.ldt-active [data-ldt-depth] .reply-to-tab,
    .post-stream.ldt-thread [data-ldt-depth] .cooked aside.quote { display: none !important; }

    .ldt-active > [data-ldt-depth] .post-menu-area { margin: 6px 0 8px; }
    .ldt-active > [data-ldt-depth] .cooked p:last-of-type { margin-bottom: 0; }
    .ldt-active > [data-ldt-depth] .discourse-boosts__post-menu:not(:has(*)) { padding: 0; }
    .ldt-active > [data-ldt-depth] .names { flex-wrap: wrap; flex-direction: row; align-items: center; gap: 3px 6px; }
    .ldt-active > [data-ldt-depth] .names > .first { order: 0; margin: 0 !important; min-width: 0; overflow-wrap: anywhere; }
    .ldt-active > [data-ldt-depth] .names > .second,
    .ldt-active > [data-ldt-depth] .names > .user-title { order: 2; }
    .ldt-active > [data-ldt-depth] .names > .user-status-message-wrap { order: 1; }
    .ldt-active > .topic-owner[data-ldt-depth] .cooked::after { content: none !important; display: none !important; }
    .ldt-owner-label {
      order: 1; display: inline-flex !important; align-items: center; align-self: center; margin: 0 !important;
      font-size: 10px !important; font-weight: 400; line-height: 14px !important; height: 16px; box-sizing: border-box;
      color: var(--primary-medium, #777); border: 1px solid var(--primary-low, #ddd);
      border-radius: 3px; padding: 0 4px; white-space: nowrap;
    }

    .post-stream.ldt-thread, #ld-drawer-root [data-ldt-sidepeek] { position: relative; }
    .ldt-connectors { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; z-index: 1; }
    .ldt-connectors path { fill: none; stroke: var(--primary-low, #e2e4e7); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

    /* 灰底保持整组连续，内部按父子关系递进，深层缩进设上限。 */
    .post-stream.ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]):not(.post-stream--cloaked) {
      --topic-avatar-width: 28px;
      margin-block: 0; margin-inline-start: 32px !important; padding: 0 12px 0 calc(12px + var(--ldt-indent, 0) * 24px);
      min-width: 0; box-sizing: border-box;
      background: var(--primary-very-low, #f7f8fa);
    }
    .post-stream.ldt-thread > [data-ldt-first] { border-radius: 9px 9px 0 0; margin-top: 8px !important; }
    .post-stream.ldt-thread > [data-ldt-last] { border-radius: 0 0 9px 9px; margin-bottom: 20px !important; padding-bottom: 6px; }
    .post-stream.ldt-thread > [data-ldt-first][data-ldt-last] { border-radius: 9px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .topic-avatar {
      width: 28px; padding: 13px 0 0; margin: 0 !important; border: 0 !important; position: static;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .topic-avatar .avatar { width: 28px; height: 28px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .avatar-flair {
      width: 12px; height: 12px; background-size: 12px; right: -2px; bottom: -2px;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .boxed { padding: 0; border: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .topic-body { padding: 12px 0 9px; border: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .contents { padding-top: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .topic-meta-data { padding: 0 0 4px 10px; gap: 8px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .names {
      flex-wrap: wrap; align-items: center; gap: 3px 7px; min-width: 0; font-size: 13px;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .names .second,
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .names .user-title { display: none; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-date { font-size: 12px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .cooked {
      padding: 2px 0 0 10px; font-size: 15px; line-height: 1.65;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .cooked p { margin: 0 0 .6em; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .cooked > :last-child,
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .cooked p:last-of-type { margin-bottom: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area { margin: 6px 0 0; padding: 0 0 0 10px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area .btn {
      min-height: 30px; padding: 5px 6px; font-size: 12px; color: var(--primary-medium, #777);
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area .d-icon { width: 14px; height: 14px; color: inherit; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area {
      display: grid; grid-template-columns: minmax(0, 1fr) auto;
      align-items: center; column-gap: 10px; row-gap: 0;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-controls { grid-column: 2; grid-row: 1; width: auto; margin: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .actions { display: flex; align-items: center; gap: 4px; float: none; margin: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .small-user-list { grid-column: 1 / -1; grid-row: 2; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .extra-buttons { display: inline-flex; align-items: center; margin: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .accepted-text {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px;
      border: 1px solid color-mix(in srgb, var(--success, #38955b) 15%, var(--secondary, #fff));
      border-radius: 5px; box-sizing: border-box; font-size: 11px !important; line-height: 18px;
      color: color-mix(in srgb, var(--success, #38955b) 40%, var(--primary, #333));
      background: color-mix(in srgb, var(--success, #38955b) 8%, var(--secondary, #fff));
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .accepted-label { font-size: 11px !important; line-height: 18px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .accepted-text .d-icon { width: 12px; height: 12px; color: inherit; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__post-menu { grid-column: 1; grid-row: 1; padding: 0; min-width: 0; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__list { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__bubble {
      display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
      padding: 3px 7px; margin: 0; border: 1px solid var(--primary-low, #ddd);
      border-radius: 5px; background: var(--secondary, #fff); box-shadow: none;
      font-size: 12px; line-height: 18px; box-sizing: border-box;
    }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__bubble > a { display: inline-flex; flex: 0 0 auto; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__bubble .avatar { width: 16px; height: 16px; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__cooked { min-width: 0; font-size: inherit; line-height: inherit; overflow-wrap: anywhere; }
    .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .discourse-boosts__cooked p { margin: 0; }
    .ldt-relation, .ldt-sidepeek-relation { order: 3; margin: 0 !important; padding: 0; border: 0; background: none; text-align: start; font: inherit; font-size: 12px; font-weight: 400; color: var(--primary-medium, #777); line-height: 1.5; overflow-wrap: anywhere; cursor: pointer; }
    .ldt-relation:hover, .ldt-sidepeek-relation:hover { color: var(--tertiary, #3979a3); }
    .ldt-relation:focus-visible, .ldt-sidepeek-relation:focus-visible { outline: 2px solid var(--tertiary, #3979a3); outline-offset: 3px; border-radius: 3px; }
    .post-stream:not(.ldt-thread) .ldt-relation { display: none; }
    .ldt-focus { animation: ldt-focus 1.6s ease-out; }
    @keyframes ldt-focus { from { box-shadow: inset 3px 0 var(--tertiary, #3979a3); } to { box-shadow: inset 3px 0 transparent; } }
    .ldt-updates { position: fixed; right: 24px; bottom: 24px; z-index: 990; padding: 9px 15px; min-height: 40px; border: 1px solid var(--primary-low, #ddd); border-radius: 20px; background: var(--secondary, #fff); color: var(--tertiary, #3979a3); font: inherit; font-size: 13px; box-shadow: 0 3px 14px #0001; cursor: pointer; }
    .ldt-updates:focus-visible { outline: 2px solid var(--tertiary, #3979a3); outline-offset: 3px; }
    body.ld-drawer-page-open > .ldt-updates { display: none; }

    /* SidePeek 智能预览沿用它的递归节点和懒加载，只整理回复区。 */
    #ld-drawer-root [data-ldt-sidepeek] .ld-thread-depth-label,
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-header .ld-post-number,
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-reply-to-tab,
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-reply-to-wrap,
    #ld-drawer-root [data-ldt-sidepeek] [data-thread-post-number]:not([data-thread-post-number="1"]) > .ld-post-body aside.quote { display: none; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-post-card > .ld-inline-thread { position: relative; margin: 12px 16px 20px 32px; padding: 6px 12px; border: 0; border-radius: 9px; background: var(--primary-very-low, #f7f8fa); }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-inline-thread { margin: 0; padding: 0 0 0 var(--ldt-step, 24px); border: 0; background: none; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post { position: relative; min-width: 0; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-thread > .ld-inline-post::before { content: none !important; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post[data-ldt-level="3"] > .ld-inline-thread { --ldt-step: 0px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-body.ld-native-body { padding: 6px 0 8px 38px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-body.ld-native-body .cooked { padding: 0; margin: 0; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-body p:last-child { margin-bottom: 0; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-actions { min-height: 32px; gap: 8px; align-items: center; flex-wrap: wrap; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-actions .ld-post-reply-button { width: 30px; height: 30px; min-height: 30px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-header { gap: 10px; padding: 12px 0 0; align-items: flex-start; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-header .ld-post-avatar { width: 28px; height: 28px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-header .ld-post-author-row { gap: 3px 7px; font-size: 13px; }
    #ld-drawer-root [data-ldt-sidepeek] [data-thread-post-number]:not([data-thread-post-number="1"]) > .ld-post-header .ld-post-author-row > strong { min-width: 0; overflow-wrap: anywhere; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-header .ld-post-username { display: none; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-body { padding: 6px 0 8px 38px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-actions { padding: 0 0 12px 38px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post .ld-post-topic-owner-badge { padding: 0 4px; border-radius: 3px; font-size: 10px; line-height: 16px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-parent-preview [data-thread-post-number] > .ld-post-body aside.quote { display: block; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-boosts { margin: 0 0 12px 38px; padding: 0; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-boosts .discourse-boosts__bubble { margin: 0; padding: 3px 7px; border-radius: 5px; font-size: 12px; }
    #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-post-boosts .avatar { width: 16px; height: 16px; }

    /* 融入原有统计行，不增加独立标题或大号切换面板。 */
    .ldt-modebar { display: inline-flex; align-items: center; margin-inline-start: auto; flex: 0 0 auto; }
    .ldt-modes { display: inline-flex; align-items: center; gap: 14px; }
    .ldt-modes .btn {
      position: relative; min-height: 32px; padding: 5px 0; border: 0;
      background: transparent !important; box-shadow: none !important;
      font-size: 12px; line-height: 1.5; color: var(--primary-medium, #777);
    }
    .ldt-modes .btn[aria-pressed="true"] { color: var(--tertiary, #3979a3); font-weight: 600; }
    .ldt-modes .btn[aria-pressed="true"]::after {
      content: ""; position: absolute; bottom: 2px; left: 0; right: 0;
      height: 2px; border-radius: 2px; background: currentColor;
    }
    .ldt-modes .btn:hover { color: var(--primary, #333); }
    .ldt-modes .btn:focus-visible { outline: 2px solid var(--tertiary, #3979a3); outline-offset: 4px; border-radius: 2px; }
    .topic-map__stats:has(> .ldt-modebar) .topic-map__users-list { min-width: 0; overflow: hidden; }
    .post-stream > .ldt-modebar { justify-content: flex-end; margin: 0; padding: 4px 0; }
    html[data-ldt-progress] .timeline-scrollarea:not(.timeline-fullscreen *) { display: none !important; }
    .ldt-reading-progress { display: flex; flex-direction: column; gap: 8px; height: 300px; width: 140px; max-width: 100%; }
    .ldt-progress-caption, .ldt-progress-total { font-size: 12px; line-height: 1.5; color: var(--primary-medium, #777); }
    .ldt-progress-total { font-size: 11px; }
    .ldt-progress-rail { position: relative; flex: 1; width: 100%; padding: 0; border: 0; background: transparent; touch-action: none; cursor: ns-resize; }
    .ldt-progress-rail::before { content: ""; position: absolute; left: 8px; top: 10px; bottom: 10px; width: 2px; background: var(--primary-low, #ddd); }
    .ldt-progress-fill { position: absolute; left: 8px; top: 10px; width: 2px; height: calc((100% - 20px) * var(--ldt-progress, 0)); background: var(--tertiary, #3979a3); }
    .ldt-progress-handle { position: absolute; left: 6px; top: calc((100% - 20px) * var(--ldt-progress, 0)); width: 6px; height: 20px; border-radius: 4px; background: var(--tertiary, #3979a3); }
    .ldt-progress-percent { position: absolute; left: 23px; top: calc((100% - 20px) * var(--ldt-progress, 0)); font-size: 16px; font-weight: 600; line-height: 20px; color: var(--primary, #333); }
    html[data-ldt-progress] #topic-progress { display: flex; align-items: center; justify-content: center; box-sizing: border-box; height: auto; min-height: 40px; padding: 4px 10px; border: 1px solid var(--primary-low, #ddd); border-radius: 6px; background: var(--secondary, #fff); }
    html[data-ldt-progress] #topic-progress > .nums,
    html[data-ldt-progress] #topic-progress > .bg { display: none !important; }
    .ldt-progress-navigation { display: block; margin-bottom: 6px; color: var(--primary-medium, #777); font-size: 12px; }
    .ldt-progress-mobile { display: block; color: var(--primary, #333); font-size: 12px; font-weight: 600; line-height: 1.5; white-space: nowrap; }
    .ldt-progress-rail:focus-visible { outline: 2px solid var(--tertiary, #3979a3); outline-offset: 3px; border-radius: 4px; }
    .ldt-auto-quote blockquote { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 640px) {
      .ldt-updates { right: auto; left: 50%; transform: translateX(-50%); bottom: calc(62px + env(safe-area-inset-bottom, 0px)); white-space: nowrap; }
      #ld-drawer-root [data-ldt-sidepeek] .ld-post-card > .ld-inline-thread { margin-inline: 24px 10px; padding-inline: 10px; }
      #ld-drawer-root [data-ldt-sidepeek] .ldt-sidepeek-relation { flex-basis: 100%; }
      #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post > .ld-inline-thread { --ldt-step: 12px; }
      #ld-drawer-root [data-ldt-sidepeek] .ld-inline-post[data-ldt-level="3"] > .ld-inline-thread { --ldt-step: 0px; }
      .ldt-thread > [data-ldt-root] .cooked { padding-inline-start: 58px; }
      .ldt-thread > [data-ldt-root] .post-menu-area { margin-inline-start: 58px; }
      .post-stream.ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]):not(.post-stream--cloaked) { margin-inline-start: 28px !important; padding-inline: calc(10px + var(--ldt-indent, 0) * 12px) 10px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .topic-meta-data { padding-inline-start: 0; margin-inline-start: 38px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .cooked { padding-inline-start: 38px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area { padding-inline-start: 38px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area .btn { min-height: 40px; min-width: 36px; font-size: 13px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .ldt-relation { flex-basis: 100%; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area:has(.discourse-boosts__bubble) { grid-template-columns: minmax(0, 1fr); row-gap: 5px; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area:has(.discourse-boosts__bubble) .post-controls { grid-column: 1; grid-row: 2; justify-self: end; max-width: 100%; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .post-menu-area:has(.discourse-boosts__bubble) .small-user-list { grid-row: 3; }
      .ldt-thread > [data-ldt-depth]:not([data-ldt-depth="0"]) .actions { flex-wrap: wrap; justify-content: flex-end; }
      .ldt-modes { gap: 16px; }
      .ldt-modes .btn { min-height: 40px; min-width: 44px; justify-content: center; }
    }
  `);

  let mode = typeof GM_getValue === 'function' ? GM_getValue('reading-mode', 'thread') : 'thread';
  if (!['thread', 'quote'].includes(mode)) mode = 'thread';
  let enabled = true;
  let state;
  let timer;
  let progressFrame;
  let frameLayout = false;
  let connected = new WeakSet();
  const stuckNodes = new Set();
  const connectorLinks = new WeakMap();
  let avatarCache = new WeakMap();
  const avatarKinds = new Map();
  let viewportWidth = window.innerWidth;
  // 脚本自己插入的节点：新增的不必理会；正文里的标注若被别人删掉（例如论坛重绘），要重新补上。
  const UI = '.ldt-connectors, .ldt-updates, .ldt-reading-progress, .ldt-progress-navigation, .ldt-progress-mobile';
  const OWN = `${UI}, .ldt-modebar, .ldt-relation, .ldt-sidepeek-relation, .ldt-owner-label, .ldt-auto-quote`;
  const is = (node, selector) => node.nodeType === 1 && node.matches(selector);
  const foreign = r => !r.target.closest?.(OWN) && (r.type !== 'childList' || [...r.addedNodes].some(n => !is(n, OWN)) || [...r.removedNodes].some(n => !is(n, UI)));
  // 论坛滚动时会折叠、恢复远处楼层并重新渲染内容。回调在同一帧绘制前执行，直接补回整理结果，不留原样闪一下的空档。
  const observer = new MutationObserver(records => {
    let layout = false, progress = false, any = false;
    for (const r of records) {
      if (!foreign(r)) continue;
      any = true;
      const t = r.target;
      if (state && (state.stream.contains(t) || t === state.stream.parentElement) || t.closest?.('#ld-drawer-root')
        || (t === document.body && [...r.addedNodes].some(n => n.id === 'ld-drawer-root'))) { layout = true; break; }
      if (t.closest?.('.timeline-container, #topic-progress-wrapper, #topic-progress')) progress = true;
    }
    if (!any) return;
    const id = enabled ? topicId() : 0;
    const stream = id ? document.querySelector('.post-stream') : null;
    if (layout || stream !== (state?.stream || null) || (state && state.id !== id)) refresh();
    else if (progress && state) updateProgress(state);
  });
  const connectorTargets = new Set();
  // 尺寸变化在布局之后、绘制之前回调，连线和阅读位置当帧更新。
  const connectorResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (state) settle(state);
    updateConnectors();
    scheduleProgress();
  }) : null;
  function watchConnectors(node) {
    if (!connectorResize || connectorTargets.has(node)) return;
    connectorTargets.add(node);
    connectorResize.observe(node);
    for (const target of connectorTargets) if (!target.isConnected) { connectorResize.unobserve(target); connectorTargets.delete(target); }
  }
  const observe = () => observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-reply-display'] });

  function topicId() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 't' ? Number(/^\d+$/.test(parts[1] || '') ? parts[1] : parts[2]) || 0 : 0;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function merge(s, posts) {
    for (const p of posts || []) {
      const number = Number(p?.post_number), parent = Number(p?.reply_to_post_number);
      if (Number.isSafeInteger(number) && number > 0) s.posts.set(number, {
        number, parent: Number.isSafeInteger(parent) && parent > 0 && parent < number ? parent : 0,
        author: p.display_username || p.name || p.username || '', cooked: p.cooked || '',
        parentAuthor: p.reply_to_user?.name || p.reply_to_user?.username || '',
      });
    }
  }

  // 直接复用论坛已加载的数据，评论 DOM 和原生事件保持不变。
  function snapshot(s) {
    try {
      const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const model = page.Discourse?.lookup('controller:topic')?.model;
      if (Number(model?.id) !== s.id) return false;
      s.total = Number(model.postStream?.filteredPostsCount || model.posts_count) || 0;
      s.highest = Number(model.highest_post_number) || s.highest || 0;
      merge(s, model.postStream?.posts);
      return s.posts.size > 0;
    } catch { return false; }
  }

  async function load(s, parent = 0) {
    if (s.requested.has(parent)) return;
    s.requested.add(parent);
    s.queue = s.queue.then(async () => {
      const delay = Math.max(0, s.nextRequest - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (s !== state || s.abort.signal.aborted) return;
      s.nextRequest = Date.now() + 1000;
      try {
        const response = await fetch(parent ? `/t/${s.id}/${parent}.json` : `/t/${s.id}.json`, {
          credentials: 'same-origin', signal: s.abort.signal,
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok) return;
        const data = await response.json();
        if (s !== state) return;
        s.total = Number(data.posts_count) || s.total;
        s.highest = Number(data.highest_post_number) || s.highest || 0;
        merge(s, data.post_stream?.posts);
        schedule();
      } catch { /* 权限或网络失败时仍保留原生评论。 */ }
    });
  }

  function layout(s, wrappers) {
    const posts = new Map(s.posts);
    for (const node of wrappers) {
      const n = Number(node.dataset.postNumber);
      if (!posts.has(n)) posts.set(n, { number: n, parent: 0 });
    }
    const ancestry = new Map();
    for (const p of [...posts.values()].sort((a, b) => a.number - b.number)) {
      if (p.number === 1) continue;
      const parent = p.parent > 1 && p.parent < p.number ? ancestry.get(p.parent) : null;
      const position = { depth: parent ? parent.depth + 1 : 0, root: parent?.root || p.number };
      ancestry.set(p.number, position);
    }
    const children = new Map();
    for (const [number, position] of ancestry) {
      const parent = position.depth ? posts.get(number).parent : 0;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(number);
    }
    const result = new Map();
    const pending = [...(children.get(0) || [])].reverse();
    let rank = 2;
    while (pending.length) {
      const number = pending.pop();
      result.set(number, { rank: rank++ * 10, ...ancestry.get(number) });
      const replies = children.get(number) || [];
      for (let i = replies.length - 1; i >= 0; i--) pending.push(replies[i]);
    }
    return result;
  }

  function headerBottom() {
    return Math.max(0, document.querySelector('.d-header')?.getBoundingClientRect().bottom || 0);
  }

  function readingAnchor(s) {
    return [...s.stream.querySelectorAll(':scope > [data-post-number]:not(.post-stream--cloaked)')]
      .filter(node => !s.stream.classList.contains('ldt-active') || node.hasAttribute('data-ldt-depth') || node.dataset.postNumber === '1')
      .map(node => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height && rect.bottom > headerBottom() && rect.top < window.innerHeight)
      .sort((a, b) => a.rect.top - b.rect.top)[0]?.node;
  }

  // 记下当前画面最上方的楼层；之后无论论坛重绘还是本脚本调整，都以它为准保持阅读位置。
  function settle(s) {
    const header = headerBottom();
    let node = s.settled?.node;
    let rect = node?.isConnected ? node.getBoundingClientRect() : null;
    if (!rect?.height || rect.bottom <= header || rect.top > header + 1) {
      node = readingAnchor(s);
      rect = node?.getBoundingClientRect();
    }
    s.settled = node ? { node, top: rect.top, scrollY: window.scrollY } : null;
  }

  function setData(node, key, value) {
    if (value === null) { if (key in node.dataset) delete node.dataset[key]; }
    else if (node.dataset[key] !== value) node.dataset[key] = value;
  }

  function renderedPost(s, number) {
    const node = s.stream.querySelector(`:scope > [data-post-number="${number}"]`);
    return node && !node.classList.contains('post-stream--cloaked') && node.querySelector(':scope > article') ? node : null;
  }

  function jumpToPost(s, number) {
    const node = renderedPost(s, number);
    if (!node) { location.assign(`/t/topic/${s.id}/${number}`); return; }
    window.scrollTo({ top: Math.max(0, node.getBoundingClientRect().top + window.scrollY - headerBottom() - 12), behavior: 'auto' });
    node.classList.remove('ldt-focus');
    requestAnimationFrame(() => node.classList.add('ldt-focus'));
    setTimeout(() => node.classList.remove('ldt-focus'), 1600);
    scheduleProgress();
  }

  function syncUpdates(s) {
    if (!s.posts.size) return;
    const highest = Math.max(s.highest || s.total || 0, ...s.posts.keys());
    if (!s.updates) {
      const stored = typeof GM_getValue === 'function' ? GM_getValue(`topic-updates:${s.id}`, null) : null;
      s.updates = new Set(Array.isArray(stored?.pending) ? stored.pending.filter(Number.isSafeInteger) : []);
      s.lastKnown = Number(stored?.highest) || highest;
      s.since = Number(stored?.since) || s.lastKnown;
      s.seenNew = new Set(Array.isArray(stored?.seen) ? stored.seen.filter(Number.isSafeInteger) : []);
    }
    if (highest > s.lastKnown) s.updates.add(highest);
    for (const number of s.posts.keys()) if (number > s.since && !s.seenNew.has(number)) s.updates.add(number);
    s.lastKnown = Math.max(s.lastKnown, highest);
  }

  function updateUnread(s) {
    if (!s.updates) return;
    const rendered = new Map([...s.stream.children].map(node => [Number(node.dataset.postNumber), node]));
    if (!document.hidden) for (const number of s.updates) {
      const node = rendered.get(number);
      if (node?.classList.contains('post-stream--cloaked')) continue;
      const rect = node?.getBoundingClientRect();
      if (rect?.height && rect.bottom > headerBottom() && rect.top < window.innerHeight) {
        s.updates.delete(number);
        s.seenNew.add(number);
      }
    }
    while (s.seenNew.has(s.since + 1)) s.seenNew.delete(++s.since);
    const saved = JSON.stringify({ highest: s.lastKnown, since: s.since, pending: [...s.updates], seen: [...s.seenNew] });
    if (s.savedUpdates !== saved) {
      s.savedUpdates = saved;
      if (typeof GM_setValue === 'function') GM_setValue(`topic-updates:${s.id}`, JSON.parse(saved));
    }
    if (mode !== 'thread' || !s.updates.size) { s.notice?.remove(); s.notice = null; return; }
    if (!s.notice) {
      s.notice = element('button', 'ldt-updates');
      s.notice.type = 'button';
      s.notice.setAttribute('aria-live', 'polite');
      s.notice.addEventListener('click', () => jumpToPost(s, Math.min(...s.updates)));
      document.body.append(s.notice);
    }
    const unresolved = [...s.updates].some(number => !rendered.has(number));
    const text = unresolved ? '有新回复 · 查看' : `${s.updates.size} 条新回复 · 查看`;
    if (s.notice.textContent !== text) s.notice.textContent = text;
  }

  function updateSidepeek() {
    const views = document.querySelectorAll('#ld-drawer-root .ld-topic-view');
    for (const view of views) {
      const active = enabled && view.dataset.replyDisplay === 'inline';
      view.toggleAttribute('data-ldt-sidepeek', active);
      if (active) watchConnectors(view);
      if (!active) {
        view.querySelectorAll('.ldt-sidepeek-relation, .ldt-connectors').forEach(n => n.remove());
        view.querySelectorAll('[data-ldt-level]').forEach(n => n.removeAttribute('data-ldt-level'));
        view.querySelectorAll('.ldt-focus').forEach(n => n.classList.remove('ldt-focus'));
        view.querySelectorAll('[data-ldt-owner-text]').forEach(n => { n.textContent = n.dataset.ldtOwnerText; delete n.dataset.ldtOwnerText; });
        continue;
      }
      for (const badge of view.querySelectorAll('.ld-inline-post > .ld-post-header .ld-post-topic-owner-badge')) {
        if (!badge.hasAttribute('data-ldt-owner-text')) badge.dataset.ldtOwnerText = badge.textContent;
        if (badge.textContent !== '楼主') badge.textContent = '楼主';
      }
      for (const card of view.querySelectorAll('.ld-inline-post:not(.ld-parent-preview *)')) {
        const parent = card.parentElement.closest('.ld-post-card, .ld-inline-post');
        setData(card, 'ldtLevel', String(Math.min(3, Number(parent?.dataset.ldtLevel || 0) + 1)));
        const row = card.querySelector(':scope > .ld-post-header .ld-post-author-row');
        const author = parent?.querySelector(':scope > .ld-post-header .ld-post-author-row > strong')?.textContent?.trim();
        if (!row || !author) continue;
        let relation = row.querySelector('.ldt-sidepeek-relation');
        if (!relation) {
          relation = element('button', 'ldt-sidepeek-relation');
          relation.type = 'button';
          relation.title = '定位被回复的评论';
          relation.addEventListener('click', () => {
            const scroller = view.closest('.ld-drawer-body');
            if (scroller) scroller.scrollTo({ top: scroller.scrollTop + parent.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12, behavior: 'auto' });
            parent.classList.add('ldt-focus');
            setTimeout(() => parent.classList.remove('ldt-focus'), 1600);
          });
          row.append(relation);
        }
        const label = `回复 ${author}`;
        if (relation.textContent !== label) relation.textContent = label;
      }
    }
  }

  // 被论坛折叠的楼层没有头像，沿用它展开时在楼层里的原位（吸顶时不记），线条不会随滚动断开又出现；
  // 从没展开过的按同一层级的推算，同层头像位置相同。
  function avatarBox(node, selector, origin, header) {
    const rect = node.getBoundingClientRect();
    if (!rect.height) return null;
    const img = node.classList.contains('post-stream--cloaked') ? null : node.querySelector(selector);
    const avatar = img?.getBoundingClientRect();
    const kind = node.dataset.ldtDepth === undefined ? null : Math.min(3, Number(node.dataset.ldtDepth));
    let box = avatarCache.get(node);
    if (avatar?.width) {
      const y = avatar.top - rect.top;
      box = { x: avatar.left - origin.left, y: !box || y <= box.y || rect.top > header + 60 ? y : box.y, width: avatar.width, height: avatar.height };
      avatarCache.set(node, box);
      if (kind !== null) avatarKinds.set(kind, { ...box, y: Math.min(box.y, avatarKinds.get(kind)?.y ?? Infinity) });
      // 吸顶的头像按当前位置连线，记下来让滚动时跟着重画。
      if (rect.top < header + 60 && rect.bottom > header && getComputedStyle(img.closest('.topic-avatar') || img).position === 'sticky') stuckNodes.add(node);
      const top = rect.top - origin.top + y;
      return { left: box.x, top, width: box.width, height: box.height, bottom: top + box.height };
    }
    if (kind !== null && avatarKinds.has(kind)) box = avatarKinds.get(kind);
    if (!box) return null;
    const top = rect.top - origin.top + box.y;
    return { left: box.x, top, width: box.width, height: box.height, bottom: top + box.height };
  }

  function avatarBoxes(container, selector) {
    const origin = container.getBoundingClientRect();
    const header = headerBottom();
    const boxes = new Map();
    return node => {
      if (!boxes.has(node)) boxes.set(node, node ? avatarBox(node, selector, origin, header) : null);
      return boxes.get(node);
    };
  }

  function route(p, c) {
    if (!p || !c || c.top <= p.top) return null;
    const round = value => Math.round(value * 2) / 2;
    const x = round(c.left - 4), y = round(c.top + c.height / 2);
    const nested = c.left > p.left + 3;
    const center = round(p.left + p.width / 2);
    const lane = nested ? Math.min(center, x - 8) : x - 8;
    const start = nested ? `M ${center} ${round(p.bottom + 5)} H ${lane}` : `M ${round(p.left - 4)} ${round(p.top + p.height / 2)} H ${lane}`;
    return `${start} V ${y - 8} Q ${lane} ${y} ${lane + 8} ${y} H ${x}`;
  }

  function connectReplies(container, pairs, avatarSelector) {
    const old = container.querySelector(':scope > .ldt-connectors');
    const box = avatarBoxes(container, avatarSelector);
    const paths = [];
    const links = new Map();
    for (const [parent, child, number] of pairs) {
      const d = route(box(parent), box(child));
      if (!d) continue;
      links.set(String(number), [parent, child]);
      connected.add(parent).add(child);
      paths.push(`<path data-ldt-child="${number}" d="${d}"/>`);
    }
    const html = paths.join('');
    if (!html) { old?.remove(); return; }
    const svg = old || document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (!old) { svg.classList.add('ldt-connectors'); svg.setAttribute('aria-hidden', 'true'); container.append(svg); }
    if (svg.innerHTML !== html) svg.innerHTML = html;
    connectorLinks.set(svg, { links, selector: avatarSelector });
  }

  function updateConnectors() {
    stuckNodes.clear();
    connected = new WeakSet();
    if (state) {
      const { stream, posts } = state;
      const nodes = new Map([...stream.querySelectorAll(':scope > [data-post-number]')].map(n => [Number(n.dataset.postNumber), n]));
      if (mode === 'thread') connectReplies(stream, [...nodes].filter(([n]) => posts.get(n)?.parent > 1).map(([n, child]) => [nodes.get(posts.get(n).parent), child, n]), ':scope > .boxed > .row > .topic-avatar .avatar');
      else stream.querySelector(':scope > .ldt-connectors')?.remove();
    }
    for (const view of document.querySelectorAll('#ld-drawer-root [data-ldt-sidepeek]')) {
      connectReplies(view, [...view.querySelectorAll('.ld-inline-post:not(.ld-parent-preview *)')].map(child => [child.parentElement.closest('.ld-post-card, .ld-inline-post'), child, child.dataset.threadPostNumber]), ':scope > .ld-post-header .ld-post-avatar');
    }
  }

  // 头像吸顶时只重画连着这几层楼的线。
  function followSticky(nodes) {
    const svg = state?.stream.querySelector(':scope > .ldt-connectors');
    const record = svg && connectorLinks.get(svg);
    if (!record) return;
    stuckNodes.clear();
    const box = avatarBoxes(state.stream, record.selector);
    for (const path of svg.children) {
      const link = record.links.get(path.dataset.ldtChild);
      if (!link || (!nodes.has(link[0]) && !nodes.has(link[1]))) continue;
      const d = route(box(link[0]), box(link[1]));
      if (!d) { updateConnectors(); return; }
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    }
  }

  function quoteText(cooked) {
    const body = document.createElement('div');
    body.innerHTML = cooked;
    body.querySelectorAll('aside.quote, script, style, iframe').forEach(n => n.remove());
    body.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    body.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6').forEach(n => n.append('\n'));
    body.querySelectorAll('img').forEach(n => n.replaceWith(n.alt || '[图片]'));
    return body.textContent.trim().replace(/\n{3,}/g, '\n\n');
  }

  function updateQuote(s, wrapper, post) {
    const cooked = [...wrapper.querySelectorAll('.topic-body > .contents > .cooked, .topic-body > .cooked')]
      .find(n => !n.closest('.embedded-posts'));
    if (!cooked) return;
    const owned = cooked.querySelector(':scope > .ldt-auto-quote');
    const authored = [...cooked.querySelectorAll('aside.quote:not(.ldt-auto-quote)')].some(q =>
      Number(q.dataset.post) === post?.parent && (!q.dataset.topic || Number(q.dataset.topic) === s.id));
    if (mode !== 'quote' || !post?.parent || authored) { owned?.remove(); return; }
    const parent = s.posts.get(post.parent);
    if (!parent?.cooked) { owned?.remove(); load(s, post.parent); return; }
    if (!s.quotes.has(parent.cooked)) s.quotes.set(parent.cooked, quoteText(parent.cooked));
    const text = s.quotes.get(parent.cooked);
    if (!text) { owned?.remove(); return; }
    const signature = JSON.stringify([post.parent, parent.author, text]);
    if (owned?.dataset.signature === signature) return;
    owned?.remove();
    const quote = element('aside', 'quote ldt-auto-quote');
    quote.dataset.signature = signature;
    quote.dataset.post = post.parent;
    quote.dataset.topic = s.id;
    quote.append(element('div', 'title', `${parent.author || '被回复的评论'}：`),
      element('blockquote', '', text));
    cooked.prepend(quote);
  }

  function modebar(s) {
    const bar = element('div', 'ldt-modebar');
    const group = element('div', 'ldt-modes');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '评论阅读方式');
    for (const [value, label] of [['thread', '楼中楼'], ['quote', '引用']]) {
      const button = element('button', 'btn btn-flat', label);
      button.type = 'button';
      button.dataset.mode = value;
      button.title = value === 'thread' ? '按讨论关系阅读' : '按楼层顺序和引用阅读';
      button.addEventListener('click', () => {
        const anchor = readingAnchor(s);
        const top = anchor?.getBoundingClientRect().top;
        mode = value;
        if (typeof GM_setValue === 'function') GM_setValue('reading-mode', mode);
        refresh();
        if (anchor?.isConnected && top !== undefined) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
      });
      group.append(button);
    }
    bar.append(group);
    return bar;
  }

  function clearProgress(s) {
    s.progress?.remove();
    s.progress = null;
    s.mobileProgress?.remove();
    s.mobileProgress = null;
    s.navigationNote?.remove();
    s.navigationNote = null;
    setData(document.documentElement, 'ldtProgress', null);
  }

  function updateProgress(s) {
    updateUnread(s);
    if (mode !== 'thread') { clearProgress(s); return; }
    // 用根节点标记隐藏原生进度条，论坛重建时间线时也不会先露出原样。
    setData(document.documentElement, 'ldtProgress', '');
    const candidate = document.querySelector('.timeline-scrollarea');
    const fullscreen = candidate?.closest('.timeline-fullscreen');
    const native = fullscreen ? null : candidate;
    if (fullscreen) {
      if (!s.navigationNote) s.navigationNote = element('span', 'ldt-progress-navigation', '原楼号导航 · 含回复');
      if (candidate.previousElementSibling !== s.navigationNote) candidate.before(s.navigationNote);
    } else s.navigationNote?.remove();
    const mobile = document.querySelector('#topic-progress');
    if (!native) s.progress?.remove();
    if (!mobile) s.mobileProgress?.remove();
    if (!native && !mobile) return;
    if (native && !s.progress) {
      const panel = element('div', 'ldt-reading-progress');
      const rail = element('button', 'ldt-progress-rail');
      rail.type = 'button';
      rail.setAttribute('role', 'slider');
      rail.setAttribute('aria-label', '阅读位置');
      rail.setAttribute('aria-orientation', 'vertical');
      rail.setAttribute('aria-valuemin', '0');
      rail.setAttribute('aria-valuemax', '100');
      rail.append(element('span', 'ldt-progress-fill'), element('span', 'ldt-progress-handle'), element('span', 'ldt-progress-percent'));
      const jump = ratio => window.scrollTo({ top: s.progressStart + Math.max(0, Math.min(1, ratio)) * s.progressRange, behavior: 'auto' });
      const move = event => {
        const r = rail.getBoundingClientRect();
        if (r.height) jump((event.clientY - r.top - 10) / Math.max(1, r.height - 20));
      };
      rail.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        rail.focus();
        rail.setPointerCapture(event.pointerId);
        move(event);
      });
      rail.addEventListener('pointermove', event => { if (rail.hasPointerCapture(event.pointerId)) move(event); });
      rail.addEventListener('keydown', event => {
        const value = Number(rail.getAttribute('aria-valuenow')) / 100;
        const target = { ArrowUp: value - .03, ArrowDown: value + .03, PageUp: value - .15, PageDown: value + .15, Home: 0, End: 1 }[event.key];
        if (target !== undefined) { event.preventDefault(); jump(target); }
      });
      panel.append(element('span', 'ldt-progress-caption'), rail, element('span', 'ldt-progress-total'));
      s.progress = panel;
    }
    if (native) {
      if (native.nextElementSibling !== s.progress) native.after(s.progress);
      const height = native.style.height || '300px';
      if (s.progress.style.height !== height) s.progress.style.height = height;
    }
    const rect = s.stream.getBoundingClientRect();
    const header = headerBottom();
    s.progressStart = Math.max(0, rect.top + window.scrollY - header);
    s.progressRange = Math.max(0, rect.height - Math.max(1, window.innerHeight - header));
    const ratio = s.progressRange ? Math.max(0, Math.min(1, (window.scrollY - s.progressStart) / s.progressRange)) : (rect.bottom <= window.innerHeight ? 1 : 0);
    const loaded = s.stream.querySelectorAll(':scope > [data-post-number]').length;
    const partial = !s.total || loaded < s.total;
    const count = s.total ? (partial ? `已加载 ${loaded} / 共 ${s.total} 帖` : `共 ${s.total} 帖 · 含回复`) : `已加载 ${loaded} 帖 · 含回复`;
    const percent = Math.round(ratio * 100);
    if (native) {
      for (const [selector, text] of [['.ldt-progress-caption', partial ? '当前阅读段' : '阅读进度'], ['.ldt-progress-total', count], ['.ldt-progress-percent', `${percent}%`]]) {
        const node = s.progress.querySelector(selector);
        if (node.textContent !== text) node.textContent = text;
      }
      const rail = s.progress.querySelector('.ldt-progress-rail');
      rail.style.setProperty('--ldt-progress', ratio);
      rail.setAttribute('aria-valuenow', percent);
      rail.setAttribute('aria-valuetext', `${partial ? '当前阅读段' : '阅读进度'} ${percent}%，${count}`);
    }
    if (mobile) {
      if (!s.mobileProgress) s.mobileProgress = element('span', 'ldt-progress-mobile');
      if (s.mobileProgress.parentElement !== mobile) mobile.append(s.mobileProgress);
      const text = `${partial ? '本段' : '阅读'} ${percent}% · ${partial && s.total ? `${loaded}/${s.total}` : s.total || loaded}帖`;
      if (s.mobileProgress.textContent !== text) s.mobileProgress.textContent = text;
      const title = `${partial ? '当前阅读段' : '阅读进度'}，${count}`;
      if (s.mobileProgress.title !== title) s.mobileProgress.title = title;
    }
  }

  // 单纯滚动只更新进度；连线相对评论区固定，只在内容或尺寸变化、或连线的头像吸顶时重画。
  function scheduleProgress() {
    if (progressFrame) return;
    progressFrame = requestAnimationFrame(() => {
      progressFrame = 0;
      const layout = frameLayout;
      frameLayout = false;
      if (state) settle(state);
      if (layout) updateConnectors();
      else if (state && (stuckNodes.size || stuckAtTop(state))) followSticky(new Set([...stuckNodes, state.settled?.node]));
      if (state) updateProgress(state);
    });
  }

  // 头像只会吸附在跨过顶栏的那层楼里；它连着线时，滚动要跟着重画。
  function stuckAtTop(s) {
    const node = s.settled?.node;
    if (mode !== 'thread' || !node || s.settled.top >= headerBottom() || !connected.has(node)) return false;
    const avatar = node.querySelector(':scope > .boxed > .row > .topic-avatar');
    return !!avatar && getComputedStyle(avatar).position === 'sticky';
  }

  function scheduleLayout() {
    frameLayout = true;
    scheduleProgress();
  }

  function cleanup() {
    if (!state) return;
    state.abort.abort();
    state.notice?.remove();
    clearProgress(state);
    state.stream.querySelector(":scope > .ldt-connectors")?.remove();
    state.bar.remove();
    state.style.remove();
    const stream = state.stream;
    stream.classList.remove('ldt-active', 'ldt-thread');
    stream.querySelectorAll('.ldt-focus').forEach(n => n.classList.remove('ldt-focus'));
    stream.querySelectorAll('.ldt-relation, .ldt-owner-label, .ldt-auto-quote').forEach(n => n.remove());
    for (const n of stream.children) {
      delete n.dataset.ldtDepth;
      delete n.dataset.ldtRank;
      delete n.dataset.ldtFirst;
      delete n.dataset.ldtLast;
      delete n.dataset.ldtRoot;
      delete n.dataset.ldtConnected;
    }
    state = null;
  }

  function refresh() {
    clearTimeout(timer);
    observer.disconnect();
    try { arrange(); } finally { observe(); }
  }

  function arrange() {
    updateSidepeek();
    const id = topicId();
    const stream = document.querySelector('.post-stream');
    if (!enabled || !id || !stream) { cleanup(); updateConnectors(); return; }
    const created = state?.id !== id || state?.stream !== stream;
    if (created) {
      cleanup();
      state = { id, stream, posts: new Map(), quotes: new Map(), requested: new Set(), abort: new AbortController(), queue: Promise.resolve(), nextRequest: 0 };
      state.bar = modebar(state);
      state.style = element('style', 'ldt-layout');
      document.head.append(state.style);
    }
    const s = state;
    watchConnectors(stream);
    // 此刻论坛可能已改动但还没绘制，按上一帧画面里的位置找回阅读点；页面被程序滚动过时退回当前测量。
    let anchor = s.settled?.node, anchorTop = s.settled?.top;
    if (!anchor?.isConnected || s.settled.scrollY !== window.scrollY) {
      anchor = readingAnchor(s);
      anchorTop = anchor?.getBoundingClientRect().top;
    }
    if (!snapshot(s) && !s.posts.size) load(s);
    syncUpdates(s);
    const wrappers = [...stream.children].filter(n => Number(n.dataset.postNumber) > 0);
    const byNumber = new Map(wrappers.map(n => [Number(n.dataset.postNumber), n]));
    const positions = layout(s, wrappers);
    stream.classList.add('ldt-active');
    stream.classList.toggle('ldt-thread', mode === 'thread');
    const op = byNumber.get(1);
    const stats = op?.querySelector('.topic-map__stats');
    // 首楼被折叠时切换栏跟着收起，不挪进评论流，免得每次折叠、展开都改变页面高度。
    if (stats) { if (s.bar.parentElement !== stats) stats.append(s.bar); }
    else if (op) { if (!op.classList.contains('post-stream--cloaked') && op.nextElementSibling !== s.bar) op.after(s.bar); }
    else if (stream.firstElementChild !== s.bar) stream.prepend(s.bar);
    for (const b of s.bar.querySelectorAll('button')) {
      const pressed = String(b.dataset.mode === mode);
      if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
    }
    const rules = [];
    const branches = new Map();
    const marks = new Map();
    for (const wrapper of wrappers) {
      const number = Number(wrapper.dataset.postNumber);
      if (number === 1) continue;
      const post = s.posts.get(number);
      const position = positions.get(number);
      setData(wrapper, 'ldtDepth', String(position.depth));
      rules.push(`.post-stream.ldt-thread > [data-post-number="${number}"] { order: ${position.rank}; --ldt-indent: ${Math.min(2, Math.max(0, position.depth - 1))}; }`);
      marks.set(wrapper, { ldtFirst: false, ldtLast: false, ldtRoot: false, ldtConnected: false });
      if (position.depth > 0) {
        if (!branches.has(position.root)) branches.set(position.root, []);
        branches.get(position.root).push(wrapper);
      }
      // 折叠的楼层没有内容，展开时会再次触发整理。
      if (wrapper.classList.contains('post-stream--cloaked')) continue;
      const names = [...wrapper.querySelectorAll('.topic-body > .topic-meta-data .names')]
        .find(n => !n.closest('.embedded-posts'));
      let badge = names?.querySelector('.ldt-owner-label');
      if (names && wrapper.classList.contains('topic-owner')) {
        if (!badge) badge = element('span', 'ldt-owner-label', '楼主');
        const author = names.querySelector(':scope > .first');
        if (author && author.nextElementSibling !== badge) author.after(badge);
        else if (!author && badge.parentElement !== names) names.append(badge);
      } else badge?.remove();
      let relation = wrapper.querySelector('.ldt-relation');
      if (post?.parent > 1 && names) {
        if (!relation) {
          relation = element('button', 'ldt-relation');
          relation.type = 'button';
          relation.addEventListener('click', () => jumpToPost(s, s.posts.get(number)?.parent));
          relation.title = '定位被回复的评论';
          names.append(relation);
        }
        const parent = s.posts.get(post.parent);
        const author = parent?.author || post.parentAuthor;
        const label = author ? `回复 ${author}` : '回复此前的评论';
        if (relation.textContent !== label) relation.textContent = label;
        if (!parent) load(s, post.parent);
      } else relation?.remove();
      updateQuote(s, wrapper, post);
    }
    for (const [root, replies] of branches) {
      const parent = byNumber.get(root);
      if (marks.has(parent)) marks.get(parent).ldtRoot = true;
      replies.sort((a, b) => positions.get(Number(a.dataset.postNumber)).rank - positions.get(Number(b.dataset.postNumber)).rank);
      marks.get(replies[0]).ldtFirst = true;
      marks.get(replies[0]).ldtConnected = !!parent;
      marks.get(replies.at(-1)).ldtLast = true;
    }
    // 只改有变化的标记，楼层折叠与否不影响标记，展开时样式立即就位。
    for (const [wrapper, flags] of marks) for (const key in flags) setData(wrapper, key, flags[key] ? '' : null);
    // 原生加载边界、时间分隔线仍跟随对应楼层，不参与回复关系排序。
    const children = [...stream.children];
    children.forEach((node, i) => {
      if (node === s.bar || node.dataset.postNumber || node.classList.contains('ldt-connectors')) return;
      const next = children.slice(i + 1).find(n => Number(n.dataset.postNumber) > 0);
      setData(node, 'ldtRank', String(i));
      const rank = next ? (positions.get(Number(next.dataset.postNumber))?.rank || 0) - 1 : (positions.size + 3) * 10;
      rules.push(`.post-stream.ldt-thread > [data-ldt-rank="${i}"] { order: ${rank}; }`);
    });
    const css = rules.join('\n');
    if (s.style.textContent !== css) s.style.textContent = css;
    if (anchor?.isConnected && anchorTop !== undefined) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    }
    // 先读完位置再写连线；进度面板不影响正文，放到下一帧。
    settle(s);
    updateConnectors();
    if (created) updateProgress(s);
    else scheduleProgress();
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 80); }
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('开启 / 关闭评论整理', () => { enabled = !enabled; refresh(); });
  window.addEventListener('popstate', schedule);
  // 滚动事件早于论坛在这一帧里的重绘，先把记下的阅读位置跟着平移。
  window.addEventListener('scroll', () => {
    const settled = state?.settled;
    if (settled) { settled.top -= window.scrollY - settled.scrollY; settled.scrollY = window.scrollY; }
    scheduleProgress();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (window.innerWidth !== viewportWidth) { viewportWidth = window.innerWidth; avatarCache = new WeakMap(); avatarKinds.clear(); }
    scheduleLayout();
  });
  document.addEventListener('visibilitychange', scheduleProgress);
  document.addEventListener('load', scheduleLayout, true);
  document.addEventListener('scroll', scheduleProgress, { passive: true, capture: true });
  document.addEventListener('click', event => {
    if (!state || mode !== 'thread' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const date = event.target.closest?.('.timeline-container:not(.timeline-fullscreen) .start-date, .timeline-container:not(.timeline-fullscreen) .now-date');
    if (!date) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const first = date.classList.contains('start-date');
    const number = first ? 1 : Number(new URL(date.href, location.href).pathname.split('/').filter(Boolean).at(-1));
    if (!renderedPost(state, number)) location.assign(first ? `/t/topic/${state.id}/1` : date.href);
    else window.scrollTo({ top: first ? 0 : state.progressStart + state.progressRange, behavior: 'auto' });
  }, true);
  setInterval(() => { if (enabled && topicId() !== (state?.id || 0)) schedule(); }, 1000);
  refresh();
})();
