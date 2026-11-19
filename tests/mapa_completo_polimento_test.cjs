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

async function abrir(width, height, extra) {
  const context = await browser.newContext(Object.assign({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: width < 500,
    hasTouch: width < 500,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  }, extra || {}));
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
    if (!(typeof z === 'number' && Math.abs(z - 1) < 0.04)) return false;
    const canvas = document.getElementById('grafo-canvas');
    const p = window.mapaCompleto && window.mapaCompleto.pontoNaTela && window.mapaCompleto.pontoNaTela('kochpac');
    if (!canvas || canvas.clientWidth < 2 || canvas.clientHeight < 2 || !p) return false;
    if (!(p.x > 16 && p.y > 16 && p.x < innerWidth - 16 && p.y < innerHeight - 16)) return false;
    const chave = [canvas.clientWidth, canvas.clientHeight, Math.round(p.x * 10), Math.round(p.y * 10), Math.round(z * 1000)].join(':');
    if (window.__grafoEstavel !== chave) {
      window.__grafoEstavel = chave;
      window.__grafoEstavelN = 0;
      return false;
    }
    window.__grafoEstavelN += 1;
    return window.__grafoEstavelN >= 2;
  }, null, { timeout: 15000, polling: 'raf' });
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

function amostraZoom(id) {
  const card = document.querySelector('#network .network-node.selected');
  const r = card.getBoundingClientRect();
  const cursor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const rede = document.getElementById('network').getBoundingClientRect();
  const cam = window.mural.getState().camera;
  const pos = window.mural.getState().positions[id];
  return {
    cursor,
    g: window.mapaCompleto.pontoNaTela(id),
    gz: window.__grafo.zoom(),
    mk: cam.k,
    mural: { x: rede.left + pos.x * cam.k + cam.x, y: rede.top + pos.y * cam.k + cam.y },
  };
}

