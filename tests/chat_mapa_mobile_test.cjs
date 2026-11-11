'use strict';
// Somente a box executa este arquivo. Todo chat é SSE mockado; origem externa bloqueada.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const fixture = {
  conversa_id: 'mock-pauta', blocos: [
    { tipo: 'documentado', texto: 'Fato documentado com fonte. '.repeat(100), entidades: [], relacoes: [], fontes: ['S02'] },
    { tipo: 'inferencia', texto: 'Leitura que combina dois fatos identificados.', base: [], justificativa: 'Leitura' },
    { tipo: 'hipotese', texto: 'A base não mostra o contrato. Próximo passo: procurar o contrato.', base: [], justificativa: 'Lacuna' },
  ], fontes: ['S02'], fontes_detalhe: { S02: { titulo: 'Fonte de teste', localizador: 'p. 1' } }, avisos: [], gratis_restantes: 19, saldo_pago: 0, entidades: [], custo_real: 0,
};
let browser, server, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const body = await fs.promises.readFile(file);
      res.setHeader('content-type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise(r => server.close(r)); });
async function open(width, height, suffix = '/') {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const errors = [], csp = []; let calls = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/functions/v1/chat') {
      calls++;
      assert.equal(url.origin, origin, 'a função mockada usa a origem local');
      return route.fulfill({ contentType: 'text/event-stream', body: `event: final\ndata: ${JSON.stringify(fixture)}\n\n` });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: `globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:${JSON.stringify(origin)},supabaseAnonKey:'public-test-placeholder'};` });
    return route.continue();
  });
  await context.addInitScript(() => {
    const token = `mock.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 }))}.mock`;
    localStorage.setItem('codigos-do-poder:auth:v1', JSON.stringify({ accessToken: token, refreshToken: 'mock', expiresAt: Date.now() + 7200000 }));
    localStorage.setItem('aion.tutorial', 'visto-v1'); localStorage.setItem('aion.dica-toque', 'visto-v1');
    window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective));
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + suffix); await page.waitForFunction(() => window.mural?.getState().extensionStatus === 'ready');
  return { page, context, errors, csp, calls: () => calls };
}
for (const [width, height] of [[1440,900],[393,852],[852,393],[320,568]]) {
  test(`BM-01–05/07–10: alternador, contador e histórico em ${width}×${height}`, async () => {
    const ui = await open(width, height); const { page } = ui;
    try {
      const nav = page.locator('nav[aria-label="Modo do mapa"]');
      assert(await nav.isVisible());
      const box = await nav.boundingBox(); assert(box.y >= 0 && box.y + box.height <= height);
      for (const button of await nav.locator('button').all()) { const b = await button.boundingBox(); assert(b.height >= 44 && b.width >= 44); }
      const count = await page.locator('#map-mode-count').textContent();
      assert.equal(count, await page.evaluate(() => window.mural.getState().nodeCount.toLocaleString('pt-BR')));
      assert.equal(await nav.locator('[data-modo-temas]').getAttribute('aria-current'), 'page');
      await nav.locator('[data-mapa-completo]').click();
      await page.waitForFunction(() => location.hash === '#all' && window.mural.getState().view === 'all');
      assert.equal(await nav.locator('[data-mapa-completo]').getAttribute('aria-current'), 'page');
      assert(!(await page.locator('#temas-back').isVisible()));
      await page.reload(); await page.waitForFunction(() => window.mural?.getState().view === 'all');
      await nav.locator('[data-modo-temas]').click(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.goBack(); await page.waitForFunction(() => window.mural.getState().view === 'all');
      await page.goForward(); await page.waitForFunction(() => window.mural.getState().view === 'temas');
      const metrics = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth > innerWidth, count: document.getElementsByTagName('*').length, csp: window.__csp,
        advanced: [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && /avançado/i.test(b.textContent)).map(b => b.textContent) }));
      assert(!metrics.wide); assert(metrics.count <= 637, `DOM: ${metrics.count}`); assert.deepEqual(metrics.advanced, []); assert.deepEqual(metrics.csp, []); assert.deepEqual(ui.errors, []);
      await page.evaluate(() => { location.hash = 'rockefeller-ipes-1964'; });
      await page.waitForFunction(() => window.mural.ux6().tema === 'rockefeller-ipes-1964');
      assert(!(await nav.isVisible()));
      const action = page.locator('.tema-acoes .button.primary'); assert(await action.isVisible());
      assert((await action.boundingBox()).height >= 44);
      const acoes = await page.evaluate(() => [...document.querySelectorAll('.tema-acoes [data-tema-acao]')].filter(b => getComputedStyle(b).display !== 'none').map(b => {
        const r = b.getBoundingClientRect();
        return { acao: b.getAttribute('data-tema-acao'), h: r.height, inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && r.width > 0 };
      }));
      const ids = acoes.map(a => a.acao);
      assert(ids.includes('ampliar') && ids.includes('lista') && ids.includes('fontes'), JSON.stringify(ids));
      assert(acoes.every(a => a.h >= 44 && a.inView), JSON.stringify(acoes));
      if (width >= 900) {
        const atalho = await page.evaluate(() => {
          const b = document.querySelector('.temas-nav-avancado'), h = document.querySelector('#entity-list-label');
          if (!b) return null;
          const r = b.getBoundingClientRect(), hr = h ? h.getBoundingClientRect() : null, cs = getComputedStyle(b);
          const midY = (r.top + r.bottom) / 2, midX = (r.left + r.right) / 2;
          const topEl = document.elementFromPoint(midX, r.top + 2);
          const midEl = document.elementFromPoint(midX, midY);
          const botEl = document.elementFromPoint(midX, r.bottom - 2);
          const covers = el => el === b || (el && b.contains(el));
          return {
            text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
            h: Math.round(r.height), inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && r.width > 0,
            clipped: hr ? r.bottom > hr.top + 1 : false,
            hit: covers(topEl) && covers(midEl) && covers(botEl),
          };
        });
        assert(atalho && atalho.h >= 44 && atalho.inView && !atalho.clipped && atalho.hit, JSON.stringify(atalho));
        assert(/Mapa completo/.test(atalho.text) && /fichas/.test(atalho.text), atalho.text);
      }
      await action.click(); await page.waitForFunction(() => location.hash === '#all' && window.mural.getState().view === 'all');
      assert.equal(ui.calls(), 0);
    } finally { await ui.context.close(); }
  });
}
for (const [width, height, minLog] of [[1440,900,160],[393,852,340.8],[393,480,192],[852,393,160]]) {
  test(`CH-01–07: chat rolável, teclado e tipos em ${width}×${height}`, async () => {
    const ui = await open(width, height); const { page } = ui;
    try {
      await page.locator('#chat-open').click();
      await page.locator('#chat-mensagem').fill('Pergunta longa sobre a base. '.repeat(50));
      await page.locator('#chat-send').click(); await page.locator('.chat-hypothesis').waitFor();
      const sizes = await page.evaluate(() => {
        const log = document.querySelector('#chat-log'), form = document.querySelector('#chat-form');
        const rect = el => { const b = el.getBoundingClientRect(); return { top:b.top, bottom:b.bottom, width:b.width, height:b.height }; };
        const modelo=document.querySelector('#chat-modelo');
        const formFields=[...document.querySelectorAll('#chat-form input:not([type=radio]),#chat-form select,#chat-form textarea')];
        return { log:rect(log), form:rect(form), send:rect(document.querySelector('#chat-send')), close:rect(document.querySelector('#chat-close')),
          font:getComputedStyle(document.querySelector('#chat-mensagem')).fontSize, answer:getComputedStyle(document.querySelector('.chat-answer')).fontSize,
          modelo:modelo?getComputedStyle(modelo).fontSize:null, formFonts:formFields.map(el=>getComputedStyle(el).fontSize),
          borders:['.chat-answer','.chat-inference','.chat-hypothesis'].map(s => getComputedStyle(document.querySelector(s)).borderLeftStyle),
          borderStyles:['.chat-inference','.chat-hypothesis'].map(s=>{const cs=getComputedStyle(document.querySelector(s));return {left:cs.borderLeftStyle,top:cs.borderTopStyle,right:cs.borderRightStyle,bottom:cs.borderBottomStyle};}),
          scroll:log.scrollHeight > log.clientHeight, wide:log.scrollWidth > log.clientWidth, csp:window.__csp };
      });
      assert(sizes.log.height >= minLog - 1, JSON.stringify(sizes)); assert(sizes.log.bottom <= sizes.form.top + 1);
      assert(sizes.send.width >= 44 && sizes.send.height >= 44 && sizes.close.height >= 44);
      assert.equal(sizes.font, '16px'); assert.equal(sizes.answer, width >= 900 ? '15px' : '16px');
      assert.equal(sizes.modelo, '16px'); assert(sizes.formFonts.every(f => f === '16px'), JSON.stringify(sizes.formFonts));
      if (width === 852 && height === 393) {
        const sel = await page.evaluate(() => {
          const el = document.querySelector('#chat-modelo');
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          const opt = el.selectedOptions[0]?.textContent || '';
          return { font: cs.fontSize, h: r.height, w: r.width, overflow: el.scrollWidth > el.clientWidth + 1, opt, display: cs.display };
        });
        assert.equal(sel.font, '16px'); assert(sel.h >= 44, JSON.stringify(sel));
        assert(!sel.overflow, JSON.stringify(sel));
        assert(/crédito/.test(sel.opt), sel.opt);
      }
      assert.deepEqual(sizes.borders, ['solid','solid','solid']);
      assert.deepEqual(sizes.borderStyles, [{left:'solid',top:'dashed',right:'dashed',bottom:'dashed'},{left:'solid',top:'dotted',right:'dotted',bottom:'dotted'}]);
      assert(sizes.scroll && !sizes.wide); assert.deepEqual(sizes.csp, []);
      await page.locator('.chat-more').click(); assert.equal(await page.locator('.chat-more').getAttribute('aria-expanded'), 'true');
      const source = page.locator('.chat-sources'); if (width < 900) assert.equal(await source.getAttribute('open'), null);
      await page.locator('.chat-citation').click(); assert.notEqual(await source.getAttribute('open'), null);
      assert.equal(ui.calls(), 1); assert.deepEqual(ui.errors, []);
      const contrast = await page.evaluate(() => {
        function rgb(s) { return s.match(/[\d.]+/g).slice(0,3).map(Number); }
        function lum(c) { return rgb(c).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((v,c,i) => v+c*[.2126,.7152,.0722][i],0); }
        const selectors = ['.chat-question','.chat-answer','.chat-inference','.chat-hypothesis'];
        return selectors.map(s => { const el=document.querySelector(s), st=getComputedStyle(el), a=lum(st.color), b=lum(st.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); });
      });
      assert(contrast.every(r => r >= 4.5), JSON.stringify(contrast));
    } finally { await ui.context.close(); }
  });
}
test('CH-02 visualViewport recalcula altura e offset do teclado sem reload', async () => {
  const ui = await open(393,852); const { page } = ui;
  try {
    await page.locator('#chat-open').click();
    await page.evaluate(() => {
      const viewport = new EventTarget(); viewport.height = 480; viewport.offsetTop = 0;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      window.dispatchEvent(new Event('resize'));
    });
    const box = await page.locator('#chat-panel').boundingBox(); const log = await page.locator('#chat-log').boundingBox();
    assert(box.height <= 418 && box.y + box.height <= 480); assert(log.height >= 192);
  } finally { await ui.context.close(); }
});
