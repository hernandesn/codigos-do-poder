'use strict';
// SEC-06: somente servidor local, configuração sintética e bloqueio de toda rede externa.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const prints = path.resolve(root, '../../prints');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ref = html.match(/data-src="([^"]+)"/)[1].split('?')[0];
const entity = JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8')).nos[0].id;
const allowed = new Set(['/index.html', '/dados-nucleo.json', '/dados-extensao.json']);

test('SEC-06 CSP sem violações: temas, #all, entidade e login em desktop e celular', { timeout: 120000 }, async () => {
  let browser;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:"https://ozeiyqpbtggvuyhplisa.supabase.co",supabaseAnonKey:"public-test-placeholder"};');
      return;
    }
    if (!allowed.has(file) && !/^\/fonts\/[a-z0-9-]+\.woff2$/.test(file)) { res.writeHead(404); res.end(); return; }
    try {
      const body = await fs.promises.readFile(root + file);
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'font/woff2' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    fs.mkdirSync(prints, { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 900], ['celular', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500, serviceWorkers: 'block' });
      try {
        const external = [], errors = [];
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin !== origin) {
            external.push(route.request().method());
            return route.abort();
          }
          return route.continue();
        });
        await context.addInitScript(() => {
          window.__secCsp = [];
          document.addEventListener('securitypolicyviolation', event => window.__secCsp.push({ directive: event.effectiveDirective }));
          localStorage.setItem('aion.tutorial', 'visto-v1');
          localStorage.setItem('aion.dica-toque', 'visto-v1');
        });
        const page = await context.newPage();
        page.on('pageerror', () => errors.push('pageerror'));
        page.on('console', message => { if (message.type() === 'error') errors.push('console.error'); });
        const capture = async screen => {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.deepEqual(await page.evaluate(() => window.__secCsp), [], `${name}/${screen}: CSP`);
          assert.deepEqual(errors, [], `${name}/${screen}: console`);
          assert.deepEqual(external, [], `${name}/${screen}: nenhuma chamada externa`);
          await page.screenshot({ path: path.join(prints, `sec06-${name}-${screen}.png`), fullPage: false });
        };
        await page.goto(origin);
        await page.waitForFunction(() => !!window.mural);
        await page.locator('#temas-screen').waitFor({ state: 'visible' });
        await capture('temas');
        await page.evaluate(() => { location.hash = 'all'; });
        await page.waitForFunction(() => window.mural.getState().view === 'all');
        await capture('all');
        await page.evaluate(id => { location.hash = 'e=' + encodeURIComponent(id); }, entity);
        await page.locator('#inspector').waitFor({ state: 'visible' });
        await capture('entidade');
        await page.locator('#chat-open').click();
        await page.locator('#chat-login').click();
        await page.locator('#auth-email').waitFor({ state: 'visible' });
        await capture('login');
      } finally { await context.close(); }
    }
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
