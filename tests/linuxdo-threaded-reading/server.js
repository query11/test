// Local server for the mock pages.
// - /t/<slug>/<id>[/<post>] serves the topic page, /latest the topic list.
// - /t/<id>/<post>.json answers like Discourse's topic JSON for topic 124 only (other topics 404).
//   POST /__fail {path, times, status} makes the next `times` requests to `path` fail.
// - /__requests returns how often each JSON path was requested (?reset clears); /__images lists /img/* requests.
const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = () => new Promise(resolve => {
  const requests = {}, failures = {}, images = [];
  const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const file = name => fs.readFileSync(path.join(__dirname, 'mock', name));
    if (url.pathname === '/mock/mock.js') return send(res, 200, 'text/javascript', file('mock.js'));
    if (url.pathname === '/latest') return send(res, 200, 'text/html', file('list.html'));
    if (url.pathname.startsWith('/img/')) { images.push(url.pathname); return send(res, 404, 'text/plain', ''); }
    if (url.pathname === '/__images') return send(res, 200, 'application/json', JSON.stringify(images.splice(0)));
    if (url.pathname === '/__requests') {
      const body = JSON.stringify(requests);
      if (url.searchParams.has('reset')) for (const key in requests) delete requests[key];
      return send(res, 200, 'application/json', body);
    }
    if (url.pathname === '/__fail') {
      failures[url.searchParams.get('path')] = { times: Number(url.searchParams.get('times')), status: Number(url.searchParams.get('status')) };
      return send(res, 200, 'text/plain', 'ok');
    }
    const json = url.pathname.match(/^\/t\/(\d+)\/(\d+)\.json$/);
    if (json) {
      requests[url.pathname] = (requests[url.pathname] || 0) + 1;
      const failure = failures[url.pathname];
      if (failure?.times > 0) { failure.times--; return send(res, failure.status, 'application/json', '{}'); }
      if (json[1] !== '124') return send(res, 404, 'application/json', '{}');
      const n = Number(json[2]);
      return send(res, 200, 'application/json', JSON.stringify({
        posts_count: 130, highest_post_number: 130,
        post_stream: { posts: [{ post_number: n, username: `srv${n}`, display_username: `SRV${n}`, cooked: `<p>服务器返回的第 ${n} 楼</p>` }] },
      }));
    }
    if (url.pathname.startsWith('/t/')) return send(res, 200, 'text/html', file('topic.html'));
    send(res, 404, 'text/plain', '');
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
