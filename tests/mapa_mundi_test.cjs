'use strict';
// Mapa-múndi F1. Servidor local, um navegador, toque via CDP.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { arquivoDoSite } = require('./site_files.cjs');

const root = path.resolve(__dirname, '..');
const prints = path.resolve(root, '../prints');

function ariaN(page) {
  return page.evaluate(() => document.querySelectorAll('#map-mode [aria-current]').length);
}

function sobreposicao(page) {
  return page.evaluate(() => {
    const painel = document.querySelector('.mm-painel');
    const itens = [...painel.querySelectorAll('#alca, #mm-conteudo > .ptitulo, #mm-conteudo > .conta, #mm-conteudo > h3, #mm-conteudo > ul, #mm-conteudo > .ajuda, #mm-conteudo > .leg-painel')];
    const vis = itens.map(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { t: String(el.id || el.className || el.tagName).slice(0, 40), x: r.x, y: r.y, w: r.width, h: r.height, d: s.display, v: s.visibility };
    }).filter(r => r.d !== 'none' && r.v !== 'hidden' && r.w > 1 && r.h > 1);
    const hits = [];
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = vis[i], b = vis[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 2 && oy > 2) hits.push([a.t, b.t, Math.round(ox), Math.round(oy)]);
      }
    }
    return hits;
  });
}

function lerSetas() {
  function dif(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }
  const svg = document.getElementById('mapa');
  const ctm = svg.getScreenCTM();
  function para(x, y) {
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return [p.x, p.y];
  }
  return [...document.querySelectorAll('#mm-fora .fora')].map(el => {
    const box = el.getBoundingClientRect();
    const seta = el.querySelector('path.seta');
    const m = seta.getScreenCTM();
    const marcada = (seta.getAttribute('data-ponta') || '').split(',').map(Number);
    const okMarca = marcada.length === 2 && marcada.every(n => Number.isFinite(n));
    let ponta = null;
    let centro = null;
    if (okMarca) {
      const p = new DOMPoint(marcada[0], marcada[1]).matrixTransform(m);
      ponta = [p.x, p.y];
      const bb = seta.getBBox();
      const c = new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2).matrixTransform(m);
      centro = [c.x, c.y];
    }
    const iso = el.getAttribute('data-iso');
    const resto = (el.getAttribute('data-resto') || '').split(',').filter(Boolean);
    const alvos = iso && iso !== '+' ? [iso] : resto;
    let sx = 0, sy = 0, n = 0;
    alvos.forEach(id => {
      const q = window.__mapa.ponto(id);
      if (!q) return;
      const s = para(q[0], q[1]);
      sx += s[0];
      sy += s[1];
      n++;
    });
    const meioX = box.left + box.width / 2;
    const meioY = box.top + box.height / 2;
    const ang = ponta && centro ? Math.atan2(ponta[1] - centro[1], ponta[0] - centro[0]) * 180 / Math.PI : null;
    const real = n ? Math.atan2(sy / n - meioY, sx / n - meioX) * 180 / Math.PI : null;
    const coincide = !!(ponta && centro && Math.hypot(ponta[0] - centro[0], ponta[1] - centro[1]) > 1);
    return {
      nome: el.querySelector('text') ? el.querySelector('text').textContent : '',
      iso,
      ang: ang == null ? null : Math.round(ang * 10) / 10,
      real: real == null ? null : Math.round(real * 10) / 10,
      delta: ang == null || real == null ? null : Math.round(dif(ang, real) * 10) / 10,
      coincide
    };
  });
}

function ordemPainel(page) {
  return page.evaluate(() => {
    const kids = [...document.querySelectorAll('#mm-conteudo > *')];
    const i = cls => kids.findIndex(e => e.classList.contains(cls));
    return { nome: i('ptitulo'), resumo: i('conta'), lista: i('ligados'), hist: i('casos'), leg: i('leg-painel'), n: kids.length };
  });
}

function gzip9(file) {
  return Number(execFileSync('gzip', ['-9', '-c', file], { cwd: root }).length);
}