test('roda e pinça sobre o cartão mantêm a escala do mural e do grafo', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrir(1440, 900, { hasTouch: true });
  try {
    await mapaAberto(page);
    await page.evaluate(() => { location.hash = 'e=ipes'; });
    await page.waitForFunction(() => window.mural.getState().selected && window.mural.getState().selected.id === 'ipes' && window.mural.getState().camera.k >= 0.89, null, { timeout: 8000 });
    await page.waitForFunction(() => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      if (!card) return false;
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) return false;
      const hit = document.elementFromPoint(x, y);
      return !!(hit && hit.closest && hit.closest('.network-node.selected'));
    }, null, { timeout: 8000 });
    await assentar(page);

    const antes = await page.evaluate(amostraZoom, 'kochpac');
    const antesNo = await page.evaluate(amostraZoom, 'ipes');
    await page.mouse.move(antes.cursor.x, antes.cursor.y);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(k => window.mural.getState().camera.k > k + 0.02, antes.mk, { timeout: 4000 });
    await assentar(page);
    const depois = await page.evaluate(amostraZoom, 'kochpac');
    const depoisNo = await page.evaluate(amostraZoom, 'ipes');
    const fatorM = depois.mk / antes.mk;
    const fatorG = depois.gz / antes.gz;
    assert.ok(fatorM > 1.05 && fatorG > 1.05, JSON.stringify({ fatorM, fatorG, antes, depois }));
    assert.ok(Math.abs(fatorM - fatorG) < 0.02, JSON.stringify({ fatorM, fatorG }));
    const ex = antes.cursor.x + (antes.g.x - antes.cursor.x) * fatorG;
    const ey = antes.cursor.y + (antes.g.y - antes.cursor.y) * fatorG;
    assert.ok(Math.abs(depois.g.x - ex) <= 1 && Math.abs(depois.g.y - ey) <= 1, JSON.stringify({ dx: depois.g.x - ex, dy: depois.g.y - ey, fatorG }));
    assert.ok(Math.abs(depoisNo.mural.x - antesNo.mural.x) <= 1 && Math.abs(depoisNo.mural.y - antesNo.mural.y) <= 1, JSON.stringify({ mural: depoisNo.mural, antes: antesNo.mural, cursor: antes.cursor }));

    const fundo = await page.evaluate(() => {
      const canvas = document.getElementById('grafo-canvas');
      for (let y = 48; y < innerHeight - 80; y += 28) {
        for (let x = 36; x < innerWidth - 36; x += 28) {
          if (document.elementFromPoint(x, y) === canvas) return { x, y };
        }
      }
      return null;
    });
    assert.ok(fundo, 'sem ponto livre no canvas');
    const antesFundo = await page.evaluate(amostraZoom, 'kochpac');
    await page.mouse.move(fundo.x, fundo.y);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(k => window.mural.getState().camera.k > k + 0.02, antesFundo.mk, { timeout: 4000 });
    await assentar(page);
    const depoisFundo = await page.evaluate(amostraZoom, 'kochpac');
    const fatorMf = depoisFundo.mk / antesFundo.mk;
    const fatorGf = depoisFundo.gz / antesFundo.gz;
    assert.ok(Math.abs(fatorMf - fatorGf) < 0.02, JSON.stringify({ fatorMf, fatorGf }));
    const fx = fundo.x + (antesFundo.g.x - fundo.x) * fatorGf;
    const fy = fundo.y + (antesFundo.g.y - fundo.y) * fatorGf;
    assert.ok(Math.abs(depoisFundo.g.x - fx) <= 1 && Math.abs(depoisFundo.g.y - fy) <= 1, JSON.stringify({ dx: depoisFundo.g.x - fx, dy: depoisFundo.g.y - fy }));

    const cdp = await context.newCDPSession(page);
    const toques = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })),
    });
    const antesPinca = await page.evaluate(amostraZoom, 'ipes');
    const cx = antesPinca.cursor.x, cy = antesPinca.cursor.y;
    await toques('touchStart', [{ x: cx - 36, y: cy }, { x: cx + 36, y: cy }]);
    for (let i = 1; i <= 6; i++) {
      await toques('touchMove', [{ x: cx - 36 - i * 8, y: cy }, { x: cx + 36 + i * 8, y: cy }]);
      await page.waitForTimeout(20);
    }
    await toques('touchEnd', []);
    await assentar(page);
    const depoisPinca = await page.evaluate(amostraZoom, 'ipes');
    const fatorMp = depoisPinca.mk / antesPinca.mk;
    const fatorGp = depoisPinca.gz / antesPinca.gz;
    assert.ok(fatorMp > 1.05 && fatorGp > 1.05, JSON.stringify({ fatorMp, fatorGp, antes: antesPinca.mk, gz: [antesPinca.gz, depoisPinca.gz] }));
    assert.ok(Math.abs(fatorMp - fatorGp) < 0.03, JSON.stringify({ fatorMp, fatorGp }));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('toque no fundo, arrasto e cancelamento não expandem o duplo toque', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrir(1440, 900);
  try {
    await mapaAberto(page);
    const esperar = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 650)));
    const cenario = (modo) => page.evaluate(modoAtual => {
      const palco = document.getElementById('grafo-palco');
      const no = window.mapaCompleto.pontoNaTela('kochpac');
      if (!no || no.x < 8 || no.y < 8 || no.x > innerWidth - 8 || no.y > innerHeight - 8) return { erro: 'kochpac fora', no };
      const ids = window.mural.getState().visibleNodes;
      const pts = [];
      for (let i = 0; i < ids.length; i++) {
        const p = window.mapaCompleto.pontoNaTela(ids[i]);
        if (p) pts.push(p.x, p.y);
      }
      const canvas = document.getElementById('grafo-canvas').getBoundingClientRect();
      let fundo = null;
      const margem = 40;
      for (let y = canvas.top + 4; y < canvas.bottom - 4 && !fundo; y += 20) {
        for (let x = canvas.left + 4; x < canvas.right - 4; x += 20) {
          let livre = true;
          for (let i = 0; i < pts.length; i += 2) {
            const dx = pts[i] - x, dy = pts[i + 1] - y;
            if (dx * dx + dy * dy < margem * margem) { livre = false; break; }
          }
          if (!livre) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit === document.getElementById('grafo-canvas') || hit === palco) { fundo = { x, y }; break; }
        }
      }
      if (!fundo) return { erro: 'sem fundo', no };
      const disparar = (tipo, x, y) => {
        const pressionado = tipo === 'pointerdown' || tipo === 'pointermove';
        palco.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: x,
          clientY: y,
          button: tipo === 'pointermove' ? -1 : 0,
          buttons: pressionado ? 1 : 0,
          isPrimary: true,
        }));
      };
      const toque = (x, y) => { disparar('pointerdown', x, y); disparar('pointerup', x, y); };
      // Os três toques ficam no mesmo turno: o hashchange do mural só seleciona depois.
      toque(no.x, no.y);
      if (modoAtual === 'fundo') toque(fundo.x, fundo.y);
      else if (modoAtual === 'arrasto') {
        disparar('pointerdown', no.x, no.y);
        disparar('pointermove', no.x + 28, no.y);
        disparar('pointerup', no.x + 28, no.y);
      } else if (modoAtual === 'cancel') {
        disparar('pointerdown', no.x, no.y);
        disparar('pointercancel', no.x, no.y);
      }
      toque(no.x, no.y);
      return { ok: true };
    }, modo);
    const ler = () => page.evaluate(() => {
      const s = window.mural.getState();
      return { view: s.view, n: s.visibleNodes.length, id: s.selected && s.selected.id };
    });

    for (const modo of ['fundo', 'arrasto', 'cancel']) {
      const prep = await cenario(modo);
      assert.ok(prep && prep.ok, modo + ' ' + JSON.stringify(prep));
      await page.waitForFunction(() => {
        const s = window.mural.getState();
        return !!(s.selected && s.selected.id === 'kochpac');
      }, null, { timeout: 4000 });
      // expandir entra num setTimeout depois do hashchange; dá tempo de um falso positivo aparecer.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
      const estado = await ler();
      assert.equal(estado.view, 'all', modo + ' ' + JSON.stringify(estado));
      assert.ok(estado.n > 1000, modo + ' ' + JSON.stringify(estado));
      assert.equal(estado.id, 'kochpac', modo + ' ' + JSON.stringify(estado));
      await esperar();
      const depois = await page.evaluate(() => window.mural.getState().view);
      assert.equal(depois, 'all', modo + ' atrasado ' + depois);
    }
    const prepDuplo = await cenario('duplo');
    assert.ok(prepDuplo && prepDuplo.ok, JSON.stringify(prepDuplo));
    await page.waitForFunction(() => window.mural.getState().view === 'custom', null, { timeout: 4000 });
    const duplo = await ler();
    assert.equal(duplo.view, 'custom', JSON.stringify(duplo));
    assert.equal(duplo.id, 'kochpac', JSON.stringify(duplo));
    assert.ok(duplo.n > 1 && duplo.n < 1644, JSON.stringify(duplo));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

