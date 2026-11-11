'use strict';
// UX6 fase rápida: tela de temas, tutorial, temas legíveis, rótulo só no hover/toque,
// edição fora do DOM público, esquema 26 e regressão do FIX8-touch, no Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, describe, before, after, afterEach } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const views = JSON.parse(html.match(/<script id="research-views" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const temas = views.filter(v => v.grupo === 'tema');
const temasDoc = JSON.parse(fs.readFileSync(path.join(root, '../pesquisa/dados/temas.json'), 'utf8'));
const temasConfig = JSON.parse(fs.readFileSync(path.join(root, '../pesquisa/dados/temas-config.json'), 'utf8'));
const ativos = temasDoc.temas.filter(t => temasConfig.flags?.[t.id] !== false);
const KEY = 'codigos-do-poder:mural:v26', KEY_V25 = 'codigos-do-poder:mural:v25';
const DOM_CAP = Math.ceil(1644 * 5) + 50;
const fixtureConfig = { supabaseUrl: 'https://ozeiyqpbtggvuyhplisa.supabase.co', supabaseAnonKey: 'public-test-placeholder' };
const report = { dom: {}, temas: {} };
const reportPath = process.env.UX6_REPORT || '';

describe('UX6 UI no Chromium', { timeout: 120000 }, () => {
  let server, browser, origin;
  const contexts = [];
  before(async () => {
    server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
        const data = await fs.promises.readFile(file);
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }); res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => { for (const c of contexts.splice(0)) await c.close(); });
  after(async () => {
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    if (server) await new Promise(r => server.close(r));
  });

  async function open({ width = 1440, height = 900, touch = width < 500, suffix = '/', tutorialSeen = true, hintSeen = true, saved = null, savedKey = KEY, blockStorage = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 3 : 1, serviceWorkers: 'block' });
    contexts.push(context);
    const errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: `globalThis.ATLAS_PUBLIC_CONFIG=${JSON.stringify(fixtureConfig)};` });
      return route.continue();
    });
    await context.addInitScript(({ origin, tutorialSeen, hintSeen, saved, savedKey, blockStorage }) => {
      if (location.origin !== origin) return;
      if (blockStorage) {
        const deny = () => { throw new DOMException('bloqueado', 'SecurityError'); };
        Object.defineProperty(window, 'localStorage', { configurable: true, get: () => ({ getItem: deny, setItem: deny, removeItem: deny, clear: deny, key: deny, length: 0 }) });
        return;
      }
      if (sessionStorage.getItem('ux6-seeded')) return;
      sessionStorage.setItem('ux6-seeded', '1');
      if (tutorialSeen) localStorage.setItem('aion.tutorial', 'visto-v1');
      if (hintSeen) localStorage.setItem('aion.dica-toque', 'visto-v1');
      if (saved) localStorage.setItem(savedKey, JSON.stringify(saved));
    }, { origin, tutorialSeen, hintSeen, saved, savedKey, blockStorage });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + suffix);
    await page.waitForFunction(() => !!window.mural);
    await settle(page);
    return { page, context, errors };
  }
  const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const st = page => page.evaluate(() => ({ ...window.mural.getState(), ...window.mural.ux6(), tut: window.mural.tutorial() }));
  const domCount = page => page.evaluate(() => document.querySelector('#network').querySelectorAll('*').length);
  async function openTema(page, id) {
    await page.evaluate(id => { location.hash = id; }, id);
    await page.waitForFunction(id => window.mural.ux6().tema === id, id);
    await page.waitForTimeout(150); await settle(page);
  }
  const cardBoxes = page => page.evaluate(() => [...document.querySelectorAll('#node-layer .network-node')].map(n => { const r = n.querySelector('.node-card').getBoundingClientRect(); return { id: n.dataset.nodeId, l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height }; }));
  // A1: fichas fora da área útil do tema (do topo do mapa até a barra de zoom/folha do celular).
  const outside = page => page.evaluate(() => { const net = document.querySelector('#network').getBoundingClientRect(), mob = innerWidth <= 620 || innerHeight <= 500; let bottom = net.bottom; if (mob) for (const el of [document.querySelector('.canvas-toolbar'), document.querySelector('#tema-intro')]) { const b = el && el.getBoundingClientRect(); if (b && b.height && b.top > net.top + 80) bottom = Math.min(bottom, b.top); } let out = 0; for (const n of document.querySelectorAll('#node-layer .network-node')) { const q = n.querySelector('.node-card').getBoundingClientRect(); if (q.left < net.left - 1 || q.right > net.right + 1 || q.top < net.top - 1 || q.bottom > bottom + 1) out++; } return out; });
  const overlaps = boxes => { let n = 0; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a.l < b.r - .5 && a.r > b.l + .5 && a.t < b.b - .5 && a.b > b.t + .5) n++; } return n; };

  test('build: temas do temas.json viram views com recorte, contagens e flag Ford', () => {
    assert.equal(temas.length, ativos.length);
    for (const t of ativos) {
      const v = temas.find(x => x.id === t.id);
      assert.ok(v, t.id);
      assert.equal(v.label, t.titulo); assert.equal(v.resumo, t.resumo); assert.equal(v.abertura, t.abertura);
      assert.equal(v.layout, 'manual');
      assert.deepEqual([...v.ids].sort(), [...t.nos].sort());
      assert.deepEqual([...v.ligacoes].sort(), [...t.conexoes].sort());
      assert.equal(v.ids.length, t.contagem.nos); assert.equal(v.ligacoes.length, t.contagem.conexoes); assert.equal(v.fontes.length, t.contagem.fontes);
      for (const e of t.conexoes_fora_do_recorte || []) assert.ok(!v.ligacoes.includes(e), `${t.id}: ${e} fora do recorte`);
    }
    const ford = temas.find(v => v.id === 'ford-brasil');
    assert.equal(ford.label, 'Fundação Ford no Brasil: CUT, ministras e movimentos');
    assert.doesNotMatch(ford.label, /\bPT\b/);
    assert.ok(!ford.ids.includes('fpos'));
    assert.equal(ford.pergunta_fonte, 'T15-F01'); assert.equal(ford.pergunta_confianca, 'baixa');
    const t2 = temas.find(v => v.id === 'rockefeller-ipes-1964');
    assert.deepEqual([t2.ids.length, t2.ligacoes.length, t2.fontes.length], [21, 40, 27]);
    const t9 = temas.find(v => v.id === 'moreira-salles-rockefeller');
    assert.deepEqual([t9.ids.length, t9.ligacoes.length, t9.fontes.length], [17, 29, 20]);
    assert.ok(t9.ids.includes('ipes') && t9.ligacoes.includes('PR1-E021'));
    assert.equal(temas.find(v => v.id === 'globo-time-life').aviso_na_ficha['PR4-E036'], 'confiança média · interpretação de Dreifuss (1981)');
    assert.doesNotMatch(html, /t14_epstein/);
  });

  for (const [width, height] of [[1440, 900], [390, 844], [393, 852]]) test(`A-01/L5: primeira visita ${width}×${height} abre nos temas, sem o mapa de 1.644 nós por baixo`, async () => {
    const { page, errors } = await open({ width, height, tutorialSeen: false });
    const s = await st(page);
    assert.equal(s.view, 'temas'); assert.equal(s.renderedNodes, 0); assert.equal(s.visibleNodes.length, 0);
    const dom = await domCount(page); report.dom[`abertura_${width}`] = dom; assert.ok(dom < 60, 'DOM do #network na tela de temas: ' + dom);
    assert.equal(await page.locator('#temas-screen').isVisible(), true);
    assert.equal(await page.locator('#canvas-wrap').isVisible(), false);
    const primeira = ativos.filter(t => t.secao === 'primeira_tela');
    assert.deepEqual(await page.locator('.tema-card h2').allInnerTexts(), primeira.map(t => t.titulo));
    assert.deepEqual(await page.locator('.tema-card .tema-resumo').allInnerTexts(), primeira.map(t => t.resumo));
    // Resumo sem reticências: desktop até 7 linhas sem corte; celular inteiro.
    const clamp = await page.locator('.tema-card .tema-resumo').evaluateAll(els => els.map(e => { const cs = getComputedStyle(e); return { lines: Math.round(e.scrollHeight / parseFloat(cs.lineHeight)), cut: e.scrollHeight > e.clientHeight + 1, ellipsis: cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' }; }));
    for (const c of clamp) { assert.equal(c.cut, false); assert.equal(c.ellipsis, false); if (width > 1000) assert.ok(c.lines <= 7, JSON.stringify(c)); }
    if (width < 500) {
      const foot = await page.locator('.temas-rodape').boundingBox();
      assert.ok(foot && Math.abs(foot.y + foot.height - height) < 2, 'rodapé fixo no pé');
      assert.match(await page.locator('.temas-rodape').innerText(), /Role para ver os 6 temas/);
      const scroll = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, iw: innerWidth }));
      assert.ok(scroll.w <= scroll.iw);
    }
    const nav = await page.locator('#temas-nav ol.temas-nav-list .tema-t').evaluateAll(els => els.map(e => e.firstChild.textContent));
    assert.deepEqual(nav, ativos.filter(t => t.secao !== 'todos_os_recortes').map(t => t.titulo));
    const todos = await page.locator('#temas-nav ul.temas-nav-list .tema-t').evaluateAll(els => els.map(e => e.firstChild.textContent));
    assert.ok(todos.includes(ativos.find(t => t.id === 'population-council').titulo));
    assert.equal(s.tut.open, true); assert.equal(s.tut.step, 0);
    assert.deepEqual(errors, []);
  });

  test('T-01/T-02/T-04/T-06: tutorial com foco preso, Esc/Pular/Começar gravam a chave e o "?" reabre', async () => {
    const { page, errors } = await open({ tutorialSeen: false });
    const dialog = page.locator('.tutorial-card[role=dialog]');
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await page.evaluate(() => !!document.querySelector('#network .tutorial-card')), false);
    assert.equal(await page.locator('.tutorial-card button[data-tut=pular]').evaluate(e => e.tagName), 'BUTTON');
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement.closest('.tutorial-card')), 'foco preso no cartão'); }
    await page.locator('[data-tut=proximo]').click();
    assert.match(await page.locator('#tutorial-text').innerText(), /até 21 fichas/);
    assert.ok(await page.locator('.tema-card.tutorial-target').count() === 1);
    for (const sel of ['[data-tut=pular]', '[data-tut=proximo]', '[data-tut=voltar]']) {
      const hit = await page.locator(sel).evaluate(b => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
      assert.equal(hit, true, sel + ' coberto pelo destaque');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tutorial-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('aion.tutorial')), 'visto-v1');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tutorial-open');
    assert.equal((await st(page)).view, 'temas', 'Esc do tutorial não mexe no mapa');
    await page.reload(); await page.waitForFunction(() => !!window.mural); await settle(page);
    assert.equal((await st(page)).tut.open, false);
    await page.locator('#tutorial-open').click();
    let s = await st(page); assert.equal(s.tut.open, true); assert.equal(s.tut.step, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('aion.tutorial')), 'visto-v1');
    for (let i = 0; i < 3; i++) await page.locator('[data-tut=proximo]').click();
    assert.equal(await page.locator('#chat-open.tutorial-target').count(), 1);
    await page.locator('[data-tut=comecar]').click();
    assert.equal(await page.locator('.tutorial-backdrop').count(), 0);
    assert.equal(await page.locator('.tutorial-target').count(), 0);
    // Pular grava a chave numa visita nova.
    const fresh = await open({ tutorialSeen: false });
    await fresh.page.locator('[data-tut=pular]').click();
    assert.equal(await fresh.page.evaluate(() => localStorage.getItem('aion.tutorial')), 'visto-v1');
    assert.deepEqual(errors, []); assert.deepEqual(fresh.errors, []);
  });

  for (const suffix of ['/#rockefeller-ipes-1964', '/#e=ipes', '/#all', '/#OP01']) test(`T-03: link direto ${suffix} não abre o tutorial; o "?" fica visível`, async () => {
    const { page, errors } = await open({ suffix, tutorialSeen: false });
    const s = await st(page);
    assert.equal(s.tut.open, false); assert.equal(await page.locator('#tutorial-open').isVisible(), true);
    assert.deepEqual(errors, []);
  });

  test('T-05: sem localStorage o tutorial aparece uma vez por carga e nada quebra', async () => {
    const { page, errors } = await open({ blockStorage: true, tutorialSeen: false });
    assert.equal((await st(page)).tut.open, true);
    await page.locator('[data-tut=pular]').click();
    await openTema(page, 'ipes-golpe-64');
    await page.evaluate(() => { location.hash = ''; });
    await page.locator('#temas-back').click();
    assert.equal((await st(page)).tut.open, false);
    assert.deepEqual(errors, []);
  });

  for (const [width, height] of [[1440, 900], [390, 844], [393, 852]]) test(`item 11/L3/L6/A1: cada tema desenha só as suas conexoes[], enquadrado (desktop k ≥ .75; celular inteiro na área útil) e sem sobreposição, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height });
    for (const t of ativos) {
      await openTema(page, t.id);
      const s = await st(page);
      assert.equal(s.view, t.id);
      assert.equal(s.visibleNodes.length, t.contagem.nos, t.id);
      assert.deepEqual([...s.visibleEdges].sort(), [...t.conexoes].sort(), t.id + ': só as conexoes[] do tema');
      const drawn = await page.locator('#edge-layer .network-edge.ambient').evaluateAll(es => es.map(e => e.dataset.edgeId));
      assert.deepEqual([...new Set(drawn)].sort(), [...t.conexoes].sort(), t.id + ': linhas desenhadas');
      for (const e of t.conexoes_fora_do_recorte || []) assert.equal(await page.locator(`[data-edge-id="${e}"]`).count(), 0, `${t.id}: ${e} não aparece`);
      assert.match(await page.locator('#tema-intro [data-tema-acao=fontes]').innerText(), new RegExp(`Fontes \\(${t.contagem.fontes}\\)`));
      assert.match(await page.locator('#map-subtitle').innerText(), new RegExp(`${t.contagem.nos} fichas · ${t.contagem.conexoes} ligações · ${t.contagem.fontes} fontes`));
      if (width >= 500) assert.ok(s.camera.k >= .75 - 1e-9, `${t.id}: k=${s.camera.k}`);
      else { assert.ok(s.camera.k >= .5, `${t.id}: k=${s.camera.k}`); assert.equal(await outside(page), 0, `${t.id}: fichas fora da área útil`); report.k = report.k || {}; report.k[`${t.id}_${width}`] = +s.camera.k.toFixed(3); }
      const boxes = await cardBoxes(page);
      assert.equal(overlaps(boxes), 0, t.id + ': cartões sobrepostos');
      // Texto da ficha ≥ 10 px na abertura do tema.
      const font = await page.locator('#node-layer .node-title').first().evaluate(e => e.getBoundingClientRect().height);
      assert.ok(font >= (width >= 500 ? 10 : 7.5), `${t.id}: texto ${font}px`);
      assert.equal(await page.locator('.edge-label.label-visible').count(), 0);
      const dom = await domCount(page); report.temas[`${t.id}_${width}`] = dom; assert.ok(dom <= DOM_CAP);
      const intro = await page.locator('#tema-intro').boundingBox();
      assert.ok(intro, t.id + ': abertura visível');
      assert.equal((await page.locator('#tema-intro .tema-abertura').innerText()).replace(/^O que a base documenta\s*/i, '').trim(), t.abertura);
      if (width < 500) assert.ok(intro.height <= height * .24 + 1, `${t.id}: folha ${intro.height}px > 24%`);
      if (t.pergunta_em_aberto) {
        assert.equal(await page.locator('#tema-intro .tema-pergunta').isVisible(), true);
        assert.match(await page.locator('#tema-intro .tema-pergunta').innerText(), new RegExp(t.pergunta_em_aberto.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    }
    const ford = page.locator('#tema-intro');
    await openTema(page, 'ford-brasil');
    assert.match(await ford.locator('.tema-pergunta').innerText(), /T15-F01 · confiança baixa/);
    assert.deepEqual(errors, []);
  });

  test('item 7/rascunhos: PR4-E036 com o crachá do tema 8; PR1-E021 no tema 9 e no Mapa completo como «Pista não corroborada»', async () => {
    const { page, errors } = await open();
    const openEdge = async id => {
      if (!(await page.locator('#tema-lista').isVisible())) await page.locator('#tema-intro [data-tema-acao=lista]').click();
      await page.locator(`#tema-lista [data-tema-edge="${id}"]`).click();
      await page.waitForFunction(id => window.mural.getState().selected?.id === id, id);
    };
    await openTema(page, 'globo-time-life'); await openEdge('PR4-E036');
    assert.match(await page.locator('#inspector-content').innerText(), /confiança média · interpretação de Dreifuss \(1981\)/);
    await openTema(page, 'moreira-salles-rockefeller'); await openEdge('PR1-E021');
    assert.match(await page.locator('#inspector-content').innerText(), /Pista não corroborada/);
    // No Mapa completo os dois rascunhos seguem com o rótulo público.
    for (const [node, id] of [['ipes', 'PR1-E021'], ['ipes', 'PR4-E018']]) {
      await page.evaluate(n => { location.hash = 'e=' + n; }, node);
      await page.waitForFunction(n => window.mural.getState().selected?.id === n, node);
      const rel = page.locator(`#inspector [data-relation="${id}"]`);
      await rel.first().click();
      await page.waitForFunction(id => window.mural.getState().selected?.id === id, id);
      const text = await page.locator('#inspector-content').innerText();
      assert.match(text, /Pista não corroborada/, id); assert.doesNotMatch(text, /Rascunho pessoal/, id);
      await page.evaluate(() => { location.hash = ''; });
    }
    assert.deepEqual(errors, []);
  });

  test('L1/A-03: no tema, 0 rótulos no mapa; mouse na linha mostra 1 rótulo flutuante', async () => {
    const { page, errors } = await open();
    await openTema(page, 'rockefeller-ipes-1964');
    const pt = await page.evaluate(() => { for (const e of document.querySelectorAll('#edge-layer .network-edge.ambient')) for (const f of [.5, .4, .6, .3, .7]) { const q = e.getPointAtLength(e.getTotalLength() * f), p = new DOMPoint(q.x, q.y).matrixTransform(e.getScreenCTM()), hit = document.elementFromPoint(p.x, p.y); if (hit === e) return { x: p.x, y: p.y, id: e.dataset.edgeId }; } return null; });
    assert.ok(pt);
    await page.mouse.move(pt.x - 4, pt.y - 4); await page.mouse.move(pt.x, pt.y, { steps: 3 });
    await page.waitForFunction(id => window.mural.ux6().tooltip?.edge === id, pt.id);
    assert.equal(await page.locator('.edge-label.label-visible').count(), 0);
    assert.equal(await page.locator('.edge-tooltip:not([hidden])').count(), 1);
    assert.equal(await page.locator('#edge-tooltip').getAttribute('aria-live'), 'polite');
    await page.mouse.click(pt.x, pt.y);
    await page.waitForFunction(id => window.mural.getState().selected?.id === id, pt.id);
    assert.deepEqual(errors, []);
  });

  // CDP: sessão única por página (ver verificar_mural.cjs, FIX8-touch).
  async function touchSession(page) { const cdp = await page.context().newCDPSession(page); const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints }); return { send, tap: async p => { await send('touchStart', [{ ...p, id: 1 }]); await send('touchEnd', []); }, drag: async (a, b, steps = 8) => { await send('touchStart', [{ ...a, id: 1 }]); for (let i = 1; i <= steps; i++) await send('touchMove', [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps, id: 1 }]); await send('touchEnd', []); }, detach: () => cdp.detach() }; }

  for (const [width, height] of [[390, 844], [393, 852]]) test(`A-04/FIX8-touch T1–T6 e toque na linha, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height });
    const types = []; await page.exposeBinding('__ux6Pointer', (_s, t) => types.push(t));
    await page.evaluate(() => document.querySelector('#network').addEventListener('pointerdown', ev => window.__ux6Pointer(ev.pointerType), true));
    await openTema(page, 'rockefeller-ipes-1964');
    const t = await touchSession(page);
    const center = async id => { const b = await page.locator(`[data-node-id="${id}"] .node-card`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    // Um cartão inteiro na área livre (acima da folha do tema).
    const id = await page.evaluate(() => { const r = document.querySelector('#network').getBoundingClientRect(), sheet = document.querySelector('#tema-intro').getBoundingClientRect(); for (const n of document.querySelectorAll('#node-layer .network-node')) { const b = n.querySelector('.node-card').getBoundingClientRect(); if (b.top > r.top + 70 && b.bottom < sheet.top - 60 && b.left > 4 && b.right < innerWidth - 4) { const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); if (hit?.closest('[data-node-id]') === n) return n.dataset.nodeId; } } return null; });
    assert.ok(id, 'cartão livre para o toque');
    // T1: arrasto iniciado no cartão move a câmera, não a ficha.
    let at = await center(id); const cam = (await st(page)).camera, pos = { ...(await st(page)).positions[id] };
    await t.drag(at, { x: at.x + 40, y: at.y + 18 }); await settle(page);
    let s = await st(page);
    assert.ok(Math.abs(s.camera.x - cam.x - 40) < 1.5 && Math.abs(s.camera.y - cam.y - 18) < 1.5, 'T1 câmera');
    assert.deepEqual(s.positions[id], pos, 'T1 a ficha não se move'); assert.equal(s.selected, null, 'T1 arrasto não seleciona');
    // T2: arrasto no fundo.
    const bg = await page.evaluate(() => { const r = document.querySelector('#network').getBoundingClientRect(); for (let y = r.top + 80; y < r.bottom - 240; y += 18) for (let x = r.left + 8; x < r.right - 8; x += 18) { const e = document.elementFromPoint(x, y); if (e && (e.id === 'network' || e.classList.contains('canvas-background'))) return { x, y }; } return null; });
    assert.ok(bg, 'fundo livre');
    const cam2 = (await st(page)).camera; await t.drag(bg, { x: bg.x + 30, y: bg.y - 20 }); await settle(page);
    s = await st(page); assert.ok(Math.abs(s.camera.x - cam2.x - 30) < 1.5 && Math.abs(s.camera.y - cam2.y + 20) < 1.5, 'T2 fundo');
    // T3: pinça abre o zoom.
    const k0 = s.camera.k, ox = width / 2, oy = await page.evaluate(() => { const r = document.querySelector('#network').getBoundingClientRect(); return r.top + Math.min(220, r.height / 3); });
    await t.send('touchStart', [{ x: ox - 30, y: oy, id: 1 }]); await t.send('touchStart', [{ x: ox - 30, y: oy, id: 1 }, { x: ox + 30, y: oy, id: 2 }]);
    await t.send('touchMove', [{ x: ox - 70, y: oy, id: 1 }, { x: ox + 70, y: oy, id: 2 }]); await t.send('touchEnd', [{ x: ox + 70, y: oy, id: 2 }]); await t.send('touchEnd', []); await settle(page);
    s = await st(page); assert.ok(s.camera.k > k0 * 1.3, `T3 pinça ${k0} → ${s.camera.k}`);
    // T4: depois da pinça, arrasto com um dedo volta a mover a câmera (sem pinça zumbi).
    const cam4 = s.camera; await t.drag({ x: ox, y: oy }, { x: ox + 36, y: oy }); await settle(page);
    s = await st(page); assert.ok(Math.abs(s.camera.x - cam4.x - 36) < 1.5, 'T4 sem pinça zumbi');
    await page.locator('#tema-intro [data-tema-acao=lista]').waitFor();
    await page.evaluate(() => document.querySelector('#fit').click()); await settle(page);
    // No celular o tema abre inteiro (k≈.55); como um usuário, aproxima antes de tocar numa linha entre fichas.
    for (let i = 0; i < 2; i++) await page.evaluate(() => document.querySelector('#zoom-in').click()); await settle(page);
    // Toque na linha: 1º toque mostra o rótulo flutuante; 0 rótulos no mapa.
    const lp = await page.evaluate(() => { const sheet = document.querySelector('#tema-intro').getBoundingClientRect(), r = document.querySelector('#network').getBoundingClientRect(); const cards = [...document.querySelectorAll('#node-layer .node-card')].map(c => c.getBoundingClientRect()), far = p => cards.every(b => Math.max(b.left - p.x, 0, p.x - b.right) ** 2 + Math.max(b.top - p.y, 0, p.y - b.bottom) ** 2 > 12 ** 2); for (const e of document.querySelectorAll('#edge-layer .network-edge.ambient')) for (const f of [.5, .4, .6, .3, .7, .2, .8]) { const q = e.getPointAtLength(e.getTotalLength() * f), p = new DOMPoint(q.x, q.y).matrixTransform(e.getScreenCTM()); if (p.y < r.top + 60 || p.y > sheet.top - 70 || p.x < 10 || p.x > innerWidth - 10 || !far(p)) continue; const hit = document.elementFromPoint(p.x, p.y); if (hit === e) return { x: p.x, y: p.y, id: e.dataset.edgeId }; } return null; });
    assert.ok(lp, 'linha livre para o toque');
    await t.tap(lp); await settle(page);
    s = await st(page);
    assert.equal(s.tooltip?.edge, lp.id, 'toque na linha mostra o rótulo'); assert.equal(s.selected, null);
    const tipBox = await page.locator('#edge-tooltip').boundingBox();
    assert.ok(tipBox.y + tipBox.height <= lp.y - 8 || tipBox.y >= lp.y + 20, 'B2: o rótulo fica acima ou abaixo do dedo');
    assert.equal(await page.locator('.edge-label.label-visible').count(), 0);
    await t.tap(lp); await settle(page);
    s = await st(page); assert.equal(s.selected?.id, lp.id, '2º toque na linha seleciona');
    await page.locator('#close-inspector').click().catch(() => {}); await settle(page);
    // T5/T6 no Mapa completo: toque seleciona, duplo toque expande; a folha não passa de 50%.
    await page.evaluate(() => { location.hash = 'br_bancos'; }); await page.waitForFunction(() => window.mural.getState().view === 'br_bancos');
    await page.evaluate(() => document.querySelector('#fit').click()); await settle(page);
    const nid = 'moreira_salles'; await page.evaluate(id => window.mural.showNode(id), nid); await settle(page);
    at = await center(nid);
    const count = (await st(page)).visibleNodes.length;
    await t.tap(at); await settle(page);
    s = await st(page); assert.equal(s.selected?.id, nid, 'T5 toque seleciona');
    const sheet = await page.locator('#inspector').boundingBox(); assert.ok(sheet.height <= height * .5 + 2, `folha ${sheet.height}`);
    const cover = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-node-id]') ? 'card' : 'away', at);
    await t.tap(cover === 'card' ? at : await center(nid)); await settle(page);
    s = await st(page); assert.ok(s.visibleNodes.length > count, 'T6 duplo toque expande'); assert.equal(s.view, 'custom');
    assert.ok(types.length >= 6 && types.every(x => x === 'touch'), JSON.stringify(types));
    await t.detach();
    assert.deepEqual(errors, []);
  });

  test('A-02: v25 com view all abre nos temas; recorte escolhido fica; v26 all (avançado) fica; hash manda', async () => {
    const v25 = (view, extra = {}) => ({ schema: 25, view, layouts: { all: { positions: {}, camera: { x: 1, y: 2, k: .04 } } }, ...extra });
    let { page, errors } = await open({ saved: v25('all'), savedKey: KEY_V25 });
    let s = await st(page); assert.equal(s.view, 'temas'); assert.equal(s.renderedNodes, 0);
    assert.equal(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY)).schema, 26);
    ({ page, errors } = await open({ saved: v25('br_bancos'), savedKey: KEY_V25 }));
    assert.equal((await st(page)).view, 'br_bancos');
    ({ page, errors } = await open({ saved: v25('all'), savedKey: KEY_V25, suffix: '/#e=ipes' }));
    s = await st(page); assert.equal(s.view, 'all'); assert.equal(s.selected?.id, 'ipes'); assert.equal(s.inspectorOpen, true);
    report.dom.ipes_selecionado_all = await domCount(page); assert.ok(report.dom.ipes_selecionado_all <= DOM_CAP);
    ({ page, errors } = await open({ saved: v25('br_bancos'), savedKey: KEY_V25, suffix: '/#rockefeller-ipes-1964' }));
    assert.equal((await st(page)).view, 'rockefeller-ipes-1964');
    ({ page, errors } = await open({ suffix: '/#all' }));
    s = await st(page); assert.equal(s.view, 'all'); assert.equal(s.advancedMap, true); assert.equal(await page.evaluate(() => location.hash), '#all');
    await page.reload(); await page.waitForFunction(() => !!window.mural); await settle(page);
    assert.equal((await st(page)).view, 'all', 'Mapa completo escolhido continua no reload');
    ({ page, errors } = await open());
    await page.locator('#map-mode [data-mapa-completo]').click(); await settle(page);
    s = await st(page); assert.equal(s.view, 'all'); assert.equal(s.advancedMap, true);
    report.dom.mapa_completo_aberto = await domCount(page);
    assert.deepEqual(errors, []);
  });

  test('L9: #e=ipes abre o Mapa completo com o IPES selecionado (1440 e 393)', async () => {
    for (const [width, height] of [[1440, 900], [393, 852]]) {
      const { page, errors } = await open({ width, height, suffix: '/#e=ipes' });
      const s = await st(page); assert.equal(s.selected?.id, 'ipes'); assert.equal(s.view, 'all');
      assert.equal(await page.locator('[data-node-id="ipes"]').count(), 1);
      report.dom[`ipes_e_${width}`] = await domCount(page);
      assert.deepEqual(errors, []);
    }
  });

  test('L7/A-05: visitante sem controles de edição no DOM; ?editor=1 traz de volta', async () => {
    const ids = ['draft-mode', 'add-node', 'add-edge', 'export-button', 'import-button', 'import-file', 'undo', 'redo', 'layout'];
    let { page, errors } = await open({ suffix: '/#all' });
    for (const id of ids) assert.equal(await page.locator('#' + id).count(), 0, id);
    assert.equal(await page.locator('.local-draft, .board-actions, .draft-only').count(), 0);
    await page.evaluate(() => { location.hash = 'e=ipes'; });
    await page.waitForFunction(() => window.mural.getState().selected?.id === 'ipes');
    assert.equal(await page.locator('#inspector .draft-only, #detail-edit, #detail-connect').count(), 0);
    assert.equal((await st(page)).editor, false);
    ({ page, errors } = await open({ suffix: '/?editor=1#all' }));
    for (const id of ['draft-mode', 'add-node', 'export-button', 'undo']) assert.equal(await page.locator('#' + id).count(), 1, id);
    assert.equal((await st(page)).editor, true);
    assert.deepEqual(errors, []);
  });
  // ── Revisão 1 (A1–A5, B3, B4) ──
  test('A1: celular abre o tema enquadrado, sem busca, título em 1 linha; girar a tela reenquadra', async () => {
    const { page, errors } = await open({ width: 393, height: 852 });
    for (const id of ['rockefeller-ipes-1964', 'rothschild-brasil', 'ford-brasil']) {
      await openTema(page, id);
      assert.equal(await outside(page), 0, id + ': abre com todas as fichas na área útil');
      assert.equal(await page.locator('.map-search').isVisible(), false, 'busca escondida no tema');
      const title = await page.locator('#map-title').evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).fontSize) * 1.6, title: e.title }));
      assert.ok(title.h <= title.lh, `${id}: título em 1 linha (${title.h}px)`); assert.ok(title.title.length > 0, 'título inteiro na dica');
      const area = await page.evaluate(() => { const n = document.querySelector('#network').getBoundingClientRect(), tb = document.querySelector('.canvas-toolbar').getBoundingClientRect(); return tb.top - n.top; });
      assert.ok(area >= 440, `${id}: área do mapa ${area}px`);
    }
    // Já aberto: pan, depois girar a tela, voltar.
    await page.mouse.wheel(0, 0);
    await page.setViewportSize({ width: 852, height: 393 }); await page.waitForTimeout(250); await settle(page);
    // C1: deitado, o tema reenquadra com piso de zoom 0,5 (mapa rolável), não espremido a 0,23.
    { const s = await st(page); assert.ok(s.camera.k >= .5 - 1e-6, `deitado: k ${s.camera.k}`); }
    await page.setViewportSize({ width: 393, height: 852 }); await page.waitForTimeout(250); await settle(page);
    assert.equal(await outside(page), 0, 'de volta em pé: enquadrado');
    assert.deepEqual(errors, []);
  });

  for (const [width, height] of [[393, 852], [390, 844]]) test(`A2: folha do celular mostra «○ Pergunta em aberto ↓» sem rolar e o toque leva ao texto, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height });
    for (const t of ativos) {
      await openTema(page, t.id);
      const atalho = page.locator('#tema-intro .tema-pergunta-atalho');
      if (!t.pergunta_em_aberto) { assert.equal(await atalho.count(), 0, t.id + ': sem pergunta, sem atalho'); continue; }
      const vis = await page.evaluate(() => { const i = document.querySelector('#tema-intro'), a = i.querySelector('.tema-pergunta-atalho').getBoundingClientRect(), r = i.getBoundingClientRect(); return { scroll: i.scrollTop, inside: a.height > 0 && a.top >= r.top && a.bottom <= r.bottom + 1, text: i.querySelector('.tema-pergunta-atalho').innerText }; });
      assert.equal(vis.scroll, 0); assert.ok(vis.inside, t.id + ': atalho visível sem rolar'); assert.match(vis.text, /Pergunta em aberto ↓/);
      await atalho.click(); await page.waitForTimeout(500);
      const q = await page.evaluate(() => { const i = document.querySelector('#tema-intro').getBoundingClientRect(), p = document.querySelector('#tema-pergunta').getBoundingClientRect(); return p.top >= i.top - 1 && p.top < i.bottom - 20; });
      assert.ok(q, t.id + ': o texto da pergunta aparece na folha');
    }
    assert.deepEqual(errors, []);
  });

  for (const [width, height] of [[1440, 900], [393, 852]]) test(`A3: abrir tema faz pushState #<id>; Voltar volta à lista sem sair; «← Temas» e Ampliar também, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height });
    const len0 = await page.evaluate(() => history.length);
    await page.locator('.tema-card [data-tema="ford-brasil"]').click();
    await page.waitForFunction(() => window.mural.ux6().tema === 'ford-brasil');
    assert.equal(await page.evaluate(() => location.hash), '#ford-brasil');
    assert.equal(await page.evaluate(() => history.length), len0 + 1);
    await page.goBack(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
    assert.equal(await page.evaluate(() => location.hash), ''); assert.ok(page.url().startsWith(origin), 'continua no site');
    await page.goForward(); await page.waitForFunction(() => window.mural.ux6().tema === 'ford-brasil');
    // «← Temas» volta pela pilha (mesma entrada da lista).
    await page.locator('#temas-back').click(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
    assert.equal(await page.evaluate(() => location.hash), '');
    // Tema → Ampliar no mapa completo → Voltar → tema → Voltar → lista.
    await page.locator('.tema-card [data-tema="soros-brasil"]').click(); await page.waitForFunction(() => window.mural.ux6().tema === 'soros-brasil');
    await page.locator('#tema-intro [data-tema-acao=ampliar]').click(); await page.waitForFunction(() => window.mural.getState().view === 'all');
    await page.goBack(); await page.waitForFunction(() => window.mural.ux6().tema === 'soros-brasil');
    assert.equal(await page.evaluate(() => location.hash), '#soros-brasil');
    await page.goBack(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
    // Recarregar com o hash do tema mantém o tema (link compartilhável).
    await page.goForward(); await page.waitForFunction(() => window.mural.ux6().tema === 'soros-brasil');
    await page.reload(); await page.waitForFunction(() => window.mural?.ux6().tema === 'soros-brasil');
    assert.deepEqual(errors, []);
  });

  for (const [width, height] of [[1440, 900], [393, 852]]) test(`A4: tutorial — o balão não cobre o alvo nos passos 2–4; passo 3 tem alvo na tela de temas, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height, tutorialSeen: false });
    await page.locator('.tutorial-card').waitFor();
    for (let step = 2; step <= 4; step++) {
      await page.locator('[data-tut=proximo]').click(); await settle(page);
      const r = await page.evaluate(() => { const c = document.querySelector('.tutorial-card').getBoundingClientRect(), t = document.querySelector('.tutorial-target'); if (!t) return { target: false }; const b = t.getBoundingClientRect(); const ov = Math.max(0, Math.min(c.right, b.right) - Math.max(c.left, b.left)) * Math.max(0, Math.min(c.bottom, b.bottom) - Math.max(c.top, b.top)); return { target: true, ov, inView: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight }; });
      assert.ok(r.target, `passo ${step} tem alvo`); assert.equal(r.ov, 0, `passo ${step}: balão sobre o alvo`); assert.ok(r.inView, `passo ${step}: balão inteiro na tela`);
    }
    assert.match(await page.locator('#tutorial-text').innerText(), /fontes/);
    assert.deepEqual(errors, []);
  });

  for (const [width, height] of [[1440, 900], [393, 852]]) test(`A5/B3: no tema o painel leva ao Mapa completo (não expande), conta as ligações do tema e não mostra ID/Núcleo, ${width}×${height}`, async () => {
    const { page, errors } = await open({ width, height });
    await openTema(page, 'rockefeller-ipes-1964');
    const tv = ativos.find(t => t.id === 'rockefeller-ipes-1964');
    await page.evaluate(() => { const n = document.querySelector('#node-layer [data-node-id="david_r"]'); n.focus(); });
    await page.keyboard.press('Enter'); await settle(page);
    assert.equal((await st(page)).selected?.id, 'david_r');
    const txt = await page.locator('#inspector-content').innerText();
    assert.match(txt, /\d+ neste tema · \d+ na base/); assert.doesNotMatch(txt, /Expandir conexões/); assert.doesNotMatch(txt, /Núcleo/);
    assert.equal(await page.locator('#inspector-tab').isVisible(), false, 'B3: sem ENT-… no tema');
    assert.equal(await page.locator('#detail-expand').innerText(), 'Ver no mapa completo');
    // Duplo clique/toque na ficha do tema não expande nem sai do tema.
    const before = (await st(page)).visibleNodes.length;
    if (width >= 500) { await page.mouse.move(1, 1); await page.evaluate(() => document.querySelector('#node-layer [data-node-id="david_r"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(page); assert.equal((await st(page)).view, 'rockefeller-ipes-1964'); assert.equal((await st(page)).visibleNodes.length, before); }
    await page.locator('#detail-expand').click();
    await page.waitForFunction(() => window.mural.getState().view === 'all');
    const s = await st(page);
    assert.equal(s.selected?.id, 'david_r', 'mapa completo com a ficha em destaque'); assert.equal(s.advancedMap, true);
    const dom = await domCount(page); report.dom[`a5_mapa_${width}`] = dom; assert.ok(dom <= DOM_CAP, `DOM ${dom}`);
    assert.doesNotMatch(await page.locator('#inspector-content').innerText(), /neste tema/);
    assert.equal(await page.locator('#detail-expand').innerText(), 'Expandir conexões');
    await page.goBack(); await page.waitForFunction(() => window.mural.ux6().tema === 'rockefeller-ipes-1964');
    assert.deepEqual(errors, []);
  });

  test('B4: rodapé do celular — cada trecho é um botão que funciona', async () => {
    const { page, errors } = await open({ width: 393, height: 852 });
    const btns = page.locator('.temas-rodape button');
    assert.equal(await btns.count(), 2);
    await page.locator('.temas-rodape [data-abrir-lateral]').click(); await settle(page);
    assert.equal(await page.locator('#sidebar').evaluate(e => e.classList.contains('open')), true);
    await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelector('#sidebar').classList.remove('open'));
    await page.locator('#map-mode [data-mapa-completo]').click(); await page.waitForFunction(() => window.mural.getState().view === 'all');
    await page.goBack(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
    assert.deepEqual(errors, []);
  });
  // ---------- Revisão 3 (C1–C3) ----------
  const rect = (page, sel) => page.evaluate(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; }, sel);

  test('C1: celular deitado 852×393 — sem lista lateral, barra em 1 linha, zoom ≥ 0,5 e mapa rolável nos 9 temas', async () => {
    const { page, errors } = await open({ width: 852, height: 393, touch: true });
    for (const t of ativos) {
      await openTema(page, t.id);
      const s = await st(page);
      assert.ok(s.camera.k >= .5 - 1e-6, `${t.id}: k ${s.camera.k}`);
      assert.equal((await rect(page, '#sidebar')).vis, false, `${t.id}: lista lateral escondida`);
      const barra = await rect(page, '.tema-barra'); assert.ok(barra.vis && barra.h <= 40, `${t.id}: barra ${barra.h}px`);
      const titulo = await rect(page, '#map-title'); assert.ok(titulo.h <= 30, `${t.id}: título ${titulo.h}px`);
      const net = await rect(page, '#network'), textos = await rect(page, '.tema-textos');
      assert.ok(net.h >= 220, `${t.id}: mapa ${net.h}px`); assert.ok(textos.vis && textos.l >= net.r - 1, `${t.id}: abertura ao lado do mapa`);
      // Uma ficha (a semente) está na área visível desde o início.
      const boxes = await cardBoxes(page);
      assert.ok(boxes.some(b => b.l >= net.l && b.r <= net.r && b.t >= net.t && b.b <= net.b), `${t.id}: alguma ficha inteira à vista`);
      report.dom[`c1_852_${t.id}`] = await domCount(page);
    }
    // Rolável: arrastar o mapa move a câmera, e o zoom não cai abaixo de 0,5 ao enquadrar.
    const before = (await st(page)).camera, net = await rect(page, '#network');
    const t = await touchSession(page);
    await t.drag({ x: net.l + 40, y: net.t + 60 }, { x: net.l + 240, y: net.t + 150 }); await settle(page); await t.detach();
    const after = (await st(page)).camera;
    assert.ok(Math.abs(after.x - before.x) > 50 || Math.abs(after.y - before.y) > 30, 'mapa rola');
    assert.ok(after.k >= .5 - 1e-6);
    assert.deepEqual(errors, []);
  });

  test('C2: a linha «Pergunta em aberto» tem fundo opaco e nenhuma linha da abertura corre por baixo dela', async () => {
    const { page, errors } = await open({ width: 393, height: 852 });
    await openTema(page, 'rockefeller-ipes-1964');
    const bar = page.locator('.tema-pergunta-atalho');
    assert.equal(await bar.isVisible(), true);
    const bg = await bar.evaluate(e => getComputedStyle(e).backgroundColor);
    const m = bg.match(/rgba?\(([^)]+)\)/); const parts = m[1].split(',').map(Number);
    assert.ok(parts.length === 3 || parts[3] === 1, `fundo opaco: ${bg}`);
    // Faixa opaca estendida (sombra sólida) abaixo e acima da linha, para o texto sumir antes de chegar nela.
    assert.match(await bar.evaluate(e => getComputedStyle(e).boxShadow), /0px 12px 0px 0px/);
    for (const pos of [0, 'pergunta']) {
      if (pos === 'pergunta') { await bar.click(); await page.waitForTimeout(700); }
      else { await page.locator('#tema-intro').evaluate((e, y) => { e.scrollTop = y; }, pos); await settle(page); }
      const res = await page.evaluate(() => {
        const intro = document.querySelector('#tema-intro'), b = intro.querySelector('.tema-pergunta-atalho').getBoundingClientRect(), ir = intro.getBoundingClientRect(), bad = [];
        const cover = { t: Math.max(ir.top, b.top - 10), b: b.bottom + 12 };
        for (const el of intro.querySelectorAll('.tema-textos p, .tema-textos h3, .tema-textos li')) {
          const range = document.createRange(); range.selectNodeContents(el);
          for (const r of range.getClientRects()) if (r.height > 4 && r.bottom > ir.top + 1 && r.top < cover.b - .5 && r.bottom > cover.b + .5) bad.push(Math.round(r.top));
        }
        return { bad, top: b.top - ir.top };
      });
      assert.deepEqual(res.bad, [], `linhas cortadas pela faixa (${pos})`);
    }
    // Depois do atalho, o título da pergunta fica logo abaixo da faixa, inteiro.
    const q = await page.evaluate(() => { const intro = document.querySelector('#tema-intro'), b = intro.querySelector('.tema-pergunta-atalho').getBoundingClientRect(), q = document.getElementById('tema-pergunta'); const r = q.getBoundingClientRect(); return { qt: r.top, bb: b.bottom, ib: intro.getBoundingClientRect().bottom }; });
    assert.ok(q.qt >= q.bb && q.qt < q.ib, JSON.stringify(q));
    assert.deepEqual(errors, []);
  });

  test('C3: dica «Toque numa ficha para aproximar» aparece uma vez, não cobre o mapa e some no toque; o toque aproxima (≥0,9) e centraliza', async () => {
    const { page, context, errors } = await open({ width: 393, height: 852, hintSeen: false });
    await openTema(page, 'rockefeller-ipes-1964');
    const hint = page.locator('#toque-dica');
    assert.equal(await hint.innerText(), 'Toque numa ficha para aproximar');
    assert.equal(await page.evaluate(() => localStorage.getItem('aion.dica-toque')), 'visto-v1');
    const h = await rect(page, '#toque-dica'), net = await rect(page, '#network'), title = await rect(page, '#map-title');
    assert.ok(h.b <= net.t + .5, 'dica não cobre o mapa'); assert.ok(h.t >= title.b - 4, 'dica não cobre o título');
    assert.equal(await hint.evaluate(e => getComputedStyle(e).pointerEvents), 'none');
    const k0 = (await st(page)).camera.k;
    assert.ok(k0 < .9);
    const card = (await cardBoxes(page)).find(b => b.t > net.t + 20 && b.b < net.t + 300 && b.l > 60 && b.r < 393 - 60);
    const t = await touchSession(page);
    await t.tap({ x: (card.l + card.r) / 2, y: (card.t + card.b) / 2 }); await t.detach();
    await page.waitForTimeout(600);
    assert.equal(await hint.count(), 0, 'dica some no toque');
    const s = await st(page);
    assert.equal(s.selected?.id, card.id); assert.ok(s.camera.k >= .9 - 1e-6, `k ${s.camera.k}`);
    const sheet = await rect(page, '#inspector'), sel = (await cardBoxes(page)).find(b => b.id === card.id);
    assert.ok(Math.abs((sel.l + sel.r) / 2 - 393 / 2) < 4, 'centro x');
    assert.ok(Math.abs((sel.t + sel.b) / 2 - (net.t + sheet.t) / 2) < 6, 'centro y acima da folha');
    assert.equal(await page.locator('#inspector-content h2, #inspector-content .detail-title').first().isVisible(), true, 'folha acompanha');
    // Outro tema e recarga: não volta.
    await page.evaluate(() => window.mural.select && window.mural.select(null)).catch(() => {}); await openTema(page, 'soros-brasil'); assert.equal(await page.locator('#toque-dica').count(), 0);
    await page.reload(); await page.waitForFunction(() => !!window.mural); await openTema(page, 'ford-brasil'); assert.equal(await page.locator('#toque-dica').count(), 0);
    assert.deepEqual(errors, []);
    // Some sozinha em alguns segundos; no desktop não aparece.
    const b = await open({ width: 393, height: 852, hintSeen: false });
    await openTema(b.page, 'ford-brasil'); assert.equal(await b.page.locator('#toque-dica').count(), 1);
    await b.page.waitForTimeout(6400); assert.equal(await b.page.locator('#toque-dica').count(), 0);
    const d = await open({ width: 1440, height: 900, hintSeen: false });
    await openTema(d.page, 'ford-brasil'); assert.equal(await d.page.locator('#toque-dica').count(), 0);
    assert.equal(await d.page.evaluate(() => localStorage.getItem('aion.dica-toque')), null);
    assert.deepEqual([...b.errors, ...d.errors], []);
  });

  test('C3 deitado: no 852×393 a dica fica no cabeçalho e o toque na ficha aproxima e centraliza ao lado do painel', async () => {
    const { page, errors } = await open({ width: 852, height: 393, touch: true, hintSeen: false });
    await openTema(page, 'rockefeller-ipes-1964');
    const h = await rect(page, '#toque-dica'), net = await rect(page, '#network'), title = await page.evaluate(() => { const e = document.querySelector('#map-title'), r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return { r: b.right }; });
    assert.ok(h.vis && h.b <= net.t + .5 && h.l >= title.r, 'dica no cabeçalho, sem cobrir título nem mapa');
    const card = (await cardBoxes(page)).find(b => b.t > net.t + 40 && b.b < net.b - 70 && b.l > 80 && b.r < net.r - 60);
    const t = await touchSession(page);
    await t.tap({ x: (card.l + card.r) / 2, y: (card.t + card.b) / 2 }); await t.detach();
    await page.waitForTimeout(700);
    const s = await st(page); assert.equal(s.selected?.id, card.id); assert.ok(s.camera.k >= .9 - 1e-6, `k ${s.camera.k}`);
    const net2 = await rect(page, '#network'), sel = (await cardBoxes(page)).find(b => b.id === card.id), chip = await rect(page, '.selection-toolbar');
    assert.ok(Math.abs((sel.l + sel.r) / 2 - (net2.l + net2.r) / 2) < 4 && Math.abs((sel.t + sel.b) / 2 - (net2.t + net2.b) / 2) < 6, 'centralizada');
    assert.ok(!chip.vis || chip.b <= sel.t || chip.t >= sel.b, 'rótulo do destaque não cobre a ficha');
    assert.equal(await page.locator('#toque-dica').count(), 0);
    assert.deepEqual(errors, []);
  });
});