test('MM-02 e MM-05: derivação, JSON público e tamanhos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-r0-'));
  const nucleo = {
    versao: 'teste',
    nos: [
      { id: 'sem_base', nome: 'Casa no Brasil', tipo: 'empresa', nucleo: 'x', pais_sede: 'US' },
      { id: 'sede', nome: 'Casa no Brasil', tipo: 'empresa', nucleo: 'x', pais_sede: 'FR', pais_base: 'fonte', pais_historico: 'França' },
      { id: 'va', nome: 'Cúria de teste', tipo: 'instituicao', nucleo: 'x', pais_sede: 'VA', pais_base: 'fonte', ano: 1800 }
    ],
    conexoes: [],
    casos: [],
    fontes: []
  };
  fs.writeFileSync(path.join(tmp, 'nucleo.json'), JSON.stringify(nucleo));
  fs.writeFileSync(path.join(tmp, 'extensao.json'), JSON.stringify({ nos: [], conexoes: [], casos: [], fontes: [] }));
  execFileSync('python3', [
    'mapa-mundi/derivar_paises.py',
    '--nucleo', path.join(tmp, 'nucleo.json'),
    '--extensao', path.join(tmp, 'extensao.json'),
    '--saida', path.join(tmp, 'dados-mundo.json'),
    '--interno', path.join(tmp, 'interno')
  ], { cwd: root });
  const saida = JSON.parse(fs.readFileSync(path.join(tmp, 'dados-mundo.json'), 'utf8'));
  const ids = Object.values(saida.paises).flatMap(p => p.fichas.map(f => f[0]));
  assert.equal(ids.includes('sem_base'), false, 'sem pais_base não ganha país');
  assert.equal(saida.paises.FR.fichas[0][0], 'sede');
  assert.equal(saida.paises.FR.nome, 'França');
  assert.equal(saida.paises.US, undefined, 'o nome Brasil não vence a sede');
  assert.equal(saida.paises.VA.fichas[0][3], 'Estados Pontifícios');
  const pub = fs.readFileSync(path.join(root, 'mapa-mundi/dados-mundo.json'), 'utf8');
  for (const w of ['regra', 'pais_base', 'revisar', 'deduzido']) assert.equal(pub.includes(w), false, w);
  const dados = JSON.parse(pub);
  assert.equal(Object.keys(dados.paises).length, 32);
  assert.equal(Object.values(dados.paises).reduce((n, p) => n + p.fichas.length, 0), 940);
  const h1 = execFileSync('shasum', ['-a', '256', 'mapa-mundi/dados-mundo.json'], { cwd: root, encoding: 'utf8' }).split(' ')[0];
  execFileSync('python3', ['mapa-mundi/derivar_paises.py'], { cwd: root, encoding: 'utf8' });
  const h2 = execFileSync('shasum', ['-a', '256', 'mapa-mundi/dados-mundo.json'], { cwd: root, encoding: 'utf8' }).split(' ')[0];
  assert.equal(h1, h2);

  const html = fs.readFileSync(path.join(root, 'mapa', 'index.html'));
  assert.ok(html.length < 400000, 'mapa/index ' + html.length);
  assert.ok(gzip9('mapa/index.html') < 120000, 'mapa/index gzip');
  const mods = ['mapa-mundi/mapa-mundi.js', 'mapa-mundi/mapa-mundi.css', 'mapa-mundi/rotulos-pt.js', 'mapa-mundi/vendor/d3-mapa.min.js', 'mapa-mundi/vendor/countries-110m.json', 'mapa-mundi/dados-mundo.json'];
  const soma = mods.reduce((n, f) => n + gzip9(f), 0);
  assert.ok(soma <= 150000, 'módulo gzip ' + soma);
  const texto = html.toString('utf8');
  assert.equal(texto.match(/mapa-mundi\/carregar\.js/g).length, 1);
  assert.equal((texto.match(/<script src="\/mapa-mundi\/carregar\.js" defer><\/script>/g) || []).length, 1);
});

test('rótulos pt-BR cobrem cada valor exibido e o JSON público continua cru', () => {
  const vm = require('node:vm');
  const lista = JSON.parse(execFileSync('python3', ['mapa-mundi/listar_rotulos.py'], { cwd: root, encoding: 'utf8' }));
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'mapa-mundi/rotulos-pt.js'), 'utf8'), ctx);
  const mapa = ctx.window.ROTULOS_PT;
  const faltam = lista.filter(k => !Object.prototype.hasOwnProperty.call(mapa, k));
  assert.deepEqual(faltam, []);
  assert.equal(lista.length, Object.keys(mapa).length);
  const outra = JSON.parse(execFileSync('python3', ['mapa-mundi/listar_rotulos.py'], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(outra, lista);
  const pub = fs.readFileSync(path.join(root, 'mapa-mundi/dados-mundo.json'), 'utf8');
  assert.ok(pub.includes('relacoes_diplomaticas'));
  assert.ok(pub.includes('orgao_que_emite_decisao'));
  assert.ok(pub.includes('participacao_sindicato_bancario'));
  assert.equal(pub.includes('relações diplomáticas'), false);
});

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.webmanifest')) return 'application/manifest+json';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function servir(override) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end('globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:"https://ozeiyqpbtggvuyhplisa.supabase.co",supabaseAnonKey:"public-test-placeholder"};');
        return;
      }
      if (override.json && pathname === '/mapa-mundi/dados-mundo.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(override.json);
        return;
      }
      const file = arquivoDoSite(root, pathname);
      if (!file) { res.writeHead(403); res.end(); return; }
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  return server;
}

async function launch() {
  return chromium.launch({ headless: true, channel: 'chrome' });
}

async function touch(cdp, type, pts) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map(([x, y], i) => ({ x, y, id: i }))
  });
}