function abrirAnimado(width, height, extra) {
  return abrir(width, height, Object.assign({ reducedMotion: 'no-preference', hasTouch: true }, extra || {}));
}

test('gesto no meio da animação de 280 ms não volta ao alvo', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await page.addInitScript(() => {
      const obs = new MutationObserver(() => {
        if (window.__primeiroZoomUm) return;
        const z = window.__grafo && window.__grafo.zoom();
        if (window.mapaCompleto && window.mapaCompleto.ativo && typeof z === 'number' && Math.abs(z - 1) < 0.04) {
          window.__primeiroZoomUm = {
            z,
            p: window.mapaCompleto.pontoNaTela && window.mapaCompleto.pontoNaTela('kochpac'),
          };
        }
      });
      obs.observe(document, { attributes: true, childList: true, subtree: true });
    });
    await mapaAberto(page);
    const primeiro = await page.evaluate(() => window.__primeiroZoomUm);
    assert.ok(primeiro && primeiro.p && primeiro.p.x > 900, 'zoom≈1 exposto antes do primeiro enquadramento: ' + JSON.stringify(primeiro));
    await page.evaluate(() => {
      document.getElementById('zoom-in').click();
      document.getElementById('zoom-in').click();
    });
    await page.waitForFunction(() => window.__grafo.zoom() > 1.4, null, { timeout: 4000 });
    await assentar(page);
    assert.ok(await page.evaluate(() => window.__grafo.zoom()) > 1.4, 'zoom inicial foi sobrescrito pelo enquadramento tardio');
    // O relógio e o quadro são do teste: o passo de 100 ms cai no meio dos 280,
    // e o de 450 ms depois do gesto não pode puxar a câmera de volta.
    await page.evaluate(() => {
      window.__tGrafo = performance.now();
      window.__grafo.relogio(() => window.__tGrafo);
      document.getElementById('fit').click();
      window.__tGrafo += 100;
      window.__grafo.quadroAnimacao();
    });
    const meio = await page.evaluate(() => ({
      p: window.mapaCompleto.pontoNaTela('kochpac'),
      z: window.__grafo.zoom(),
    }));
    assert.ok(meio.z > 1.08, 'animação deveria estar no meio, zoom ' + meio.z);
    await page.evaluate(() => {
      const palco = document.getElementById('grafo-palco');
      const r = palco.getBoundingClientRect();
      const x = r.left + 48, y = r.top + 72;
      const disparar = (tipo, px, py) => {
        palco.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: px,
          clientY: py,
          button: tipo === 'pointermove' ? -1 : 0,
          buttons: tipo === 'pointerup' ? 0 : 1,
          isPrimary: true,
        }));
      };
      disparar('pointerdown', x, y);
      disparar('pointermove', x + 90, y);
      disparar('pointerup', x + 90, y);
    });
    await assentar(page);
    const gesto = await page.evaluate(() => ({
      p: window.mapaCompleto.pontoNaTela('kochpac'),
      z: window.__grafo.zoom(),
      k: window.mural.getState().camera.k,
    }));
    assert.ok(Math.abs(gesto.p.x - meio.p.x) > 50, JSON.stringify({ meio: meio.p, gesto: gesto.p }));
    await page.evaluate(() => {
      window.__tGrafo += 450;
      window.__grafo.quadroAnimacao();
    });
    await assentar(page);
    const tarde = await page.evaluate(() => ({
      p: window.mapaCompleto.pontoNaTela('kochpac'),
      z: window.__grafo.zoom(),
      k: window.mural.getState().camera.k,
    }));
    assert.ok(Math.abs(tarde.z - gesto.z) < 0.04, JSON.stringify({ gesto: gesto.z, tarde: tarde.z, meio: meio.z }));
    assert.ok(Math.abs(tarde.p.x - gesto.p.x) <= 1.5 && Math.abs(tarde.p.y - gesto.p.y) <= 1.5, JSON.stringify({ gesto: gesto.p, tarde: tarde.p }));
    assert.ok(Math.abs(tarde.k - gesto.k) / gesto.k < 0.02, JSON.stringify({ gesto: gesto.k, tarde: tarde.k }));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('no limite de zoom o mural e o grafo usam o mesmo fator', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    await page.evaluate(() => { location.hash = 'e=ipes'; });
    await page.waitForFunction(() => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === 'ipes' && card);
    }, null, { timeout: 8000 });
    await page.waitForFunction(() => {
      const z = window.__grafo.zoom();
      if (!window.__zoomQuieto) window.__zoomQuieto = { z, n: 0 };
      if (Math.abs(z - window.__zoomQuieto.z) < 0.002) window.__zoomQuieto.n += 1;
      else window.__zoomQuieto = { z, n: 0 };
      return window.__zoomQuieto.n >= 4;
    }, null, { timeout: 4000 });
    const medir = () => page.evaluate(() => {
      const card = document.querySelector('#network .network-node.selected .node-card').getBoundingClientRect();
      return {
        z: window.__grafo.zoom(),
        k: window.mural.getState().camera.k,
        w: card.width,
        h: card.height,
      };
    });
    const rodar = dy => page.evaluate(delta => {
      const palco = document.getElementById('grafo-palco');
      const r = palco.getBoundingClientRect();
      palco.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.left + 36,
        clientY: r.top + 48,
        deltaY: delta,
        deltaMode: 0,
      }));
    }, dy);
    const esperarRoda = async () => { await assentar(page); await assentar(page); };
    let anterior = await medir();
    for (let i = 0; i < 16 && anterior.z > 0.56; i++) {
      await rodar(120);
      await esperarRoda();
      const agora = await medir();
      if (agora.z > anterior.z - 0.001) break;
      anterior = agora;
    }
    const noMinimo = await medir();
    assert.ok(noMinimo.z < 0.57, 'não chegou no mínimo ' + noMinimo.z);
    await rodar(120);
    await esperarRoda();
    const aposMin = await medir();
    const fatorZm = aposMin.z / noMinimo.z;
    const fatorKm = aposMin.k / noMinimo.k;
    assert.ok(Math.abs(fatorZm - 1) < 0.02 && Math.abs(fatorKm - 1) < 0.02, JSON.stringify({ fatorZm, fatorKm, noMinimo, aposMin }));
    assert.ok(Math.abs(fatorZm - fatorKm) < 0.02, JSON.stringify({ fatorZm, fatorKm }));
    assert.ok(Math.abs(aposMin.w - noMinimo.w) <= 1 && Math.abs(aposMin.h - noMinimo.h) <= 1, JSON.stringify({ noMinimo, aposMin }));

    anterior = aposMin;
    for (let i = 0; i < 24 && anterior.z < 13.9; i++) {
      await rodar(-120);
      await esperarRoda();
      const agora = await medir();
      if (agora.z < anterior.z + 0.001) break;
      anterior = agora;
    }
    const noMaximo = await medir();
    assert.ok(noMaximo.z > 13.5, 'não chegou no máximo ' + noMaximo.z);
    await rodar(-120);
    await esperarRoda();
    const aposMax = await medir();
    const fatorZx = aposMax.z / noMaximo.z;
    const fatorKx = aposMax.k / noMaximo.k;
    assert.ok(Math.abs(fatorZx - 1) < 0.02 && Math.abs(fatorKx - 1) < 0.02, JSON.stringify({ fatorZx, fatorKx, noMaximo, aposMax }));
    assert.ok(Math.abs(fatorZx - fatorKx) < 0.02, JSON.stringify({ fatorZx, fatorKx }));
    assert.ok(Math.abs(aposMax.w - noMaximo.w) <= 1.5 && Math.abs(aposMax.h - noMaximo.h) <= 1.5, JSON.stringify({ noMaximo, aposMax }));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('pinça não dispara o expandir do duplo toque', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    const ler = () => page.evaluate(() => {
      const s = window.mural.getState();
      return { view: s.view, n: s.visibleNodes.length, id: s.selected && s.selected.id };
    });
    const sequencia = modo => page.evaluate(modoAtual => {
      const palco = document.getElementById('grafo-palco');
      const no = window.mapaCompleto.pontoNaTela('kochpac');
      if (!no || no.x < 8 || no.y < 8 || no.x > innerWidth - 8 || no.y > innerHeight - 8) return { erro: 'kochpac fora', no };
      const disparar = (tipo, x, y, id) => {
        const pressionado = tipo === 'pointerdown' || tipo === 'pointermove';
        palco.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          button: tipo === 'pointermove' ? -1 : 0,
          buttons: pressionado ? 1 : 0,
          isPrimary: id === 1,
        }));
      };
      const toque = () => { disparar('pointerdown', no.x, no.y, 1); disparar('pointerup', no.x, no.y, 1); };
      toque();
      if (modoAtual === 'pinca') {
        disparar('pointerdown', no.x - 28, no.y, 1);
        disparar('pointerdown', no.x + 28, no.y, 2);
        disparar('pointermove', no.x - 70, no.y, 1);
        disparar('pointermove', no.x + 70, no.y, 2);
        disparar('pointerup', no.x - 70, no.y, 1);
        disparar('pointerup', no.x + 70, no.y, 2);
      }
      toque();
      return { ok: true, no };
    }, modo);

    const prep = await sequencia('pinca');
    assert.ok(prep && prep.ok, JSON.stringify(prep));
    await page.waitForFunction(() => {
      const s = window.mural.getState();
      return !!(s.selected && s.selected.id === 'kochpac');
    }, null, { timeout: 4000 });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
    const estado = await ler();
    assert.equal(estado.view, 'all', JSON.stringify(estado));
    assert.ok(estado.n > 1000, JSON.stringify(estado));
    assert.equal(estado.id, 'kochpac', JSON.stringify(estado));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 650)));
    assert.equal(await page.evaluate(() => window.mural.getState().view), 'all');

    const duplo = await sequencia('duplo');
    assert.ok(duplo && duplo.ok, JSON.stringify(duplo));
    await page.waitForFunction(() => window.mural.getState().view === 'custom', null, { timeout: 4000 });
    const aberto = await ler();
    assert.equal(aberto.view, 'custom', JSON.stringify(aberto));
    assert.equal(aberto.id, 'kochpac', JSON.stringify(aberto));
    assert.ok(aberto.n > 1 && aberto.n < 1644, JSON.stringify(aberto));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

