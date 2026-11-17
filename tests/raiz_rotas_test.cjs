'use strict';
// Raiz: landing em /, app gerado em /mapa/, redirect dos links antigos.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test, describe, before, after } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { arquivoDoSite } = require('./site_files.cjs');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const SHA_MAPA = 'a6ddfce60fae793a43b4673d43234356e0ccc3207c72321990c42e5074a6b078';

test('raiz serve a landing e /mapa/index.html é o arquivo gerado', () => {
  const landing = read('index.html');
  const mapa = fs.readFileSync(path.join(root, 'mapa', 'index.html'));
  assert.equal(crypto.createHash('sha256').update(mapa).digest('hex'), SHA_MAPA);
  assert.match(landing, /<title>Códigos do Poder — o mapa que a manchete não monta<\/title>/);
  assert.match(landing, /href="\/landing\.css"/);
  assert.doesNotMatch(landing, /id="research-data"|src="\/config\.js"/);
  assert.match(read('mapa/index.html'), /data-nucleo-nos="1644"/);
  assert.match(read('mapa/index.html'), /id="total-count"/);
  assert.equal(fs.existsSync(path.join(root, 'mapa', 'dados-nucleo.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'mapa', 'dados-extensao.json')), false);
  const redirect = read('inicio/index.html');
  assert.match(redirect, /<meta http-equiv="refresh" content="0; url=\/">/);
  assert.match(redirect, /<a href="\/">Códigos do Poder<\/a>/);
  assert.equal(/<script\b/i.test(redirect), false);
  const js = read('inicio/redirecionar-app.js');
  assert.match(js, /location\.replace\('\/mapa\/' \+ search \+ hash\)/);
  assert.match(js, /classList\.add\('redir-app'\)/);
});

function ancorasDoScript(js) {
  const match = js.match(/\/\/ ANCORAS-LANDING:inicio\n\s*var ancoras = (\[[\s\S]*?\]);\n\s*\/\/ ANCORAS-LANDING:fim/);
  assert.ok(match, 'bloco ANCORAS-LANDING');
  return JSON.parse(match[1]);
}

test('redirect preserva query e hash do app e deixa âncora da landing na raiz', () => {
  const js = read('inicio/redirecionar-app.js');
  const run = (hash, search) => {
    const added = [];
    let replaced = null;
    vm.runInNewContext(js, {
      location: { hash, search, replace(url) { replaced = url; } },
      document: { documentElement: { classList: { add(name) { added.push(name); } } } },
      URLSearchParams,
      decodeURIComponent,
    });
    return { replaced, added };
  };
  const fica = { replaced: null, added: [] };
  assert.deepEqual(run('', ''), fica);
  assert.deepEqual(run('#', ''), fica);
  assert.deepEqual(run('', '?utm=1'), fica);
  for (const id of ancorasDoScript(js)) assert.deepEqual(run('#' + id, ''), fica, id);
  assert.deepEqual(run('#planos', ''), fica);
  assert.deepEqual(run('#faq', ''), fica);
  assert.deepEqual(run('#base', ''), fica);
  assert.deepEqual(run('#Planos', ''), { replaced: '/mapa/#Planos', added: ['redir-app'] });
  assert.deepEqual(run('#all', ''), { replaced: '/mapa/#all', added: ['redir-app'] });
  assert.deepEqual(run('#e=ipes', ''), { replaced: '/mapa/#e=ipes', added: ['redir-app'] });
  assert.deepEqual(run('#ent-ipes', ''), { replaced: '/mapa/#ent-ipes', added: ['redir-app'] });
  assert.deepEqual(run('#OP13', ''), { replaced: '/mapa/#OP13', added: ['redir-app'] });
  assert.deepEqual(run('#caso_op13', ''), { replaced: '/mapa/#caso_op13', added: ['redir-app'] });
  assert.deepEqual(run('#mapa-mundi', ''), { replaced: '/mapa/#mapa-mundi', added: ['redir-app'] });
  assert.deepEqual(run('#planos', '?editor=1'), { replaced: '/mapa/?editor=1#planos', added: ['redir-app'] });
  assert.deepEqual(run('#mapa-mundi', '?editor=1'), { replaced: '/mapa/?editor=1#mapa-mundi', added: ['redir-app'] });
  assert.deepEqual(run('', '?debug=1'), { replaced: '/mapa/?debug=1', added: ['redir-app'] });
  assert.deepEqual(run('', '?access_token=abc'), { replaced: '/mapa/?access_token=abc', added: ['redir-app'] });
});

test('a lista de âncoras é a dos ids do index.html e não colide com hash do app', async () => {
  const { idsDoHtml, idsNoScript, aplicar } = await import('../scripts/gerar-ancoras-landing.mjs');
  const html = read('index.html');
  const js = read('inicio/redirecionar-app.js');
  const ids = idsDoHtml(html);
  assert.deepEqual(idsNoScript(js), ids);
  assert.equal(aplicar(js, ids), js);
  for (const id of ['planos', 'faq', 'base', 'exemplos', 'como', 'comecar']) {
    assert.equal(ids.includes(id), true, id);
  }
  for (const hash of ['e=ipes', 'OP13', 'all', 'mapa-mundi']) {
    assert.equal(ids.includes(hash), false, hash);
  }
  for (const id of ids) {
    assert.equal(/^e=/.test(id) || /^OP\d/.test(id) || /^caso_/.test(id) || /^ent-/.test(id), false, id);
  }
});

function tipo(file) {
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

describe('rotas no Chromium', { timeout: 180000 }, () => {
  let server, browser, origin;
  before(async () => {
    server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const file = arquivoDoSite(root, pathname);
        if (!file) { res.writeHead(403); res.end(); return; }
        const body = await fs.promises.readFile(file);
        res.writeHead(200, { 'content-type': tipo(file), 'cache-control': 'no-store' });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function open() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/config.js') {
        return route.fulfill({
          contentType: 'text/javascript',
          body: 'globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:"https://ozeiyqpbtggvuyhplisa.supabase.co",supabaseAnonKey:"public-test-placeholder"};',
        });
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      localStorage.setItem('aion.tutorial', 'visto-v1');
      localStorage.setItem('aion.dica-toque', 'visto-v1');
    });
    const page = await context.newPage();
    return { context, page };
  }

  test('a raiz mostra a landing e /mapa/ mostra 1644', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/');
      assert.equal(new URL(page.url()).pathname, '/');
      assert.match(await page.title(), /o mapa que a manchete não monta/);
      assert.equal(await page.locator('a.marca').getAttribute('href'), '/');
      assert.equal(await page.locator('a', { hasText: 'Entrar' }).getAttribute('href'), '/mapa/');
      await page.goto(origin + '/mapa/');
      await page.waitForFunction(() => window.mural && document.getElementById('total-count')?.textContent === '1644');
      assert.equal(await page.locator('#map-mode-count').textContent(), (1644).toLocaleString('pt-BR'));
      assert.equal(await page.locator('#map-mode-count').isVisible(), true);
      assert.equal(await page.locator('#total-count').textContent(), '1644');
    } finally { await context.close(); }
  });

  test('/#all abre o Mapa completo em /mapa/#all', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/#all');
      await page.waitForURL(url => url.pathname === '/mapa/' && url.hash === '#all');
      await page.waitForFunction(() => window.mural && window.mural.getState().view === 'all');
      const completo = page.locator('#map-mode [data-mapa-completo]');
      assert.equal(await completo.getAttribute('aria-current'), 'page');
      assert.match(await completo.innerText(), /Mapa completo/);
      assert.equal(new URL(page.url()).hash, '#all');
    } finally { await context.close(); }
  });

  test('o id real da entidade IPES é ipes, aberto por #e=ipes; #ent-ipes só preserva o hash', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/#ent-ipes');
      await page.waitForURL(url => url.pathname === '/mapa/' && url.hash === '#ent-ipes');
      await page.waitForFunction(() => window.mural);
      assert.equal(await page.evaluate(() => window.mural.getState().selected?.id || null), null);
      await page.goto(origin + '/#e=ipes');
      await page.waitForURL(url => url.pathname === '/mapa/' && url.hash === '#e=ipes');
      await page.waitForFunction(() => window.mural?.getState().selected?.id === 'ipes');
    } finally { await context.close(); }
  });

  test('#OP13 abre o caso Brother Sam; #caso_op13 é o nó e o hash é preservado', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/#caso_op13');
      await page.waitForURL(url => url.pathname === '/mapa/' && url.hash === '#caso_op13');
      await page.waitForFunction(() => window.mural);
      assert.notEqual(await page.evaluate(() => window.mural.getState().view), 'caso:OP13');
      await page.goto(origin + '/#OP13');
      await page.waitForURL(url => url.pathname === '/mapa/' && url.hash === '#OP13');
      await page.waitForFunction(() => window.mural?.getState().view === 'caso:OP13' && window.mural.getState().selected?.id === 'caso_op13');
    } finally { await context.close(); }
  });

  test('/#planos, /#faq e /#base ficam na landing e a seção entra no viewport', async () => {
    const { context, page } = await open();
    try {
      for (const id of ['planos', 'faq', 'base']) {
        await page.goto(origin + '/#' + id, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const url = new URL(page.url());
        assert.equal(url.pathname, '/', id);
        assert.equal(url.hash, '#' + id, id);
        // html{scroll-behavior:smooth} anima a rolagem do hash; espera o fim.
        await page.waitForFunction(elId => {
          const el = document.getElementById(elId);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return scrollY > 0 && Math.abs(r.top) < 4 && r.bottom > 0;
        }, id);
        const pos = await page.evaluate(elId => {
          const el = document.getElementById(elId);
          const r = el.getBoundingClientRect();
          return {
            top: r.top,
            bottom: r.bottom,
            inner: innerHeight,
            scroll: scrollY,
            escondida: document.documentElement.classList.contains('redir-app'),
          };
        }, id);
        assert.equal(pos.escondida, false, id);
        assert.ok(pos.scroll > 0, id + ' não rolou ' + JSON.stringify(pos));
        assert.ok(pos.bottom > 0 && pos.top < pos.inner, id + ' fora do viewport ' + JSON.stringify(pos));
        assert.ok(pos.top < pos.inner * 0.45, id + ' não ficou no alto da tela ' + JSON.stringify(pos));
      }
    } finally { await context.close(); }
  });

  test('/ sem hash e /# ficam na raiz', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/', { waitUntil: 'load' });
      let url = new URL(page.url());
      assert.equal(url.pathname, '/');
      assert.equal(url.hash, '');
      assert.equal(await page.locator('h1').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('redir-app')), false);
      await page.goto(origin + '/#', { waitUntil: 'load' });
      url = new URL(page.url());
      assert.equal(url.pathname, '/');
      assert.ok(url.hash === '' || url.hash === '#', url.hash);
      assert.match(await page.title(), /o mapa que a manchete não monta/);
      assert.equal(await page.evaluate(() => location.pathname), '/');
    } finally { await context.close(); }
  });

  test('/inicio/ redireciona para a landing', async () => {
    const { context, page } = await open();
    try {
      await page.goto(origin + '/inicio/');
      await page.waitForURL(url => url.pathname === '/');
      assert.match(await page.title(), /o mapa que a manchete não monta/);
      assert.match(await page.locator('h1').innerText(), /O mapa que a manchete não monta/);
    } finally { await context.close(); }
  });
});
