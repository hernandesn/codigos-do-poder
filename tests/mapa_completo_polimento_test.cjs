'use strict';
// Polimento do mapa completo: abas no celular, colisão de rótulos e cartão visível.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
let browser, server, origin;

function tipo(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = path.resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const body = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': tipo(file) });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function abrir(width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: width < 500,
    hasTouch: width < 500,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    localStorage.setItem('aion.tutorial', 'visto-v1');
    localStorage.setItem('aion.dica-toque', 'visto-v1');
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/config.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: `globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:${JSON.stringify(origin)},supabaseAnonKey:'public-test-placeholder'};`,
      });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  return { context, page, errors };
}

async function mapaAberto(page) {
  await page.goto(origin + '/#all', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.mural && window.mural.getState().view === 'all' && window.mapaCompleto && window.mapaCompleto.ativo, null, { timeout: 25000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const z = window.__grafo && window.__grafo.zoom();
    return typeof z === 'number' && Math.abs(z - 1) < 0.04;
  }, null, { timeout: 15000 });
}

test('abas Temas, Mapa completo e Mapa-múndi cabem de 360 a 430 px', { timeout: 120000 }, async () => {
  for (const width of [360, 393, 430]) {
    const { context, page, errors } = await abrir(width, 852);
    try {
      await mapaAberto(page);
      await page.waitForFunction(() => document.getElementById('map-mode-count') && document.getElementById('map-mode-count').textContent === '1.644');
      const relatorio = await page.evaluate(() => {
        const nav = document.getElementById('map-mode');
        const botoes = [...nav.querySelectorAll('button')];
        const falhas = [];
        for (const b of botoes) {
          const alvos = [b, ...b.querySelectorAll('*')];
          for (const el of alvos) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            if (el.scrollWidth > el.clientWidth) falhas.push({ kind: 'sw', t: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth });
            if (cs.textOverflow && cs.textOverflow !== 'clip') falhas.push({ kind: 'to', t: (el.textContent || '').slice(0, 40), to: cs.textOverflow });
          }
          const r = b.getBoundingClientRect();
          if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5) falhas.push({ kind: 'fora', t: b.innerText, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        }
        const count = document.getElementById('map-mode-count');
        const meio = count.closest('button').getBoundingClientRect();
        const c = count.getBoundingClientRect();
        const dentro = c.width > 2 && c.left >= meio.left - 0.5 && c.right <= meio.right + 0.5 && c.top >= meio.top - 0.5 && c.bottom <= meio.bottom + 0.5;
        if (count.textContent !== '1.644' || !dentro) falhas.push({ kind: 'contador', text: count.textContent, dentro, c: { x: c.x, y: c.y, w: c.width, h: c.height }, meio: { x: meio.x, w: meio.width, h: meio.height } });
        return {
          falhas,
          textos: botoes.map(b => (b.innerText || '').replace(/\s+/g, ' ').trim()),
          largo: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.deepEqual(relatorio.falhas, [], `${width}: ${JSON.stringify(relatorio)}`);
      assert.equal(relatorio.largo, false, `${width} rolagem horizontal`);
      assert.equal(relatorio.textos.length, 3, JSON.stringify(relatorio.textos));
      assert.match(relatorio.textos[0], /^Temas$/);
      assert.match(relatorio.textos[1], /Mapa completo/);
      assert.match(relatorio.textos[1], /1\.644/);
      assert.match(relatorio.textos[2], /Mapa-múndi/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('rótulos sem interseção e os 3 polos visíveis a 100%', { timeout: 120000 }, async () => {
  for (const [width, height] of [[393, 852], [1440, 900]]) {
    const { context, page, errors } = await abrir(width, height);
    try {
      await mapaAberto(page);
      await page.waitForFunction(() => {
        const ids = (window.__grafo.caixas() || []).map(c => c.id);
        return ids.includes('ipes') && ids.includes('rf') && ids.includes('papacy');
      }, null, { timeout: 10000 });
      const info = await page.evaluate(() => {
        const caixas = window.__grafo.caixas();
        const pares = [];
        for (let i = 0; i < caixas.length; i++) {
          for (let j = i + 1; j < caixas.length; j++) {
            const a = caixas[i], b = caixas[j];
            const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (x > 0 && y > 0) pares.push({ a: a.id, b: b.id, area: Math.round(x * y) });
          }
        }
        const polos = ['ipes', 'rf', 'papacy'].map(id => {
          const c = caixas.find(item => item.id === id);
          if (!c) return { id, ok: false };
          const dentro = c.x >= -0.5 && c.y >= -0.5 && c.x + c.w <= innerWidth + 0.5 && c.y + c.h <= innerHeight + 0.5;
          return { id, ok: dentro && c.w > 2 && c.h > 2, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) };
        });
        return { pares, polos, zoom: window.__grafo.zoom(), ids: caixas.map(c => c.id) };
      });
      assert.ok(Math.abs(info.zoom - 1) < 0.04, JSON.stringify(info));
      assert.deepEqual(info.pares, [], `${width}: ${JSON.stringify(info)}`);
      for (const polo of info.polos) assert.equal(polo.ok, true, `${width}: ${JSON.stringify(info.polos)}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('cartão do nó selecionado fica visível sobre o canvas', { timeout: 120000 }, async () => {
  for (const [width, height] of [[1440, 900], [393, 852]]) {
    const { context, page, errors } = await abrir(width, height);
    try {
      await mapaAberto(page);
      await page.waitForFunction(() => {
        const p = window.mapaCompleto.pontoNaTela && window.mapaCompleto.pontoNaTela('ipes');
        return p && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight;
      }, null, { timeout: 10000 });
      const ponto = await page.evaluate(() => window.mapaCompleto.pontoNaTela('ipes'));
      if (width < 500) await page.touchscreen.tap(ponto.x, ponto.y);
      else await page.mouse.click(ponto.x, ponto.y);
      await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'ipes', null, { timeout: 8000 });
      await page.waitForFunction(() => {
        const card = document.querySelector('#network .network-node.selected');
        if (!card) return false;
        const r = card.getBoundingClientRect();
        if (r.width < 80 || r.height < 30) return false;
        let o = 1;
        for (let n = card; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 0;
        if (!(o > 0)) return false;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return false;
        const hit = document.elementFromPoint(x, y);
        return !!(hit && (hit === card || card.contains(hit)));
      }, null, { timeout: 8000 });
      const detalhe = await page.evaluate(() => {
        const card = document.querySelector('#network .network-node.selected');
        const rect = card.querySelector('.node-card');
        const titulo = card.querySelector('.node-title');
        const r = card.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        let o = 1;
        for (let n = card; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 0;
        const rgb = s => (getComputedStyle(s).fill || '').replace(/\s/g, '');
        return {
          o,
          dentro: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
          hit: !!(hit && (hit === card || card.contains(hit))),
          titulo: titulo ? titulo.textContent : '',
          fill: rgb(rect),
          tinta: rgb(titulo),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
      assert.ok(detalhe.o > 0, JSON.stringify(detalhe));
      assert.equal(detalhe.dentro, true, JSON.stringify(detalhe));
      assert.equal(detalhe.hit, true, JSON.stringify(detalhe));
      assert.match(detalhe.titulo, /IPES/);
      assert.match(detalhe.fill, /rgb\(27,\s*20,\s*16\)/);
      assert.match(detalhe.tinta, /rgb\(237,\s*227,\s*205\)/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