async function instalarCentro(page) {
  await page.evaluate(() => {
    window.__centroCartao = id => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      if (!card) return null;
      const rede = document.getElementById('network').getBoundingClientRect();
      const insp = document.getElementById('inspector');
      const bottom = innerWidth <= 620 && insp && !insp.hidden ? Math.min(rede.bottom, insp.getBoundingClientRect().top) : rede.bottom;
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const cx = rede.left + rede.width / 2;
      const cy = (rede.top + bottom) / 2;
      const g = window.mapaCompleto.pontoNaTela(id);
      return { x, y, cx, cy, dist: Math.hypot(x - cx, y - cy), g, bottom, top: rede.top, left: rede.left, right: rede.right };
    };
  });
}

test('com dono ativo a alça e o chip trazem o cartão para o centro', { timeout: 180000 }, async () => {
  const id = 'ipes';
  const esperarCentro = (page) => page.waitForFunction(nid => {
    const c = window.__centroCartao(nid);
    return !!(c && c.dist <= 1 && c.y >= c.top - 0.5 && c.y <= c.bottom + 0.5 && c.x >= c.left - 0.5 && c.x <= c.right + 0.5);
  }, id, { timeout: 4000, polling: 'raf' });

  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    await page.evaluate(nid => { location.hash = 'e=' + nid; }, id);
    await page.waitForFunction(nid => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === nid && card);
    }, id, { timeout: 8000 });
    await instalarCentro(page);
    await esperarCentro(page);
    const antesArrasto = await page.evaluate(nid => window.__centroCartao(nid), id);
    await page.mouse.move(antesArrasto.x, antesArrasto.y);
    await page.mouse.down();
    await page.mouse.move(antesArrasto.x + 320, antesArrasto.y, { steps: 8 });
    await page.mouse.up();
    await assentar(page);
    const naBorda = await page.evaluate(nid => window.__centroCartao(nid), id);
    assert.ok(naBorda.dist > 200, 'cartão deveria estar longe do centro ' + JSON.stringify(naBorda));
    await page.locator('#selection-label').click();
    await esperarCentro(page);
    const centro = await page.evaluate(nid => window.__centroCartao(nid), id);
    assert.ok(centro.dist <= 1, JSON.stringify(centro));
    assert.ok(Math.abs((centro.x - naBorda.x) - (centro.g.x - naBorda.g.x)) <= 1, JSON.stringify({ naBorda, centro }));
    assert.ok(Math.abs((centro.y - naBorda.y) - (centro.g.y - naBorda.g.y)) <= 1, JSON.stringify({ naBorda, centro }));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }

  const mobile = await abrirAnimado(393, 852);
  try {
    await mapaAberto(mobile.page);
    await mobile.page.evaluate(nid => { location.hash = 'e=' + nid; }, id);
    await mobile.page.waitForFunction(() => {
      const h = document.getElementById('sheet-handle');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === 'ipes' && document.getElementById('inspector').dataset.sheet === 'half' && h && getComputedStyle(h).display !== 'none');
    }, null, { timeout: 8000 });
    await instalarCentro(mobile.page);
    await esperarCentro(mobile.page);
    const antes = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
    await mobile.page.mouse.move(antes.x, antes.y);
    await mobile.page.mouse.down();
    await mobile.page.mouse.move(antes.x, Math.max(8, antes.y - 160), { steps: 6 });
    await mobile.page.mouse.up();
    await assentar(mobile.page);
    const naBorda = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
    assert.ok(naBorda.dist > 80, 'alça: cartão deveria estar longe do centro ' + JSON.stringify(naBorda));
    await mobile.page.locator('#sheet-handle').focus();
    await mobile.page.keyboard.press('Home');
    await mobile.page.waitForFunction(() => document.getElementById('inspector').dataset.sheet === 'collapsed', null, { timeout: 4000 });
    await esperarCentro(mobile.page);
    const centro = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
    assert.ok(centro.dist <= 1, JSON.stringify(centro));
    assert.ok(Math.abs((centro.x - naBorda.x) - (centro.g.x - naBorda.g.x)) <= 1, JSON.stringify({ naBorda, centro }));
    assert.ok(Math.abs((centro.y - naBorda.y) - (centro.g.y - naBorda.g.y)) <= 1, JSON.stringify({ naBorda, centro }));
    assert.deepEqual(mobile.errors, []);
  } finally { await mobile.context.close(); }
});

