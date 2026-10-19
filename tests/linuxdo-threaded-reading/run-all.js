// Runs every test file against the userscript (default: the one in the repository root).
//   node run-all.js [path/to/linuxdo-threaded-reading.user.js]
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.resolve(process.argv[2] || path.join(__dirname, '../../linuxdo-threaded-reading.user.js'));
let failed = 0;
for (const file of ['features.test.js', 'connectors.test.js', 'flicker.test.js']) {
  console.log(`\n== ${file}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file), script], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}
console.log(failed ? `\n${failed} 个测试文件有失败项` : '\n全部通过');
process.exitCode = failed ? 1 : 0;