function contraste(fg, bg) {
  const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const L = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const a = L(fg), b = L(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('Mapa-múndi: toque, rotas, XP, CSP e carga sob demanda', { timeout: 240000 }, async () => {
  const html = fs.readFileSync(path.join(root, 'mapa', 'index.html'), 'utf8');
  const views = JSON.parse(html.match(/<script id="research-views" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const tema = views.find(v => v.grupo === 'tema').id;
  const nucleo = JSON.parse(fs.readFileSync(path.join(root, 'dados-nucleo.json'), 'utf8'));
  const entity = nucleo.nos[0].id;
  const override = { json: null };
  const server = servir(override);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  fs.mkdirSync(prints, { recursive: true });
  const proibir = /(?:^|[^\p{L}])(?:pendência|revisar|deduzido)(?=$|[^\p{L}])|1\.644/u;

  async function contexto(opts) {
    const context = await browser.newContext(Object.assign({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      isMobile: false,
      deviceScaleFactor: 1,
      serviceWorkers: 'block'
    }, opts));
    await context.addInitScript(() => {
      localStorage.setItem('aion.tutorial', 'visto-v1');
      localStorage.setItem('aion.dica-toque', 'visto-v1');
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', ev => window.__csp.push(ev.effectiveDirective || ev.violatedDirective || 'csp'));
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    return { context, page, errors };
  }

  try {
    // Carga sob demanda e rotas, sem abrir o mapa.
    {
      const { context, page, errors } = await contexto();
      const pedidos = [];
      page.on('request', r => pedidos.push(r.url()));
      await page.goto(origin + '/mapa/');
      await page.waitForFunction(() => window.mural);
      assert.equal(await page.evaluate(() => window.mural.getState().view), 'temas');
      assert.equal(await page.locator('#mapa-mundi-tela').count(), 0);
      assert.equal(await ariaN(page), 1, 'home');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#map-mode [data-mapa-completo]')).borderTopWidth), '2px');
      for (const [hash, view] of [['#all', 'all'], ['#' + tema, tema], ['#OP01', 'caso:OP01']]) {
        await page.evaluate(() => localStorage.removeItem('codigos-do-poder:mural:v26'));
        await page.goto(origin + '/mapa/' + hash);
        await page.waitForFunction(v => window.mural && window.mural.getState().view === v, view);
        assert.equal(await page.locator('#mapa-mundi-tela:not([hidden])').count(), 0, hash);
        if (hash === '#all' || hash === '#' + tema) assert.equal(await ariaN(page), 1, hash);
      }
      await page.goto(origin + '/mapa/#e=' + encodeURIComponent(entity));
      await page.waitForFunction(() => window.mural);
      await page.locator('#inspector').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#mapa-mundi-tela:not([hidden])').count(), 0);
      const vazou = pedidos.filter(u => u.includes('mapa-mundi/vendor/') || u.includes('dados-mundo.json') || u.includes('mapa-mundi.css') || u.includes('mapa-mundi.js') || u.includes('rotulos-pt.js'));
      assert.deepEqual(vazou, []);
      assert.ok(pedidos.some(u => u.includes('mapa-mundi/carregar.js')));
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    {
      const { context, page, errors } = await contexto();
      const pedidos = [];
      page.on('request', r => pedidos.push(r.url()));
      await page.goto(origin + '/mapa/#mundo');
      await page.waitForFunction(() => window.mural && window.mural.getState().view === 'temas' && location.hash === '#mundo');
      assert.equal(await page.locator('#mapa-mundi-tela:not([hidden])').count(), 0);
      await page.evaluate(() => document.getElementById('scope-global').click());
      await page.waitForFunction(() => window.mural.getState().view === 'mundo');
      assert.match(await page.evaluate(() => document.getElementById('map-title').textContent), /Rothschild/);
      assert.equal(await page.evaluate(() => location.hash), '#mundo');
      assert.equal(pedidos.some(u => u.includes('mapa-mundi/vendor/') || u.includes('dados-mundo.json')), false);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Desktop: teclado, links, contraste, Brasil.
    {
      const { context, page, errors } = await contexto();
      await page.goto(origin + '/mapa/#mapa-mundi');
      await page.waitForSelector('path[data-iso="BR"]');
      await page.waitForFunction(() => document.querySelector('[data-mapa-mundi]')?.getAttribute('aria-current') === 'page');
      const aria = await page.evaluate(() => [...document.querySelectorAll('#map-mode button')].map(b => [b.getAttribute('data-mapa-mundi') !== null ? 'mundi' : b.getAttribute('data-modo-temas') !== null ? 'temas' : 'completo', b.getAttribute('aria-current')]));
      assert.deepEqual(aria.filter(x => x[1] === 'page').map(x => x[0]), ['mundi']);
      assert.equal(await ariaN(page), 1, '#mapa-mundi');
      const chrome = await page.evaluate(() => {
        const tb = document.querySelector('.topbar').getBoundingClientRect();
        const nav = document.getElementById('map-mode').getBoundingClientRect();
        const tela = document.getElementById('mapa-mundi-tela').getBoundingClientRect();
        const botoes = ['#tutorial-open', '#auth-button', '#chat-open'].map(s => {
          const e = document.querySelector(s);
          const r = e.getBoundingClientRect();
          return { s, t: e.textContent.trim(), h: r.height, d: getComputedStyle(e).display };
        });
        return {
          brand: document.querySelector('.brand').innerText,
          tbH: tb.height,
          tbBottom: tb.bottom,
          tbDisplay: getComputedStyle(document.querySelector('.topbar')).display,
          navTop: nav.top,
          navBottom: nav.bottom,
          telaTop: tela.top,
          borda: getComputedStyle(document.querySelector('#map-mode [data-mapa-completo]')).borderTopWidth,
          botoes
        };
      });
      assert.notEqual(chrome.tbDisplay, 'none');
      assert.match(chrome.brand, /Códigos do Poder/);
      assert.ok(chrome.tbH >= 48, JSON.stringify(chrome));
      assert.ok(chrome.navTop >= chrome.tbBottom - 2 && chrome.navTop - chrome.tbBottom < 8, JSON.stringify(chrome));
      assert.ok(chrome.telaTop >= chrome.navBottom - 2 && chrome.telaTop - chrome.navBottom < 8, JSON.stringify(chrome));
      assert.equal(chrome.borda, '1px');
      for (const b of chrome.botoes) {
        assert.notEqual(b.d, 'none', b.s);
        assert.ok(b.h >= 20, JSON.stringify(b));
      }
      const ancoras = await page.evaluate(() => ({
        US: window.__mapa.ancora('US'),
        FR: window.__mapa.ancora('FR'),
        GB: window.__mapa.ancora('GB'),
        NO: window.__mapa.ancora('NO'),
        RU: window.__mapa.ancora('RU')
      }));
      function noRetangulo(p, nome, lon0, lon1, lat0, lat1) {
        assert.ok(p && p[0] >= lon0 && p[0] <= lon1 && p[1] >= lat0 && p[1] <= lat1, nome + ' ' + JSON.stringify(p));
      }
      noRetangulo(ancoras.US, 'US', -125, -66, 24, 50);
      noRetangulo(ancoras.FR, 'FR', -5, 10, 41, 52);
      noRetangulo(ancoras.GB, 'GB', -8, 2, 49, 61);
      noRetangulo(ancoras.NO, 'NO', 4, 32, 57, 72);
      noRetangulo(ancoras.RU, 'RU', 20, 140, 48, 78);
      const neutro = await page.evaluate(() => {
        const p = document.querySelector('#paises path[data-num="496"]');
        const s = getComputedStyle(p);
        p.focus();
        return {
          tem: p.classList.contains('tem'),
          iso: p.getAttribute('data-iso'),
          tab: p.getAttribute('tabindex'),
          role: p.getAttribute('role'),
          label: p.getAttribute('aria-label'),
          title: p.getAttribute('title'),
          titulos: p.querySelectorAll('title').length,
          cursor: s.cursor,
          foco: document.activeElement === p
        };
      });
      assert.equal(neutro.tem, false);
      assert.equal(neutro.iso, null);
      assert.equal(neutro.tab, null);
      assert.equal(neutro.role, null);
      assert.equal(neutro.label, null);
      assert.equal(neutro.title, null);
      assert.equal(neutro.titulos, 0);
      assert.equal(neutro.foco, false);
      assert.notEqual(neutro.cursor, 'pointer');
      const hashVazio = await page.evaluate(() => location.hash);
      const selVazio = await page.evaluate(() => document.querySelector('path.sel, .pino.sel')?.getAttribute('data-iso') || '');
      await page.locator('#paises path[data-num="496"]').click({ force: true });
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => location.hash), hashVazio);
      assert.equal(await page.evaluate(() => document.querySelector('path.sel, .pino.sel')?.getAttribute('data-iso') || ''), selVazio);
      let foco = null;
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        foco = await page.evaluate(() => {
          const e = document.activeElement;
          if (!e || !e.closest('.paises')) return null;
          const s = getComputedStyle(e);
          return { tag: e.tagName, nome: e.textContent.trim().slice(0, 40), outline: s.outlineStyle, width: s.outlineWidth };
        });
        if (foco) break;
      }
      assert.ok(foco, 'lista de países não recebeu foco');
      assert.equal(foco.tag, 'BUTTON');
      assert.ok(foco.nome.length > 1);
      assert.notEqual(foco.outline, 'none');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^#mapa-mundi\/[A-Z]{2}$/.test(location.hash));
      const antes = await page.evaluate(() => window.__mapa.t);
      await page.locator('#mm-conteudo .fichas a').first().click();
      await page.waitForFunction(() => location.hash.startsWith('#e='));
      await page.waitForFunction(() => document.getElementById('mapa-mundi-tela')?.hidden === true);
      await page.locator('#inspector').waitFor({ state: 'visible' });
      await page.goBack();
      await page.waitForFunction(() => location.hash.startsWith('#mapa-mundi'));
      await page.waitForSelector('#mapa-mundi-tela:not([hidden])');
      assert.deepEqual(await page.evaluate(() => window.__mapa.t), antes);

      await page.evaluate(() => window.__mapa.escolher('BR'));
      await page.waitForFunction(() => location.hash === '#mapa-mundi/BR');
      const caso = page.locator('#mm-conteudo .casos a').first();
      await caso.click();
      await page.waitForFunction(() => /^#OP\d+/.test(location.hash));
      await page.waitForFunction(() => document.getElementById('mapa-mundi-tela').hidden && window.mural.getState().view.startsWith('caso:'));
      await page.goto(origin + '/mapa/#mapa-mundi/BR');
      await page.waitForSelector('path[data-iso="BR"].sel, path.sel[data-iso="BR"]');
      const contr = await page.evaluate(() => {
        function parse(c) {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1].split(',').map(x => Number(x.trim()));
          return p;
        }
        function fundo(el) {
          let n = el;
          while (n) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c && (c.length < 4 || c[3] > 0.4)) return c.slice(0, 3);
            n = n.parentElement;
          }
          return [16, 12, 9];
        }
        return ['#nota', '.ptitulo', '.linha', '.ajuda', '.conta'].map(sel => {
          const el = document.querySelector('#mapa-mundi-tela ' + sel);
          const fg = parse(getComputedStyle(el).color).slice(0, 3);
          return { sel, fg, bg: fundo(el) };
        });
      });
      for (const item of contr) assert.ok(contraste(item.fg, item.bg) >= 4.5, item.sel + ' ' + contraste(item.fg, item.bg).toFixed(2));
      const vazio = await page.evaluate(() => document.querySelector('#paises path:not(.tem)')?.getAttribute('fill'));
      assert.equal(vazio, '#1c1612');
      await page.screenshot({ path: path.join(prints, 'desk-1440-brasil.png') });
      const crus = ['cao ', 'coes', 'orgao', 'diplomatic', 'participacao'];
      for (const iso of ['BR', 'US', 'VA']) {
        await page.evaluate(a => window.__mapa.escolher(a), iso);
        await page.waitForFunction(a => location.hash === '#mapa-mundi/' + a, iso);
        const vis = await page.locator('#mm-conteudo').innerText();
        for (const cru of crus) assert.equal(vis.includes(cru), false, iso + ' contém ' + JSON.stringify(cru));
        if (iso === 'US') {
          await page.locator('#mm-conteudo .ligados li').first().waitFor();
          assert.ok(await page.locator('#mm-conteudo .ligados li').count() >= 1);
          const quadroDesk = await page.evaluate(() => window.__mapa.quadro());
          assert.equal(quadroDesk.ok, true, JSON.stringify(quadroDesk));
          await page.screenshot({ path: path.join(prints, 'desk-1440-eua.png'), fullPage: false });
        }
      }
      assert.match(await page.evaluate(() => { window.__mapa.escolher('BR'); return document.getElementById('mm-conteudo').innerText; }), /relações diplomáticas/);
      assert.match(await page.locator('#mm-conteudo').innerText(), /órgão que emite a decisão/);
      assert.match(await page.locator('#mm-conteudo').innerText(), /participação em sindicato bancário/);
      const pequenos = await page.evaluate(() => [...document.querySelectorAll('#mapa-mundi-tela button, #mapa-mundi-tela a, #map-mode button')].filter(e => {
        if (e.closest('.fichas')) return false;
        const r = e.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight && (r.height < 44 || r.width < 44);
      }).map(e => e.textContent.trim().slice(0, 30) + ' ' + Math.round(e.getBoundingClientRect().height)));
      assert.deepEqual(pequenos, []);
      assert.equal(proibir.test(await page.locator('#mapa-mundi-tela').innerText() + await page.locator('#map-mode').innerText()), false);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Celular em pé: pinça, arrasto, posição, 90%, alvos.
    {
      const { context, page, errors } = await contexto({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
      const cdp = await context.newCDPSession(page);
      await page.goto(origin + '/mapa/#mapa-mundi');
      await page.waitForSelector('path[data-iso="BR"]');
      await page.waitForTimeout(200);
      const texto0 = await page.locator('#mapa-mundi-tela').innerText() + await page.locator('#map-mode').innerText();
      assert.equal(proibir.test(texto0), false, texto0.slice(0, 180));
      const cobertura = await page.evaluate(() => {
        const nota = document.getElementById('nota').getBoundingClientRect();
        const alca = document.getElementById('alca').getBoundingClientRect();
        const gap = alca.top - nota.bottom;
        let minY = Infinity, maxY = -Infinity;
        for (const p of document.querySelectorAll('#paises path')) {
          const b = p.getBoundingClientRect();
          if (!b.height) continue;
          minY = Math.min(minY, b.top);
          maxY = Math.max(maxY, b.bottom);
        }
        const vis = Math.max(0, Math.min(maxY, alca.top) - Math.max(minY, nota.bottom));
        return { gap, vis, ratio: gap ? vis / gap : 0 };
      });
      assert.ok(cobertura.ratio >= 0.9, JSON.stringify(cobertura));
      await page.screenshot({ path: path.join(prints, 'mob-393-mapa.png') });
      const fill = await page.evaluate(() => document.querySelector('#paises path:not(.tem)')?.getAttribute('fill'));
      assert.equal(fill, '#1c1612');

      const T = () => page.evaluate(() => window.__mapa.t);
      const scroll = () => page.evaluate(() => [window.scrollX, window.scrollY, document.scrollingElement.scrollTop]);
      const caixa = await page.locator('path[data-iso="BR"]').boundingBox();
      const alca = await page.locator('#alca').boundingBox();
      const cx = Math.round(caixa.x + caixa.width * 0.45);
      let cy = Math.round(caixa.y + Math.min(caixa.height * 0.35, 80));
      if (cy > alca.y - 20) cy = Math.round(alca.y - 40);
      const k0 = (await T()).k;
      await touch(cdp, 'touchStart', [[cx - 28, cy], [cx + 28, cy]]);
      for (let i = 1; i <= 10; i++) {
        await touch(cdp, 'touchMove', [[cx - 28 - i * 5, cy], [cx + 28 + i * 5, cy]]);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(150);
      const tp = await T();
      assert.ok(tp.k > k0, 'pinça k ' + k0 + ' → ' + tp.k);
      await touch(cdp, 'touchStart', [[cx, cy]]);
      for (let i = 1; i <= 10; i++) {
        await touch(cdp, 'touchMove', [[cx + i * 6, cy - i * 4]]);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(250);
      const pan = await T();
      assert.ok(pan.x !== tp.x || pan.y !== tp.y, JSON.stringify({ tp, pan }));
      assert.deepEqual(await scroll(), [0, 0, 0]);

      const br = await page.locator('path[data-iso="BR"]').boundingBox();
      let tx = br.x + br.width * 0.45, ty = br.y + Math.min(br.height * 0.3, 70);
      if (ty > alca.y - 16) ty = alca.y - 36;
      await page.touchscreen.tap(tx, ty);
      await page.waitForFunction(() => location.hash === '#mapa-mundi/BR');
      const tBR = await T();
      assert.ok(tBR.k <= 6.001, 'zoom ' + tBR.k);
      assert.ok(tBR.k !== pan.k || tBR.x !== pan.x || tBR.y !== pan.y, JSON.stringify({ pan, tBR }));
      await page.evaluate(() => window.__mapa.reler());
      assert.deepEqual(await T(), tBR);
      await page.locator('#mm-conteudo .ligados button[data-iso="US"]').tap();
      await page.waitForFunction(() => location.hash === '#mapa-mundi/US');
      const tUS = await T();
      assert.ok(tUS.k <= 6.001, 'zoom US ' + tUS.k);
      assert.ok(tUS.k !== tBR.k || tUS.x !== tBR.x || tUS.y !== tBR.y, JSON.stringify({ tBR, tUS }));
      await page.evaluate(() => window.__mapa.reler());
      assert.deepEqual(await T(), tUS);
      await page.evaluate(() => window.__mapa.escolher('VA'));
      await page.waitForFunction(() => location.hash === '#mapa-mundi/VA');
      const tVA = await T();
      assert.ok(tVA.k !== tUS.k || tVA.x !== tUS.x || tVA.y !== tUS.y, JSON.stringify({ tUS, tVA }));
      await page.goBack();
      await page.waitForTimeout(200);
      assert.deepEqual(await T(), tUS);

      const antesPainel = await T();
      const antesScroll = await page.locator('#mm-conteudo').evaluate(e => e.scrollTop);
      const box = await page.locator('#mm-conteudo').boundingBox();
      const px = Math.round(box.x + box.width / 2);
      const py = Math.round(box.y + Math.min(90, box.height / 2));
      await touch(cdp, 'touchStart', [[px, py]]);
      for (let i = 1; i <= 8; i++) {
        await touch(cdp, 'touchMove', [[px, py - i * 18]]);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(200);
      const depoisScroll = await page.locator('#mm-conteudo').evaluate(e => e.scrollTop);
      assert.ok(depoisScroll > antesScroll, 'painel ' + antesScroll + ' → ' + depoisScroll);
      assert.deepEqual(await T(), antesPainel);
      assert.deepEqual(await scroll(), [0, 0, 0]);

      for (const iso of ['BR', 'US', 'VA']) {
        await page.evaluate(a => window.__mapa.escolher(a), iso);
        await page.waitForFunction(a => location.hash === '#mapa-mundi/' + a && document.body.classList.contains('folha-aberta') && !document.body.classList.contains('folha-cheia'), iso);
        const caixaPais = await page.evaluate(a => {
          const painel = document.querySelector('.mm-painel').getBoundingClientRect();
          const svg = document.getElementById('mapa').getBoundingClientRect();
          const zoom = document.querySelector('#mapa-mundi-tela .zoom').getBoundingClientRect();
          const nota = document.getElementById('nota').getBoundingClientRect();
          const path = document.querySelector('#paises path.sel[data-iso="' + a + '"], #hist path.sel[data-iso="' + a + '"]');
          const marca = path || document.querySelector('#pinos g.sel[data-iso="' + a + '"] .ponto');
          const r = marca.getBoundingClientRect();
          function cruza(a, b) {
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            return ox > 0.5 && oy > 0.5;
          }
          const botoes = [...document.querySelectorAll('#mm-conteudo .ligados button[data-iso]')].map(el => el.getAttribute('data-iso'));
          const visiveis = botoes.filter(iso => window.__mapa.naTela(iso));
          const fora = [...document.querySelectorAll('#mm-fora .fora')].map(el => {
            const b = el.getBoundingClientRect();
            return {
              iso: el.getAttribute('data-iso'),
              resto: el.getAttribute('data-resto') || '',
              nome: el.querySelector('text') ? el.querySelector('text').textContent : '',
              w: b.width,
              h: b.height,
              cobre: cruza(b, r),
              zoom: cruza(b, zoom),
              nota: cruza(b, nota),
              folha: cruza(b, painel),
              box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
            };
          });
          const representados = [];
          for (const f of fora) {
            if (f.iso && f.iso !== '+') representados.push(f.iso);
            if (f.resto) representados.push(...f.resto.split(',').filter(Boolean));
          }
          return {
            iso: a, top: r.top, bottom: r.bottom, h: r.height, w: r.width,
            painelTop: painel.top, util: svg.width, ratio: r.width / svg.width,
            total: botoes.length, visiveis, representados, fora
          };
        }, iso);
        assert.ok(caixaPais.h > 1 && caixaPais.w > 1, JSON.stringify(caixaPais));
        assert.ok(caixaPais.bottom <= caixaPais.painelTop + 0.5, JSON.stringify(caixaPais));
        if (iso === 'BR' || iso === 'US') assert.ok(caixaPais.ratio >= 0.35, JSON.stringify(caixaPais));
        const visiveis = new Set(caixaPais.visiveis);
        const representados = caixaPais.representados;
        assert.equal(representados.length, new Set(representados).size, JSON.stringify(caixaPais));
        for (const id of representados) assert.equal(visiveis.has(id), false, JSON.stringify(caixaPais));
        const juntos = new Set([...visiveis, ...representados]);
        assert.equal(juntos.size, caixaPais.total, JSON.stringify(caixaPais));
        if (iso === 'BR' && !visiveis.has('US')) {
          const eua = caixaPais.fora.find(f => f.iso === 'US');
          assert.ok(eua && eua.nome === 'EUA', JSON.stringify(caixaPais));
        }
        for (const f of caixaPais.fora) {
          assert.ok(f.w >= 44 && f.h >= 44, JSON.stringify(f));
          assert.ok(f.nome && f.nome.length > 1, JSON.stringify(f));
          assert.equal(f.cobre, false, JSON.stringify(f));
          assert.equal(f.zoom, false, JSON.stringify(f));
          assert.equal(f.nota, false, JSON.stringify(f));
          assert.equal(f.folha, false, JSON.stringify(f));
        }
        const setas = await page.evaluate(lerSetas);
        assert.ok(setas.length > 0, iso + ' sem indicador');
        for (const f of setas) {
          assert.equal(f.coincide, true, JSON.stringify(f));
          assert.ok(f.delta != null && f.delta < 30, JSON.stringify(f));
        }
        for (let i = 0; i < caixaPais.fora.length; i++) {
          for (let j = i + 1; j < caixaPais.fora.length; j++) {
            const a = caixaPais.fora[i].box;
            const b = caixaPais.fora[j].box;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            assert.ok(!(ox > 0.5 && oy > 0.5), JSON.stringify(caixaPais.fora));
          }
        }
      }
      await page.evaluate(() => window.__mapa.escolher('BR'));
      await page.waitForTimeout(200);
      const kPais = (await T()).k;
      await page.locator('#mm-fora .fora').first().click();
      await page.waitForTimeout(150);
      const kConjunto = (await T()).k;
      assert.equal(await page.evaluate(() => location.hash), '#mapa-mundi/BR');
      assert.ok(kConjunto < kPais - 0.05, 'conjunto ' + kPais + ' → ' + kConjunto);
      await page.evaluate(() => window.__mapa.escolher('US'));
      await page.evaluate(() => window.__mapa.escolher('BR'));
      await page.waitForTimeout(200);
      const ordemMeia = await ordemPainel(page);
      assert.ok(ordemMeia.nome < ordemMeia.resumo && ordemMeia.resumo < ordemMeia.lista && ordemMeia.lista < ordemMeia.hist && ordemMeia.hist < ordemMeia.leg && ordemMeia.leg === ordemMeia.n - 1, JSON.stringify(ordemMeia));
      assert.deepEqual(await sobreposicao(page), []);
      await page.locator('#alca').click();
      await page.waitForFunction(() => document.body.classList.contains('folha-cheia'));
      const listaVisivel = await page.evaluate(() => {
        const ul = document.querySelector('#mm-conteudo .ligados');
        const painel = document.querySelector('.mm-painel').getBoundingClientRect();
        const r = ul.getBoundingClientRect();
        return Math.min(r.bottom, painel.bottom) - Math.max(r.top, painel.top) > 20;
      });
      assert.equal(listaVisivel, true);
      assert.deepEqual(await sobreposicao(page), []);
      await page.screenshot({ path: path.join(prints, 'mob-393-brasil-lista.png') });
      const pequenos = await page.evaluate(() => [...document.querySelectorAll('#mapa-mundi-tela button, #mapa-mundi-tela a, #map-mode button')].filter(e => {
        if (e.closest('.fichas')) return false;
        const r = e.getBoundingClientRect();
        const visivel = r.width && r.height && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        return visivel && (r.height < 44 || r.width < 44);
      }).map(e => e.tagName + ' ' + e.textContent.trim().slice(0, 24)));
      assert.deepEqual(pequenos, []);
      assert.equal(proibir.test(await page.locator('#mapa-mundi-tela').innerText()), false);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Coluna dos chips, 3×, só o recorte.
    {
      const { context, page, errors } = await contexto({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      await page.goto(origin + '/mapa/#mapa-mundi/BR');
      await page.waitForSelector('#mm-fora .fora');
      await page.waitForTimeout(200);
      const clip = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#mm-fora .fora')].map(el => el.getBoundingClientRect());
        const left = Math.min(...boxes.map(b => b.left));
        const top = Math.min(...boxes.map(b => b.top));
        const right = Math.max(...boxes.map(b => b.right));
        const bottom = Math.max(...boxes.map(b => b.bottom));
        const pad = 6;
        const x = Math.max(0, Math.floor(left - pad));
        const y = Math.max(0, Math.floor(top - pad));
        return {
          x,
          y,
          width: Math.min(innerWidth - x, Math.ceil(right + pad) - x),
          height: Math.min(innerHeight - y, Math.ceil(bottom + pad) - y)
        };
      });
      await page.screenshot({ path: path.join(prints, 'mob-393-brasil.png'), clip });
      await page.screenshot({ path: path.join(prints, 'mob-393-chips-zoom.png'), clip });
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Paisagem.
    {
      const { context, page, errors } = await contexto({ viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true });
      await page.goto(origin + '/mapa/#mapa-mundi/BR');
      await page.waitForSelector('path[data-iso="BR"]');
      await page.waitForTimeout(250);
      const geo = await page.evaluate(() => {
        const mapa = document.getElementById('mapa').getBoundingClientRect();
        const painel = document.querySelector('.mm-painel').getBoundingClientRect();
        const legMapa = document.querySelector('#mm-palco > .legenda').getBoundingClientRect();
        const legPainel = document.querySelector('.leg-painel').getBoundingClientRect();
        const sobre = !(legMapa.width === 0 || legMapa.height === 0) && legMapa.left < mapa.right && legMapa.right > mapa.left && legMapa.top < mapa.bottom && legMapa.bottom > mapa.top;
        return {
          mapa: mapa.width > 40 && mapa.height > 40,
          painel: painel.width > 40 && painel.height > 40,
          legPainel: legPainel.width > 20 && legPainel.height > 20,
          sobre,
          scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        };
      });
      assert.equal(geo.mapa, true);
      assert.equal(geo.painel, true);
      assert.equal(geo.legPainel, true);
      assert.equal(geo.sobre, false);
      assert.equal(geo.scroll, true);
      for (const iso of ['BR', 'US', 'VA']) {
        await page.evaluate(a => window.__mapa.escolher(a), iso);
        await page.waitForFunction(a => location.hash === '#mapa-mundi/' + a, iso);
        await page.waitForTimeout(150);
        const setas = await page.evaluate(lerSetas);
        for (const f of setas) {
          assert.equal(f.coincide, true, JSON.stringify(f));
          assert.ok(f.delta != null && f.delta < 30, 'paisagem ' + JSON.stringify(f));
        }
      }
      await page.evaluate(() => window.__mapa.escolher('BR'));
      await page.waitForFunction(() => location.hash === '#mapa-mundi/BR');
      const ordemDeitada = await ordemPainel(page);
      assert.ok(ordemDeitada.nome < ordemDeitada.resumo && ordemDeitada.resumo < ordemDeitada.lista && ordemDeitada.lista < ordemDeitada.hist && ordemDeitada.hist < ordemDeitada.leg && ordemDeitada.leg === ordemDeitada.n - 1, JSON.stringify(ordemDeitada));
      assert.deepEqual(await sobreposicao(page), [], 'paisagem');
      await page.screenshot({ path: path.join(prints, 'mob-852-deitado.png') });
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // CPU 4×: primeiro desenho e troca de país.
    {
      const { context, page, errors } = await contexto({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
      const cdp = await context.newCDPSession(page);
      await page.goto(origin + '/mapa/');
      await page.waitForFunction(() => window.mural);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.evaluate(() => {
        window.__lt = [];
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) window.__lt.push({ d: e.duration, start: e.startTime });
        }).observe({ type: 'longtask', buffered: true });
      });
      const t0 = Date.now();
      await page.evaluate(() => { location.hash = 'mapa-mundi'; });
      await page.waitForSelector('path[data-iso="BR"]', { timeout: 8000 });
      const dt = Date.now() - t0;
      assert.ok(dt < 1500, 'primeiro desenho ' + dt + ' ms');
      await page.evaluate(() => { window.__mark = performance.now(); window.__mapa.escolher('US'); });
      await page.waitForTimeout(600);
      const longs = await page.evaluate(() => window.__lt.filter(e => e.start >= window.__mark - 1 && e.d > 100));
      assert.deepEqual(longs, [], JSON.stringify(longs));
      const cdp2 = cdp;
      const caixa = await page.locator('#mapa').boundingBox();
      const x = Math.round(caixa.x + caixa.width / 2), y = Math.round(caixa.y + 80);
      const y0 = await page.evaluate(() => document.scrollingElement.scrollTop);
      await touch(cdp2, 'touchStart', [[x, y]]);
      for (let i = 1; i <= 6; i++) {
        await touch(cdp2, 'touchMove', [[x + i * 8, y + i * 3]]);
        await page.waitForTimeout(16);
      }
      await touch(cdp2, 'touchEnd', []);
      assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), y0);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Fixture XP / URSS, sem mexer nos dados do repositório.
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-xp-'));
      const copia = JSON.parse(fs.readFileSync(path.join(root, 'dados-nucleo.json'), 'utf8'));
      copia.nos.push(
        { id: 'fixture_xp', nome: 'Ficha de teste da Palestina', tipo: 'instituicao', nucleo: 'teste', pais_sede: 'XP', pais_historico: 'Palestina sob Mandato Britânico', pais_base: 'fonte de teste' },
        { id: 'fixture_urss', nome: 'Ficha de teste da URSS', tipo: 'instituicao', nucleo: 'teste', pais_sede: 'RU', pais_historico: 'URSS', pais_base: 'fonte de teste' }
      );
      fs.writeFileSync(path.join(tmp, 'nucleo.json'), JSON.stringify(copia));
      execFileSync('python3', [
        'mapa-mundi/derivar_paises.py',
        '--nucleo', path.join(tmp, 'nucleo.json'),
        '--saida', path.join(tmp, 'dados-mundo.json'),
        '--interno', path.join(tmp, 'interno')
      ], { cwd: root });
      override.json = fs.readFileSync(path.join(tmp, 'dados-mundo.json'));
      const { context, page, errors } = await contexto();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.goto(origin + '/mapa/#mapa-mundi/XP');
      await page.waitForSelector('path[data-iso="XP"]');
      const xp = await page.evaluate(() => {
        const d3 = window.d3mapa;
        const geom = d3.merge(window.__mapa.mundo, window.__mapa.mundo.objects.countries.geometries.filter(g => g.id === '376' || g.id === '275'));
        const d = document.querySelector('#hist path[data-iso="XP"]').getAttribute('d');
        return {
          igual: d === window.__mapa.caminho(geom),
          titulo: document.querySelector('.ptitulo').textContent,
          il: window.__mapa.fichas('IL'),
          ps: window.__mapa.fichas('PS'),
          xp: window.__mapa.fichas('XP'),
          nomeRU: window.__mapa.nome('RU'),
          ilPath: document.querySelectorAll('path[data-iso="IL"]').length,
          psPath: document.querySelectorAll('path[data-iso="PS"]').length
        };
      });
      assert.equal(xp.igual, true);
      assert.equal(xp.titulo, 'Palestina sob Mandato Britânico');
      assert.equal(xp.il, 1);
      assert.equal(xp.ps, 2);
      assert.equal(xp.xp, 1);
      assert.equal(xp.ilPath, 1);
      assert.equal(xp.psPath, 1);
      assert.equal(xp.nomeRU, 'URSS');
      assert.ok((await page.locator('#mm-conteudo').innerText()).includes('Ficha de teste da Palestina'));
      await page.evaluate(() => window.__mapa.escolher('RU'));
      const visivel = await page.evaluate(() => document.getElementById('mapa-mundi-tela').innerText + document.getElementById('map-mode').innerText);
      assert.equal(visivel.includes('Rússia'), false, visivel.slice(0, 400));
      assert.ok(visivel.includes('URSS'));
      const ilTexto = await page.evaluate(() => { window.__mapa.escolher('IL'); return document.getElementById('mm-conteudo').innerText; });
      assert.equal(ilTexto.includes('Ficha de teste da Palestina'), false);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    if (server.listening) await new Promise(r => server.close(r));
  }
});