test('pinça no cartão não deixa o toque seguinte expandir', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    await instalarCentro(page);
    await page.evaluate(() => { location.hash = 'e=kochpac'; });
    await page.waitForFunction(() => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      const s = window.mural.getState();
      const c = window.__centroCartao && window.__centroCartao('kochpac');
      if (!card || !s.selected || s.selected.id !== 'kochpac' || s.view !== 'all' || s.visibleNodes.length !== 1644 || !c) return false;
      return c.dist <= 1.5 && c.x >= 40 && c.y >= 40 && c.x <= innerWidth - 40 && c.y <= innerHeight - 40;
    }, null, { timeout: 8000, polling: 'raf' });
    await assentar(page);
    const ler = () => page.evaluate(() => {
      const s = window.mural.getState();
      return { view: s.view, n: s.visibleNodes.length, id: s.selected && s.selected.id };
    });
    const sequencia = modo => page.evaluate(modoAtual => {
      const card = document.querySelector('#network .network-node.selected');
      if (!card) return { erro: 'sem cartão' };
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 8 || y < 8 || x > innerWidth - 8 || y > innerHeight - 8) return { erro: 'cartão fora', x, y };
      const disparar = (tipo, px, py, id) => {
        const pressionado = tipo === 'pointerdown' || tipo === 'pointermove';
        card.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: id,
          pointerType: 'touch',
          clientX: px,
          clientY: py,
          button: tipo === 'pointermove' ? -1 : 0,
          buttons: pressionado ? 1 : 0,
          isPrimary: id === 1,
        }));
      };
      const toque = () => { disparar('pointerdown', x, y, 1); disparar('pointerup', x, y, 1); };
      toque();
      if (modoAtual === 'pinca') {
        disparar('pointerdown', x - 28, y, 1);
        disparar('pointerdown', x + 28, y, 2);
        disparar('pointermove', x - 70, y, 1);
        disparar('pointermove', x + 70, y, 2);
        disparar('pointerup', x - 70, y, 1);
        disparar('pointerup', x + 70, y, 2);
      }
      toque();
      return { ok: true, x, y };
    }, modo);

    const prep = await sequencia('pinca');
    assert.ok(prep && prep.ok, JSON.stringify(prep));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
    const estado = await ler();
    assert.equal(estado.view, 'all', JSON.stringify(estado));
    assert.equal(estado.n, 1644, JSON.stringify(estado));
    assert.equal(estado.id, 'kochpac', JSON.stringify(estado));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 650)));
    assert.equal(await page.evaluate(() => window.mural.getState().view), 'all');
    assert.equal(await page.evaluate(() => window.mural.getState().visibleNodes.length), 1644);

    const duplo = await sequencia('duplo');
    assert.ok(duplo && duplo.ok, JSON.stringify(duplo));
    await page.waitForFunction(() => window.mural.getState().view === 'custom', null, { timeout: 4000 });
    const aberto = await ler();
    assert.equal(aberto.view, 'custom', JSON.stringify(aberto));
    assert.equal(aberto.id, 'kochpac', JSON.stringify(aberto));
    assert.ok(aberto.n > 1 && aberto.n < 1644, JSON.stringify(aberto));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('pinça entre cartão e palco não expande e duplo toque continua expandindo', { timeout: 180000 }, async () => {
  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    await instalarCentro(page);
    await page.evaluate(() => { location.hash = 'e=kochpac'; });
    const esperarKochpacCentrado = () => page.waitForFunction(() => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      const s = window.mural.getState();
      const c = window.__centroCartao && window.__centroCartao('kochpac');
      if (!card || !s.selected || s.selected.id !== 'kochpac' || s.view !== 'all' || s.visibleNodes.length !== 1644 || !c) return false;
      return c.dist <= 1.5 && c.x >= 40 && c.y >= 40 && c.x <= innerWidth - 40 && c.y <= innerHeight - 40;
    }, null, { timeout: 8000, polling: 'raf' });
    await esperarKochpacCentrado();
    await assentar(page);

    const ler = () => page.evaluate(() => {
      const s = window.mural.getState();
      return { view: s.view, n: s.visibleNodes.length, id: s.selected && s.selected.id };
    });

    const executar = modo => page.evaluate(modoAtual => {
      const card = document.querySelector('#network .network-node.selected');
      const palco = document.getElementById('grafo-palco');
      if (!card || !palco) return { erro: 'sem elementos' };
      const r = card.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 8 || cy < 8 || cx > innerWidth - 8 || cy > innerHeight - 8) return { erro: 'cartão fora', cx, cy };
      const px = Math.min(innerWidth - 40, r.right + 80);
      const py = cy;
      const disparar = (alvo, tipo, x, y, id) => {
        const pressionado = tipo === 'pointerdown' || tipo === 'pointermove';
        alvo.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          button: tipo === 'pointermove' ? -1 : 0,
          buttons: pressionado ? 1 : 0,
          isPrimary: id === 1,
        }));
      };
      const toqueCartao = () => {
        disparar(card, 'pointerdown', cx, cy, 1);
        disparar(card, 'pointerup', cx, cy, 1);
      };
      toqueCartao();
      if (modoAtual === 'cartao-palco') {
        disparar(card, 'pointerdown', cx, cy, 1);
        disparar(palco, 'pointerdown', px, py, 2);
        disparar(palco, 'pointermove', px + 70, py, 2);
        disparar(card, 'pointerup', cx, cy, 1);
        disparar(palco, 'pointerup', px + 70, py, 2);
      } else if (modoAtual === 'cartao-palco-mais-toque') {
        disparar(card, 'pointerdown', cx, cy, 1);
        disparar(palco, 'pointerdown', px, py, 2);
        disparar(palco, 'pointermove', px + 70, py, 2);
        disparar(card, 'pointerup', cx, cy, 1);
        disparar(palco, 'pointerup', px + 70, py, 2);
        toqueCartao();
      } else if (modoAtual === 'palco-cartao') {
        disparar(palco, 'pointerdown', px, py, 1);
        disparar(card, 'pointerdown', cx, cy, 2);
        disparar(palco, 'pointermove', px + 70, py, 1);
        disparar(card, 'pointerup', cx, cy, 2);
        disparar(palco, 'pointerup', px + 70, py, 1);
        toqueCartao();
      } else if (modoAtual === 'duplo') {
        toqueCartao();
      }
      return { ok: true, cx, cy, px, py };
    }, modo);

    for (const modo of ['cartao-palco', 'cartao-palco-mais-toque', 'palco-cartao']) {
      const res = await executar(modo);
      assert.ok(res && res.ok, modo + ': ' + JSON.stringify(res));
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
      const est = await ler();
      assert.equal(est.view, 'all', modo + ': ' + JSON.stringify(est));
      assert.equal(est.n, 1644, modo + ': ' + JSON.stringify(est));
      assert.equal(est.id, 'kochpac', modo + ': ' + JSON.stringify(est));
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 650)));
      assert.equal(await page.evaluate(() => window.mural.getState().view), 'all', modo);
      assert.equal(await page.evaluate(() => window.mural.getState().visibleNodes.length), 1644, modo);
    }

    const duplo = await executar('duplo');
    assert.ok(duplo && duplo.ok, JSON.stringify(duplo));
    await page.waitForFunction(() => window.mural.getState().view === 'custom', null, { timeout: 4000 });
    const aberto = await ler();
    assert.equal(aberto.view, 'custom', JSON.stringify(aberto));
    assert.equal(aberto.id, 'kochpac', JSON.stringify(aberto));
    assert.ok(aberto.n > 1 && aberto.n < 1644, JSON.stringify(aberto));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('zoom dos botões e pan durante a recentralização do chip ou da alça não são desfeitos', { timeout: 180000 }, async () => {
  const id = 'ipes';
  const esperarCentro = page => page.waitForFunction(nid => {
    const c = window.__centroCartao(nid);
    return !!(c && c.dist <= 1.5 && c.y >= c.top - 0.5 && c.y <= c.bottom + 0.5 && c.x >= c.left - 0.5 && c.x <= c.right + 0.5);
  }, id, { timeout: 4000, polling: 'raf' });

  const { context, page, errors } = await abrirAnimado(1440, 900);
  try {
    await mapaAberto(page);
    await instalarCentro(page);
    await page.evaluate(nid => { location.hash = 'e=' + nid; }, id);
    await page.waitForFunction(nid => {
      const card = document.querySelector('#network .network-node.selected .node-card');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === nid && card);
    }, id, { timeout: 8000 });
    await esperarCentro(page);

    const c0 = await page.evaluate(nid => window.__centroCartao(nid), id);
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    await page.mouse.move(c0.x + 240, c0.y, { steps: 6 });
    await page.mouse.up();
    await assentar(page);

    // Inicia recentralização pelo chip e, no meio do tween de 240 ms do mural, aciona zoom-in (1.25x).
    const duranteZoom = await page.evaluate(() => new Promise(resolve => {
      document.getElementById('selection-label').click();
      requestAnimationFrame(() => {
        const z0 = window.__grafo.zoom();
        const k0 = window.mural.getState().camera.k;
        document.getElementById('zoom-in').click();
        const z1 = window.__grafo.zoom();
        const k1 = window.mural.getState().camera.k;
        setTimeout(() => {
          resolve({
            z0,
            k0,
            z1,
            k1,
            zFim: window.__grafo.zoom(),
            kFim: window.mural.getState().camera.k,
          });
        }, 360);
      });
    }));
    assert.ok(Math.abs(duranteZoom.z1 / duranteZoom.z0 - 1.25) < 0.02, JSON.stringify(duranteZoom));
    assert.ok(Math.abs(duranteZoom.zFim / duranteZoom.z0 - 1.25) < 0.02, 'recentralização desfez o zoom do botão: ' + JSON.stringify(duranteZoom));
    assert.ok(Math.abs(duranteZoom.kFim / duranteZoom.k0 - 1.25) < 0.02, 'mural perdeu o zoom do botão: ' + JSON.stringify(duranteZoom));

    // Durante outra recentralização pelo chip, um pan próprio também revoga o acompanhamento do centro.
    const durantePan = await page.evaluate(nid => new Promise(resolve => {
      document.getElementById('selection-label').click();
      requestAnimationFrame(() => {
        const palco = document.getElementById('grafo-palco');
        const r = palco.getBoundingClientRect();
        const x = r.left + 60, y = r.top + 80;
        const disparar = (tipo, px, py) => {
          palco.dispatchEvent(new PointerEvent(tipo, {
            bubbles: true,
            cancelable: true,
            view: window,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: px,
            clientY: py,
            button: tipo === 'pointermove' ? -1 : 0,
            buttons: tipo === 'pointerup' ? 0 : 1,
            isPrimary: true,
          }));
        };
        disparar('pointerdown', x, y);
        disparar('pointermove', x + 110, y);
        disparar('pointerup', x + 110, y);
        requestAnimationFrame(() => {
          const logoApos = window.__centroCartao(nid);
          setTimeout(() => {
            resolve({ logoApos, fim: window.__centroCartao(nid) });
          }, 360);
        });
      });
    }), id);
    assert.ok(Math.abs(durantePan.fim.x - durantePan.logoApos.x) <= 1.5 && Math.abs(durantePan.fim.y - durantePan.logoApos.y) <= 1.5, JSON.stringify(durantePan));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }

  const mobile = await abrirAnimado(393, 852);
  try {
    await mapaAberto(mobile.page);
    await instalarCentro(mobile.page);
    await mobile.page.evaluate(nid => { location.hash = 'e=' + nid; }, id);
    await mobile.page.waitForFunction(() => {
      const h = document.getElementById('sheet-handle');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === 'ipes' && document.getElementById('inspector').dataset.sheet === 'half' && h && getComputedStyle(h).display !== 'none');
    }, null, { timeout: 8000 });
    await esperarCentro(mobile.page);

    for (const encerramento of ['pointercancel', 'lostpointercapture']) {
      const antes = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
      await mobile.page.mouse.move(antes.x, antes.y);
      await mobile.page.mouse.down();
      await mobile.page.mouse.move(antes.x, Math.max(8, antes.y - 140), { steps: 6 });
      await mobile.page.mouse.up();
      await assentar(mobile.page);
      const longe = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
      assert.ok(longe.dist > 60, encerramento + ': deveria estar fora do centro ' + JSON.stringify(longe));

      const alca = await mobile.page.evaluate(() => {
        const r = document.getElementById('sheet-handle').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await mobile.page.mouse.move(alca.x, alca.y);
      await mobile.page.mouse.down();
      await mobile.page.evaluate(({ tipo, x, y }) => {
        const h = document.getElementById('sheet-handle');
        h.dispatchEvent(new PointerEvent(tipo, {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 0,
          isPrimary: true,
        }));
      }, { tipo: encerramento, x: alca.x, y: alca.y });
      await mobile.page.mouse.up();
      await esperarCentro(mobile.page);
      const centrado = await mobile.page.evaluate(nid => window.__centroCartao(nid), id);
      assert.ok(centrado.dist <= 1.5, encerramento + ': ' + JSON.stringify(centrado));
    }
    assert.deepEqual(mobile.errors, []);
  } finally { await mobile.context.close(); }
});

