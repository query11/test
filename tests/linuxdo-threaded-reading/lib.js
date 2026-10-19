// Shared helpers: start the mock server and a browser, open mock pages with the userscript
// injected behind GM_* shims, and report checks.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const startServer = require('./server');

// GM_* shims backed by an in-page Map, so tests can seed and inspect storage.
const shims = (mode, store) => `
  window.unsafeWindow = window;
  window.__store = new Map(${JSON.stringify(Object.entries(store))});
  if (!window.__store.has('reading-mode')) window.__store.set('reading-mode', ${JSON.stringify(mode)});
  window.__writes = [];
  window.__errors = [];
  const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
  window.GM_addStyle = css => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return s; };
  window.GM_getValue = (key, fallback) => window.__store.has(key) ? clone(window.__store.get(key)) : fallback;
  window.GM_setValue = (key, value) => { window.__writes.push(key); window.__store.set(key, clone(value)); };
  window.GM_listValues = () => [...window.__store.keys()];
  window.GM_deleteValue = key => window.__store.delete(key);
  window.GM_registerMenuCommand = (name, fn) => { window.__menu = fn; };
  window.addEventListener('error', event => window.__errors.push(String(event.message)));
`;

async function setup() {
  const scriptPath = path.resolve(process.argv[2] || path.join(__dirname, '../../linuxdo-threaded-reading.user.js'));
  const script = fs.readFileSync(scriptPath, 'utf8');
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  // Opens a mock page, optionally installs a stand-in for Discourse's link interceptor on #main
  // (records the href and prevents the navigation), then injects the userscript.
  async function open({ url = '/t/topic/123', mode = 'thread', store = {}, viewport = { width: 1280, height: 900 }, intercept = false, before } = {}) {
    const page = await browser.newPage({ viewport });
    await page.goto(base + url);
    if (intercept) await page.evaluate(() => {
      window.__routed = [];
      document.querySelector('#main').addEventListener('click', event => {
        const link = event.target.closest('a');
        if (link) { event.preventDefault(); window.__routed.push(link.getAttribute('href')); }
      });
    });
    if (before) await page.evaluate(before);
    await page.addScriptTag({ content: shims(mode, store) });
    await page.addScriptTag({ content: script });
    await page.waitForTimeout(300);
    return page;
  }

  async function close() {
    await browser.close();
    server.close();
  }

  return { base, browser, open, close, scriptPath };
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

function finish() {
  if (failed) console.log(`${failed} check(s) failed`);
  process.exitCode = failed ? 1 : 0;
}

// Waits for the paint after the current frame (rAF, then a task).
const nextPaint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));

module.exports = { setup, check, finish, nextPaint };
