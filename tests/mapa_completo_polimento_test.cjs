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

function assentar(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('arrastar 120 px move o grafo 120 px e o ponteiro solto não salta', { timeout: 180000 }, async () => {
  for (const [width, height] of [[1440, 900], [393, 852]]) {
    const { context, page, errors } = await abrir(width, height);
    try {
      await mapaAberto(page);
      await page.evaluate(() => { location.hash = 'e=ipes'; });
      await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'ipes', null, { timeout: 8000 });
      await page.waitForFunction(() => {
        const card = document.querySelector('#network .network-node.selected .node-card');
        if (!card) return false;
        const r = card.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) return false;
        const hit = document.elementFromPoint(x, y);
        return !!(hit && hit.closest && hit.closest('.network-node.selected'));
      }, null, { timeout: 8000 });
      const antes = await page.evaluate(() => ({
        g: window.mapaCompleto.pontoNaTela('kochpac'),
        m: window.mural.getState().camera,
        hit: (() => {
          const card = document.querySelector('#network .network-node.selected .node-card');
          const r = card.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })(),
      }));
      await page.mouse.move(antes.hit.x, antes.hit.y);
      await page.mouse.down();
      await page.mouse.move(antes.hit.x + 120, antes.hit.y, { steps: 6 });
      await page.mouse.up();
      await assentar(page);
      const depois = await page.evaluate(() => ({
        g: window.mapaCompleto.pontoNaTela('kochpac'),
        m: window.mural.getState().camera,
      }));
      const dgx = depois.g.x - antes.g.x, dgy = depois.g.y - antes.g.y;
      const dmx = depois.m.x - antes.m.x, dmy = depois.m.y - antes.m.y;
      assert.ok(Math.abs(dmx - 120) <= 1 && Math.abs(dmy) <= 1, `${width} mural ${dmx},${dmy}`);
      assert.ok(Math.abs(dgx - 120) <= 1 && Math.abs(dgy) <= 1, `${width} grafo ${dgx},${dgy}`);

      const outro = await page.evaluate(() => window.mapaCompleto.pontoNaTela('rf'));
      await page.evaluate(() => { location.hash = 'e=rf'; });
      await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'rf', null, { timeout: 8000 });
      await assentar(page);
      await assentar(page);
      const parado = await page.evaluate(() => ({
        g: window.mapaCompleto.pontoNaTela('kochpac'),
        m: window.mural.getState().camera,
      }));
      await page.mouse.move(Math.min(width - 20, Math.max(20, outro.x + 30)), Math.min(height - 20, Math.max(20, outro.y + 24)));
      await assentar(page);
      const solto = await page.evaluate(() => ({
        g: window.mapaCompleto.pontoNaTela('kochpac'),
        m: window.mural.getState().camera,
      }));
      assert.ok(Math.abs(solto.m.x - parado.m.x) <= 1 && Math.abs(solto.m.y - parado.m.y) <= 1, `${width} câmera solta ${solto.m.x - parado.m.x},${solto.m.y - parado.m.y}`);
      assert.ok(Math.abs(solto.g.x - parado.g.x) <= 1 && Math.abs(solto.g.y - parado.g.y) <= 1, `${width} grafo solto ${solto.g.x - parado.g.x},${solto.g.y - parado.g.y}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test('na vista all o Tab não entra em cartão invisível e em Temas o cartão volta focável', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrir(1440, 900);
  try {
    await mapaAberto(page);
    await page.locator('#search').focus();
    const focos = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      focos.push(await page.evaluate(() => {
        const el = document.activeElement;
        let o = 1;
        let visivel = true;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden' || n.hasAttribute('hidden')) { visivel = false; o = 0; break; }
          const op = Number.parseFloat(s.opacity);
          if (!(op > 0)) { visivel = false; o = 0; break; }
          o *= op;
        }
        const cls = el.className && (el.className.baseVal || el.className);
        return {
          tag: el.tagName,
          id: el.id || '',
          cls: String(cls || '').slice(0, 80),
          o,
          visivel,
        };
      }));
    }
    const invisiveis = focos.filter(f => !(f.visivel && f.o > 0));
    assert.deepEqual(invisiveis, [], JSON.stringify(invisiveis));
    await page.evaluate(() => { location.hash = 'e=ipes'; });
    await page.waitForFunction(() => document.querySelector('#network .network-node.selected'));
    const selecionado = await page.evaluate(() => {
      const card = document.querySelector('#network .network-node.selected');
      card.focus();
      const el = document.activeElement;
      let o = 1;
      for (let n = card; n && n.nodeType === 1; n = n.parentElement) o *= Number.parseFloat(getComputedStyle(n).opacity) || 0;
      return { focado: el === card || card.contains(el), tab: card.getAttribute('tabindex'), o, inert: card.hasAttribute('inert') };
    });
    assert.equal(selecionado.focado, true, JSON.stringify(selecionado));
    assert.notEqual(selecionado.tab, '-1', JSON.stringify(selecionado));
    assert.equal(selecionado.inert, false, JSON.stringify(selecionado));
    assert.ok(selecionado.o > 0, JSON.stringify(selecionado));
    await page.locator('[data-modo-temas]').click();
    await page.waitForFunction(() => window.mural.getState().view === 'temas' && window.mapaCompleto && !window.mapaCompleto.ativo);
    await page.locator('#temas-screen [data-tema]').first().click();
    await page.waitForFunction(() => {
      const v = window.mural.getState().view;
      return v && v !== 'temas' && v !== 'all' && document.querySelector('#network .network-node');
    });
    const cartoes = await page.evaluate(() => {
      const nos = [...document.querySelectorAll('#network .network-node')];
      const amostra = nos.slice(0, 12).map(n => ({
        tab: n.getAttribute('tabindex'),
        inert: n.hasAttribute('inert'),
        hidden: n.getAttribute('aria-hidden'),
      }));
      const primeiro = nos[0];
      primeiro.focus();
      return {
        n: nos.length,
        amostra,
        focado: document.activeElement === primeiro || primeiro.contains(document.activeElement),
      };
    });
    assert.ok(cartoes.n > 0, JSON.stringify(cartoes));
    assert.equal(cartoes.focado, true, JSON.stringify(cartoes));
    for (const c of cartoes.amostra) {
      assert.equal(c.tab, '0', JSON.stringify(c));
      assert.equal(c.inert, false, JSON.stringify(c));
      assert.notEqual(c.hidden, 'true', JSON.stringify(c));
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Shift+Enter no rótulo de RF expande Rockefeller e não Mauá', { timeout: 120000 }, async () => {
  const { context, page, errors } = await abrir(1440, 900);
  try {
    await mapaAberto(page);
    await page.evaluate(() => { location.hash = 'e=maua'; });
    await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'maua');
    await page.evaluate(() => window.mapaCompleto.enquadrar(false));
    await page.waitForFunction(() => document.querySelector('#grafo-rotulos text[data-grafo-no="rf"]'));
    await page.locator('#grafo-rotulos text[data-grafo-no="rf"]').focus();
    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => {
      const st = window.mural.getState();
      return st.view === 'custom' && st.selected && st.selected.id === 'rf';
    }, null, { timeout: 8000 });
    const estado = await page.evaluate(() => {
      const st = window.mural.getState();
      return { id: st.selected && st.selected.id, view: st.view, nos: st.visibleNodes };
    });
    assert.equal(estado.id, 'rf', JSON.stringify({ id: estado.id, view: estado.view, n: estado.nos.length }));
    assert.equal(estado.view, 'custom');
    assert.ok(estado.nos.includes('rf') && estado.nos.length > 1 && estado.nos.length < 1644, JSON.stringify({ n: estado.nos.length }));
    assert.notEqual(estado.id, 'maua');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Home na alça recolhe o painel e Home num rótulo enquadra o grafo', { timeout: 120000 }, async () => {
  const { context, page, errors } = await abrir(393, 852);
  try {
    await mapaAberto(page);
    await page.evaluate(() => { location.hash = 'e=ipes'; });
    await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'ipes');
    await page.waitForFunction(() => {
      const h = document.getElementById('sheet-handle');
      const s = getComputedStyle(h);
      return s.display !== 'none' && s.visibility !== 'hidden' && document.getElementById('inspector').dataset.sheet === 'half';
    });
    await page.locator('#sheet-handle').focus();
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'sheet-handle');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.getElementById('inspector').dataset.sheet === 'collapsed', null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => document.getElementById('sheet-handle').getAttribute('aria-valuenow')), '0');
    await page.waitForFunction(() => document.querySelector('#grafo-rotulos text[data-grafo-no]'));
    await page.evaluate(() => document.getElementById('zoom-in').click());
    await page.waitForFunction(() => window.__grafo.zoom() > 1.1);
    await page.locator('#grafo-rotulos text[data-grafo-no]').first().focus();
    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.getAttribute && el.getAttribute('data-grafo-no');
    });
    assert.ok(foco, 'foco deveria estar num rótulo do grafo');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => Math.abs(window.__grafo.zoom() - 1) < 0.04, null, { timeout: 4000 });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