test('puxarGrafo respeita o piso de zoom com painel expandido em tela móvel baixa', { timeout: 180000 }, async () => {
  const id = 'ipes';
  const { context, page, errors } = await abrirAnimado(393, 500);
  try {
    await mapaAberto(page);
    await instalarCentro(page);
    await page.evaluate(nid => { location.hash = 'e=' + nid; }, id);
    await page.waitForFunction(() => {
      const h = document.getElementById('sheet-handle');
      return !!(window.mural.getState().selected && window.mural.getState().selected.id === 'ipes' && document.getElementById('inspector').dataset.sheet === 'half' && h && getComputedStyle(h).display !== 'none');
    }, null, { timeout: 8000 });
    await page.waitForFunction(nid => {
      const c = window.__centroCartao(nid);
      return !!(c && c.dist <= 1.5);
    }, id, { timeout: 4000, polling: 'raf' });

    await page.locator('#sheet-handle').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.getElementById('inspector').dataset.sheet === 'expanded', null, { timeout: 4000 });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 360)));
    await assentar(page);

    const noPiso = await page.evaluate(nid => {
      const card = document.querySelector('#network .network-node.selected .node-card').getBoundingClientRect();
      return {
        z: window.__grafo.zoom(),
        k: window.mural.getState().camera.k,
        card: { x: card.left + card.width / 2, y: card.top + card.height / 2 },
        g: window.mapaCompleto.pontoNaTela(nid),
      };
    }, id);
    assert.ok(noPiso.z >= 0.545 && noPiso.z <= 0.56, 'zoom caiu abaixo do piso 0.55: ' + JSON.stringify(noPiso));
    assert.ok(Math.abs(noPiso.card.x - noPiso.g.x) <= 1.5 && Math.abs(noPiso.card.y - noPiso.g.y) <= 1.5, JSON.stringify(noPiso));

    await page.evaluate(() => document.getElementById('zoom-out').click());
    await assentar(page);
    const aposOut = await page.evaluate(() => ({
      z: window.__grafo.zoom(),
      k: window.mural.getState().camera.k,
    }));
    assert.ok(Math.abs(aposOut.z / noPiso.z - 1) < 0.02, 'zoom-out saltou: ' + JSON.stringify({ noPiso, aposOut }));
    assert.ok(Math.abs(aposOut.k / noPiso.k - 1) < 0.02, 'mural saltou no zoom-out: ' + JSON.stringify({ noPiso, aposOut }));

    await page.evaluate(() => document.getElementById('zoom-in').click());
    await assentar(page);
    const aposIn = await page.evaluate(() => ({
      z: window.__grafo.zoom(),
      k: window.mural.getState().camera.k,
    }));
    const fatorZ = aposIn.z / noPiso.z;
    const fatorK = aposIn.k / noPiso.k;
    assert.ok(Math.abs(fatorZ - 1.25) < 0.02 && Math.abs(fatorK - 1.25) < 0.02, JSON.stringify({ fatorZ, fatorK, noPiso, aposIn }));
    assert.ok(Math.abs(fatorZ - fatorK) < 0.02, JSON.stringify({ fatorZ, fatorK }));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
