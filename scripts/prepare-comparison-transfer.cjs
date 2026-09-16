// Generate the static dense-ray transfer asset using the comparison's WebGPU tracer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { finished } = require('node:stream/promises');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'C:/Users/yc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url = new URL(process.env.COMPARISON_URL || 'http://127.0.0.1:4185/comparison.html');
url.searchParams.set('prepareTransfer', '1');
const out = path.resolve('public/comparison/transfer.bin.gz');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-webgpu'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error' || (m.type() === 'warning' && /GPU|invalid/i.test(m.text()))) {
        errors.push(m.text()); if (errors.length < 3) console.error(m.text());
      }
    });
    await page.goto(url.href);
    await page.waitForFunction(() => window.comparison?.prepareTransfer, {}, { timeout: 60000 });
    console.log('Tracing and combining 1,024 rays per surface point.');
    const stats = await page.evaluate(async () => {
      window.preparedTransfer = await comparison.prepareTransfer();
      return preparedTransfer.stats;
    });
    if (errors.length) throw Error(errors.join('\n'));
    if (!stats.entries || stats.entries * 4 > 128 * 1024 * 1024) throw Error('Transfer exceeds the prototype budget.');
    const temporary = out + '.tmp';
    const compressed = zlib.createGzip({ level: 9 }), file = fs.createWriteStream(temporary);
    compressed.pipe(file);
    for (let start = 0; start < stats.bytes; start += 1024 * 1024) {
      const encoded = await page.evaluate(start => {
        const bytes = preparedTransfer.bytes.subarray(start, start + 1024 * 1024);
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
        return btoa(chunks.join(''));
      }, start);
      await new Promise((resolve, reject) => compressed.write(Buffer.from(encoded, 'base64'), error => error ? reject(error) : resolve()));
    }
    compressed.end(); await finished(file);
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, out); break; }
      catch (error) {
        if (error.code !== 'EBUSY' || attempt === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    const payload = fs.readFileSync(out);
    const report = { ...stats, compressedBytes: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'), errors };
    fs.writeFileSync(path.resolve('public/comparison/transfer-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
