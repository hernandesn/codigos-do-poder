'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test, describe, before, after, afterEach } = require('node:test');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const screens = path.resolve(root, '../ux4-ui-out/screens');
const muralKey = 'codigos-do-poder:mural:v26';
const draftKey = 'codigos-do-poder:chat-draft:v1';
const draftTtl = 30 * 60 * 1000;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { dataRef, seedText } = require('./dados_site.cjs');
const seed = JSON.parse(seedText(html, root));
const question = 'Quais fontes documentam os bancos de Mauá?';
// Fixtures sintéticas, sem credenciais reais. Nenhuma chamada sai para o Supabase.
const fixtureConfig = { supabaseUrl: 'https://ozeiyqpbtggvuyhplisa.supabase.co', supabaseAnonKey: 'public-test-placeholder' };
const fixtureToken = (now = Date.now(), seconds = 3600) => ['fixture', Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + seconds })).toString('base64url'), 'fixture'].join('.');
const tokenResponse = (now = Date.now(), seconds = 3600) => ({ access_token: fixtureToken(now, seconds), refresh_token: 'fixture', expires_in: seconds });

// Exercita o mesmo mount com armazenamento realista, inclusive sem Storage disponível.
function mountChat({ pending, draft, redirect = false, storageBlocked = false, clock = { now: Date.now() }, fetchImpl } = {}) {
  const authScript = html.match(/<script>\s*(\/\* Login Supabase Auth e chat[\s\S]*?)<\/script>/)[1];
  const host = { module: { exports: {} }, URL, URLSearchParams, TextDecoder, AbortController, atob, Date: class extends Date { static now() { return clock.now; } } };
  vm.runInNewContext(authScript, host);
  const element = () => ({
    value: '', textContent: '', hidden: false, children: [], listeners: {}, dataset: {},
    appendChild(child) { this.children.push(child); return child; },
    setAttribute() {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const elements = Object.fromEntries([
    'chat-panel', 'chat-gate', 'chat-form', 'chat-log', 'chat-mensagem', 'chat-send',
    'chat-status', 'chat-context', 'chat-login', 'chat-open', 'chat-close',
    'auth-button', 'auth-dialog', 'auth-form', 'auth-email', 'auth-password',
  ].map(id => [id, { ...element(), hidden: id === 'chat-panel' }]));
  const savedDraft = draft || (pending ? { message: pending, expiresAt: clock.now + draftTtl } : null);
  const data = new Map(savedDraft ? [[draftKey, JSON.stringify(savedDraft)]] : []);
  const storage = (values, blocked = false) => ({
    getItem(key) { if (blocked === true) throw Error('Storage blocked'); return values.get(key) || null; },
    setItem(key, value) { if (blocked) throw Error('Storage blocked'); values.set(key, value); },
    removeItem(key) { if (blocked === true) throw Error('Storage blocked'); values.delete(key); },
  });
  let calls = 0;
  const result = host.module.exports.mount({ getElementById: id => elements[id] || null, createElement: element }, {
    config: fixtureConfig,
    now: () => clock.now,
    storage: storage(new Map()), draftStorage: storage(data, storageBlocked),
    location: { hash: redirect ? new URLSearchParams({ ...tokenResponse(clock.now), type: 'signup' }).toString() : '' },
    fetchImpl: async (...args) => { calls++; return fetchImpl ? fetchImpl(...args) : { ok: true, status: 200, json: async () => tokenResponse(clock.now) }; },
  });
  return { ...result, elements, data, calls: () => calls };
}

test('rascunho pendente volta após redirect, é limpo e não é enviado', () => {
  const ui = mountChat({ pending: question, redirect: true });
  assert.equal(ui.elements['chat-panel'].hidden, false);
  assert.equal(ui.elements['chat-form'].hidden, false);
  assert.equal(ui.elements['chat-gate'].hidden, true);
  assert.equal(ui.elements['chat-mensagem'].value, question);
  assert.equal(ui.data.has(draftKey), false);
  ui.elements['chat-mensagem'].value = 'Uma pergunta nova';
  ui.renderSession();
  assert.equal(ui.elements['chat-mensagem'].value, 'Uma pergunta nova');
  assert.equal(ui.calls(), 0);
});

test('login mantém o campo em memória quando o armazenamento do rascunho está bloqueado', async () => {
  for (const storageBlocked of [true, 'write-only']) {
    const ui = mountChat({ storageBlocked });
    // A sessão tem armazenamento próprio; só o armazenamento do rascunho falha.
    ui.elements['chat-open'].listeners.click();
    ui.elements['chat-mensagem'].value = question;
    ui.elements['chat-login'].listeners.click();
    assert.equal(ui.elements['auth-dialog'].open, true);
    assert.equal(ui.elements['chat-form'].hidden, true);
    ui.elements['chat-panel'].hidden = true;
    assert.equal((await ui.client.login('visitante@example.test', 'fixture-only')).ok, true);
    ui.renderSession();
    assert.equal(ui.elements['chat-panel'].hidden, false);
    assert.equal(ui.elements['chat-mensagem'].value, question);
    assert.equal(ui.elements['chat-mensagem'].disabled, false);
    assert.equal(ui.calls(), 1);
  }
});

test('entidade oculta é revelada com ligação e filtros temporários, sem mudar preferências salvas', () => {
  // Executa reveal/filter/persistência reais; só DOM, seleção e desenho são stubs.
  const names = ['idsInScope', 'layout', 'effectiveFilters', 'filter', 'setCustom', 'reveal', 'edgeYears', 'save', 'setFilter'];
  const code = names.map(name => {
    const source = html.match(new RegExp('^  function ' + name + '\\([\\s\\S]*?(?=^  (?:function |const |let |for\\())', 'm'))?.[0];
    assert.ok(source, name);
    return source;
  }).join('\n');
  for (const restrictive of [false, true]) {
    const defaults = { historic: true, identity: true, draft: true, strength: 1, decadeStart: null, decadeEnd: null, undated: true };
    const stored = new Map();
    const host = {
      URL, URLSearchParams, clearTimeout, KEY: muralKey, location: { href: 'http://127.0.0.1/#e=maua' },
      localStorage: { setItem(key, value) { stored.set(key, value); } },
      sessionStorage: { setItem() { assert.fail('ajuste automático não pertence ao sessionStorage'); } },
      temporaryFilters: null, cameraSaveTimer: 0, inspectorOpen: true, undo: [], redo: [], storageOK: true,
      nodes: new Map(seed.nos.map(n => [n.id, n])), edges: new Map(seed.conexoes.map(e => [e.id, e])),
      work: { view: 'custom', customIds: ['rockefeller'], layouts: {}, filters: restrictive
        ? { historic: false, identity: false, draft: false, strength: 5, decadeStart: 2000, decadeEnd: 2020, undated: false }
        : { ...defaults, historic: false } },
      presets: [], dateRanges: new Map(), decades: [], shownNodes: [], shownEdges: [], selected: null,
      fresh: () => ({ filters: { ...defaults } }), clone: structuredClone, indexFilteredEdges() {}, temaView: () => null, // UX6: sem tema aberto
      $: () => ({ hidden: false, classList: { remove() {}, add() {} } }), requestAnimationFrame: callback => callback(),
      refresh() { host.filter(); },
      select(value) { assert.ok(host.shownNodes.some(n => n.id === value.id), 'seleção precisa estar visível'); host.selected = value; host.save(); },
      centerNode(id) { host.centered = id; }, toast(message) { host.notice = message; },
    };
    vm.runInNewContext(code, host);
    host.dateRanges = new Map(seed.conexoes.map(e => [e.id, host.edgeYears(e)]));
    const years = [...host.dateRanges.values()].filter(Boolean).flat();
    host.decades = [Math.floor(Math.min(...years) / 10) * 10, Math.floor(Math.max(...years) / 10) * 10];
    const originalFilters = structuredClone(host.work.filters);
    host.filter();
    host.reveal('maua');
    assert.equal(host.selected.id, 'maua');
    assert.equal(host.centered, 'maua');
    assert.ok(host.shownEdges.some(e => e.origem === 'maua' || e.destino === 'maua'));
    assert.match(host.notice, /Filtros ajustados.*Mauá/);
    assert.match(host.notice, /temporariamente.*Preferências salvas mantidas/);
    assert.deepEqual(host.work.filters, originalFilters);
    host.save(); // Inclui os saves posteriores de câmera/beforeunload.
    assert.deepEqual(JSON.parse(stored.get(muralKey)).filters, originalFilters);
    assert.equal(Object.hasOwn(JSON.parse(stored.get(muralKey)), 'temporaryFilters'), false);
    const filters = host.effectiveFilters();
    assert.equal(filters.historic, true);
    if (restrictive) {
      assert.equal(filters.strength, 4);
      assert.equal(filters.decadeStart, 1850);
      assert.equal(filters.decadeEnd, 2020);
      for (const key of ['identity', 'draft', 'undated']) assert.equal(filters[key], false);
    } else assert.deepEqual(JSON.parse(JSON.stringify(filters)), defaults);
    const beforeInvalid = JSON.stringify(host.work);
    host.reveal('nao-existe');
    assert.equal(JSON.stringify(host.work), beforeInvalid);
    assert.equal(host.selected.id, 'maua');
    assert.equal(host.effectiveFilters(), filters, 'hash inválido mantém a revelação atual');
    host.setFilter('identity', true);
    assert.equal(host.temporaryFilters, null, 'escolha explícita termina o ajuste temporário');
    assert.deepEqual(host.work.filters, { ...originalFilters, identity: true });
    assert.deepEqual(JSON.parse(stored.get(muralKey)).filters, { ...originalFilters, identity: true });
    assert.equal(host.shownNodes.some(n => n.id === 'maua'), false, 'histórico salvo volta a ser aplicado');
  }
});

test('pergunta enviada durante renovação não reaparece; falha mantém a pergunta recuperável', async () => {
  for (const success of [true, false]) {
    const clock = { now: Date.now() };
    let finishRefresh, refreshes = 0, questions = 0;
    const ui = mountChat({ clock, fetchImpl: async (url, options) => {
      if (url.includes('grant_type=password')) return { ok: true, status: 200, json: async () => tokenResponse(clock.now, 60) };
      if (url.includes('grant_type=refresh_token')) {
        refreshes++;
        await new Promise(resolve => { finishRefresh = resolve; });
        return { ok: true, status: 200, json: async () => tokenResponse(clock.now) };
      }
      assert.match(url, /\/functions\/v1\/chat$/);
      assert.equal(JSON.parse(options.body).mensagem, question);
      questions++;
      return { ok: success, status: success ? 200 : 500, text: async () => success
        ? 'event: final\ndata: {"blocos":[{"tipo":"documentado","texto":"Resposta de teste."}]}\n\n'
        : '{"code":"rede"}' };
    } });
    await ui.client.login('visitante@example.test', 'fixture-only');
    ui.elements['chat-open'].listeners.click();
    ui.elements['chat-mensagem'].value = question;
    clock.now += 40000; // Token entrou na janela de renovação de 30 s.
    ui.renderSession();
    assert.equal(JSON.parse(ui.data.get(draftKey)).message, question);
    const sent = ui.elements['chat-form'].listeners.submit({ preventDefault() {} });
    assert.equal(refreshes, 1, 'usa o refresh real do cliente, aguardando resposta mockada');
    assert.equal(ui.data.has(draftKey), false, 'remove a cópia ao enviar');
    ui.renderSession();
    assert.equal(ui.data.has(draftKey), false, 'não recria rascunho durante envio');
    finishRefresh();
    await sent;
    assert.equal(questions, 1);
    assert.equal(ui.elements['chat-mensagem'].value, success ? '' : question);
    ui.renderSession();
    assert.equal(ui.elements['chat-mensagem'].value, success ? '' : question);
    assert.equal(ui.data.has(draftKey), false);
    if (!success) {
      clock.now += 3600000;
      ui.renderSession();
      assert.equal(JSON.parse(ui.data.get(draftKey)).message, question, 'perda real de sessão preserva envio que falhou');
      await ui.client.login('visitante@example.test', 'fixture-only');
      ui.renderSession();
      assert.equal(ui.elements['chat-mensagem'].value, question);
      assert.equal(ui.data.has(draftKey), false);
      assert.equal(questions, 1, 'restaurar não envia de novo');
    }
  }
});

test('rascunho tem TTL de até 30 min, é consumido uma vez e apagado ao sair', async () => {
  const clock = { now: Date.now() };
  for (const draft of [
    { message: question, expiresAt: clock.now },
    { message: question, expiresAt: clock.now - 1 },
    { message: question, expiresAt: clock.now + draftTtl + 1 },
    { message: question },
  ]) {
    const ui = mountChat({ draft, clock });
    assert.equal(ui.data.has(draftKey), false, 'visitante já remove rascunho vencido/inválido');
    await ui.client.login('visitante@example.test', 'fixture-only');
    ui.renderSession();
    assert.equal(ui.elements['chat-panel'].hidden, true);
    assert.equal(ui.elements['chat-mensagem'].value, '');
  }
  const ui = mountChat({ pending: question, clock, redirect: true });
  assert.equal(ui.elements['chat-mensagem'].value, question);
  assert.equal(ui.data.has(draftKey), false);
  ui.elements['chat-mensagem'].value = 'Outra pergunta';
  ui.renderSession();
  assert.equal(ui.elements['chat-mensagem'].value, 'Outra pergunta');
  // Mesmo se houver outra cópia pendente, sair apaga o texto e não o guarda novamente.
  ui.data.set(draftKey, JSON.stringify({ message: question, expiresAt: clock.now + draftTtl }));
  await ui.elements['auth-button'].listeners.click();
  assert.equal(ui.elements['chat-mensagem'].value, '');
  assert.equal(ui.elements['chat-form'].hidden, true);
  assert.equal(ui.data.has(draftKey), false);
});

test('navegação explícita sincroniza o hash de entidade e preserva rotas e retorno de autenticação', () => {
  // Roteamento, seleção e persistência reais; DOM/desenho sem navegador ou rede.
  const names = ['syncEntityHash', 'save', 'changeView', 'select', 'closeInspector', 'reveal', 'applyHash'];
  const code = names.map(name => {
    const source = html.match(new RegExp('^  function ' + name + '\\([\\s\\S]*?(?=^  (?:function |const |let |selected=))', 'm'))?.[0];
    assert.ok(source, name);
    return source;
  }).join('\n');
  const current = new URL('http://127.0.0.1:8080/?entrada=teste#e=maua');
  const stored = new Map(), writes = [];
  const host = {
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, clearTimeout,
    location: { get href() { return current.href; }, get hash() { return current.hash; } },
    window: { history: { replaceState(_state, _title, href) { writes.push(href); current.href = href; } } },
    localStorage: { setItem(key, value) { stored.set(key, value); } }, KEY: muralKey,
    presets: JSON.parse(html.match(/<script id="research-views"[^>]*>([\s\S]*?)<\/script>/)[1]), model: seed,
    nodes: new Map(seed.nos.map(n => [n.id, n])), shownNodes: seed.nos,
    work: { view: 'all' }, temporaryFilters: null, selected: null, inspectorOpen: false, navigationStack: [], undo: [], redo: [],
    cameraSaveTimer: 0, hoverTimer: 0, hovered: null, storageOK: true, showAllEntities: false,
    $: () => ({ classList: { remove() {}, add() {} } }), clone: structuredClone,
    mobile: () => false, cancelCenter() {}, flushNote() {}, refresh() {}, inspector() {}, highlight() {},
    requestAnimationFrame: callback => callback(),
    centerNode(id) { host.centered = id; host.save(); },
  };
  vm.runInNewContext(code, host);
  host.applyHash();
  assert.equal(host.selected.id, 'maua');
  assert.equal(host.centered, 'maua');
  assert.equal(current.hash, '#e=maua');
  assert.equal(writes.length, 0, 'boot e saves de câmera não reescrevem o deep link');
  host.closeInspector();
  assert.equal(current.hash, '#e=maua', 'fechar a ficha mantém o destaque');
  host.select({ kind: 'node', id: 'morgan' });
  assert.equal(current.hash, '#e=morgan');
  host.save();
  assert.equal(writes.length, 1, 'persistência repetida não reescreve a URL de entidade');
  current.hash = '#e=maua';
  host.applyHash(); // Mesmo handler usado no hashchange.
  assert.equal(host.selected.id, 'maua');
  assert.equal(current.hash, '#e=maua');
  host.select({ kind: 'edge', id: seed.conexoes[0].id });
  assert.equal(current.hash, '');
  current.hash = '#e=maua';
  host.applyHash();
  host.select(null);
  assert.equal(current.hash, '');
  assert.equal(JSON.parse(stored.get(muralKey)).selected, null);
  for (const view of ['caso:OP01', 'linhagem_rockefeller', 'brasil', 'mundo', 'all']) {
    host.work.view = 'all';
    current.hash = '#e=maua';
    host.applyHash();
    host.changeView(view);
    const expectedHash = view.startsWith('caso:') ? '#OP01' : '';
    assert.equal(current.hash, expectedHash, view);
    assert.equal(JSON.parse(stored.get(muralKey)).view, view);
    host.applyHash(); // O hash restante não volta a revelar Mauá no reload.
    assert.equal(host.work.view, view);
    if (view.startsWith('caso:')) assert.equal(host.selected.id, seed.casos.find(c => c.id === 'OP01').no_mural);
  }
  for (const [hash, view] of [['OP02', 'caso:OP02'], ['br_maua', 'br_maua']]) {
    current.hash = hash;
    host.applyHash();
    assert.equal(host.work.view, view);
  }
  for (const hash of ['#access_token=fixture&type=signup', '#e=maua&access_token=fixture&type=signup']) {
    current.hash = hash;
    const before = writes.length;
    host.changeView('caso:OP01');
    host.select({ kind: 'node', id: 'morgan' });
    host.select(null);
    assert.equal(current.hash, hash, 'o mural não consome o fragmento da autenticação');
    assert.equal(writes.length, before);
  }
  assert.equal(current.pathname + current.search, '/?entrada=teste');
});

describe('UX4 UI no Chromium', { timeout: 60000 }, () => {
  let server, browser, origin;
  const contexts = [];

  before(async () => {
    fs.mkdirSync(screens, { recursive: true });
    server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
        const data = await fs.promises.readFile(file);
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function openPage({ width = 1440, saved, pending } = {}) {
    const mobile = width < 500;
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    contexts.push(context);
    const traffic = { login: 0, signup: 0, chat: 0, unexpectedSupabase: 0, external: 0, favicon: 0, notFound: [], errors: [] };
    // Vale também para abas de confirmação criadas depois da primeira página.
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) {
        if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: `globalThis.ATLAS_PUBLIC_CONFIG=${JSON.stringify(fixtureConfig)};` });
        if (url.pathname.endsWith('/favicon.ico')) traffic.favicon++;
        return route.continue();
      }
      if (url.hostname.endsWith('.supabase.co')) {
        const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.pathname === '/auth/v1/token') {
          traffic.login++;
          return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(tokenResponse()) });
        }
        if (url.pathname === '/auth/v1/signup') {
          traffic.signup++;
          return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ user: { identities: [{}], confirmation_sent_at: '2026-11-09T12:00:00Z' } }) });
        }
        if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
        if (url.pathname === '/functions/v1/chat') traffic.chat++;
        else traffic.unexpectedSupabase++;
        return route.abort();
      }
      traffic.external++;
      return route.abort(); // Inclui qualquer CDN externa.
    });
    await context.addInitScript(({ origin, muralKey, draftKey, saved, pending }) => {
      // newPage() também executa o seed no about:blank, onde Storage é indisponível.
      if (location.origin !== origin) return;
      // UX6: o tutorial de primeiro acesso tem teste próprio; aqui a visita já o viu.
      if (!localStorage.getItem('aion.tutorial')) localStorage.setItem('aion.tutorial', 'visto-v1');
      if (saved && !sessionStorage.getItem('ux4-seeded')) {
        localStorage.setItem(muralKey, JSON.stringify(saved));
        sessionStorage.setItem('ux4-seeded', '1');
      }
      if (pending && !localStorage.getItem('ux4-pending-seeded')) {
        localStorage.setItem(draftKey, JSON.stringify({ message: pending, expiresAt: Date.now() + 30 * 60 * 1000 }));
        localStorage.setItem('ux4-pending-seeded', '1');
      }
    }, { origin, muralKey, draftKey, saved, pending });
    context.on('page', page => {
      page.on('pageerror', error => traffic.errors.push(error.message));
      page.on('response', response => { if (response.status() === 404) traffic.notFound.push(new URL(response.url()).pathname); });
    });
    const page = await context.newPage();
    return { page, context, traffic };
  }

  // UX6/L7: as ferramentas de edição só existem com ?editor=1; esta suíte cobre o modo editor.
  // O modo público (sem os controles no DOM) é coberto em ux6_ui_test.cjs.
  const editorUrl = suffix => suffix.includes('?') ? suffix.replace('?', '?editor=1&') : suffix.replace(/^\//, '/?editor=1');
  async function ready(page, suffix = '/') {
    await page.goto(origin + editorUrl(suffix));
    await page.waitForFunction(() => !!window.mural && !!window.atlasAuthChat);
  }

  function healthy(traffic) {
    assert.deepEqual(traffic.errors, []);
    assert.deepEqual(traffic.notFound, []);
    assert.equal(traffic.unexpectedSupabase, 0);
  }

  async function withinViewport(page, selector) {
    const bounds = await page.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, `${selector}: ${JSON.stringify(bounds)}`);
  }

  async function gate(page) {
    assert.equal(await page.locator('#chat-login').isVisible(), true);
    assert.equal(await page.locator('#chat-login').innerText(), 'Entrar');
    assert.equal(await page.locator('#chat-form').evaluate(el => el.hidden), true);
    assert.match(await page.locator('#chat-gate').innerText(), /20 perguntas grátis por dia/);
    for (const id of ['chat-form', 'chat-mensagem', 'chat-send', 'chat-modelo']) assert.equal(await page.locator('#' + id).isVisible(), false, id);
  }

  async function centered(page, id, started = 0) {
    const handle = await page.waitForFunction(({ id, started }) => {
      if (!window.mural) return false;
      const state = window.mural.getState();
      const card = document.querySelector(`[data-node-id="${id}"] .node-card`);
      const inspector = document.querySelector('#inspector');
      if (state.selected?.id !== id || !state.inspectorOpen || !state.visibleNodes.includes(id) || !card || inspector.hidden) return false;
      const r = document.querySelector('#network').getBoundingClientRect(), node = card.getBoundingClientRect();
      // No mobile, mede a parte visível do mapa acima da ficha já existente.
      const bottom = innerWidth <= 620 ? Math.min(r.bottom, inspector.getBoundingClientRect().top) : r.bottom;
      const x = node.left + node.width / 2, y = node.top + node.height / 2;
      const distancePx = Math.hypot(x - (r.left + r.width / 2), y - (r.top + bottom) / 2);
      const fullCanvasDistancePx = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (distancePx > 1 || x < r.left || x > r.right || y < r.top || y > bottom) return false;
      return { ms: performance.now() - started, distancePx, fullCanvasDistancePx };
    }, { id, started }, { timeout: 2000, polling: 'raf' });
    const result = await handle.jsonValue();
    await handle.dispose();
    assert.ok(result.ms <= 2000, JSON.stringify(result));
    assert.ok(result.distancePx <= 1, JSON.stringify(result));
    return result;
  }

  async function changeHashAndWait(page, hash) {
    await page.evaluate(hash => new Promise(resolve => {
      window.addEventListener('hashchange', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
      location.hash = hash;
    }), hash);
  }

  for (const width of [360, 390, 393]) test(`topo mobile ${width}px sem overflow e ferramentas no menu`, async () => {
    const { page, traffic } = await openPage({ width });
    await ready(page);
    const dimensions = await page.evaluate(() => ({ innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, deviceScaleFactor: devicePixelRatio }));
    console.log(JSON.stringify({ aceite: 'largura', width, ...dimensions }));
    assert.equal(dimensions.innerWidth, width);
    assert.equal(dimensions.deviceScaleFactor, 3);
    assert.ok(dimensions.document <= dimensions.innerWidth);
    assert.ok(dimensions.body <= dimensions.innerWidth);
    for (const selector of ['#toggle-sidebar', '.brand', '#auth-button', '#chat-open']) await withinViewport(page, selector);
    await page.screenshot({ path: path.join(screens, `mobile-topo-${width}.png`) });
    assert.equal(await page.locator('#add-node').isVisible(), false);
    await page.locator('#toggle-sidebar').click();
    await withinViewport(page, '#draft-mode');
    assert.equal(await page.locator('#draft-mode').isChecked(), false);
    await page.locator('#draft-mode').check();
    for (const id of ['undo', 'redo', 'import-button', 'export-button']) {
      assert.equal(await page.locator('#' + id).isVisible(), true);
      await page.locator('#' + id).scrollIntoViewIfNeeded();
      await withinViewport(page, '#' + id);
    }
    await page.locator('#toggle-sidebar').click();
    for (const id of ['add-node', 'add-edge']) { assert.equal(await page.locator('#' + id).isVisible(), true); await withinViewport(page, '#' + id); }
    const expanded = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, body: document.body.scrollWidth, width: innerWidth }));
    assert.ok(expanded.root <= width && expanded.body <= width, JSON.stringify(expanded));
    healthy(traffic);
  });

  for (const width of [360, 390, 393]) test(`Legenda e barra de zoom separadas e dentro da viewport, ${width}px`, async () => {
    const { page, traffic } = await openPage({ width });
    await ready(page, '/#all'); // UX6: o mapa completo é a opção avançada (#all).
    const legenda = await page.locator('.legend-menu summary').boundingBox();
    const zoombar = await page.locator('.canvas-toolbar').boundingBox();
    assert.ok(legenda && zoombar, 'ambos os controles precisam estar visíveis');
    const buttons = await page.locator('.canvas-toolbar button:visible, .canvas-toolbar output:visible').evaluateAll(elements => elements.map(el => ({ id: el.id, ...el.getBoundingClientRect().toJSON() })));
    const overlap = (a, b) => Math.min(
      Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)));
    const overlapPx = overlap(legenda, zoombar);
    console.log(JSON.stringify({ aceite: 'legenda', width, legenda, zoombar: { ...zoombar, buttons }, overlapPx }));
    assert.equal(overlapPx, 0, 'Legenda não sobrepõe a barra');
    assert.deepEqual(buttons.map(b => b.id), ['zoom-out', 'zoom-level', 'zoom-in', 'pan-mode', 'fit']);
    for (const [id, rect] of [['legenda', legenda], ['zoombar', zoombar], ...buttons.map(b => [b.id, b])]) {
      assert.ok(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 800, `${id}: ${JSON.stringify(rect)}`);
    }
    for (const button of buttons) {
      assert.equal(overlap(legenda, button), 0, button.id);
      assert.ok(button.x >= zoombar.x && button.y >= zoombar.y && button.x + button.width <= zoombar.x + zoombar.width && button.y + button.height <= zoombar.y + zoombar.height, `controle fora da barra: ${JSON.stringify(button)}`);
    }
    await page.locator('.legend-menu summary').click();
    assert.equal(await page.locator('.legend-menu').evaluate(el => el.open), true, 'Legenda recebe o clique');
    healthy(traffic);
  });

  test('cabeçalho desktop 1440 mantém altura e ações dentro da viewport', async () => {
    const { page, traffic } = await openPage();
    await ready(page);
    assert.equal(await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().height), 70);
    assert.equal(await page.locator('#toggle-sidebar').isVisible(), false);
    for (const selector of ['.brand', '#save-state', '#auth-button', '#chat-open']) await withinViewport(page, selector);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);
    await page.screenshot({ path: path.join(screens, 'desktop-topo-1440.png') });
    healthy(traffic);
  });

  for (const width of [393, 1440]) test(`chat visitante e login com rascunho, ${width}px`, async () => {
    const { page, traffic } = await openPage({ width });
    await ready(page);
    await page.locator('#chat-open').click();
    await gate(page);
    await withinViewport(page, '#chat-login');
    await page.screenshot({ path: path.join(screens, `chat-visitante-${width < 500 ? 'mobile' : 'desktop'}.png`) });
    // Simula texto digitado antes da perda da sessão, sem expor campos ao visitante.
    await page.locator('#chat-mensagem').evaluate((el, text) => { el.value = text; }, question);
    await page.locator('#chat-login').click();
    assert.equal(await page.locator('#auth-dialog').evaluate(el => el.open), true);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
    assert.equal(stored.message, question);
    assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'message'], 'não guarda tokens ou credenciais');
    assert.ok(stored.expiresAt <= Date.now() + draftTtl);
    await page.locator('#auth-email').fill('visitante@example.test');
    await page.locator('#auth-password').fill('fixture-only');
    // A rota /auth/v1/token devolve somente a sessão sintética acima.
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => !document.querySelector('#chat-form').hidden);
    assert.equal(await page.locator('#auth-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('#chat-panel').isVisible(), true);
    assert.equal(await page.locator('#chat-mensagem').inputValue(), question);
    assert.equal(await page.locator('#chat-mensagem').isEnabled(), true);
    assert.equal(await page.locator('#chat-send').isEnabled(), true);
    assert.equal(await page.locator('#chat-gate').isVisible(), false);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null);
    assert.equal(traffic.login, 1);
    assert.equal(traffic.chat, 0, 'a restauração não envia pergunta');
    // Sair explicitamente descarta a pergunta, inclusive a cópia compartilhada.
    await page.locator('#auth-button').click();
    await page.waitForFunction(() => document.querySelector('#chat-form').hidden);
    await gate(page);
    assert.equal(await page.locator('#chat-mensagem').inputValue(), '');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null);
    healthy(traffic);
  });

  test('redirect de confirmação reabre chat após navegação e consome rascunho uma vez', async () => {
    const { page, traffic } = await openPage({ pending: question });
    await ready(page);
    await page.locator('#chat-open').click();
    await gate(page);
    const hash = new URLSearchParams({ ...tokenResponse(), type: 'signup' }).toString();
    await ready(page, '/?confirmed=1#' + hash);
    assert.equal(await page.locator('#chat-panel').isVisible(), true);
    assert.equal(await page.locator('#chat-mensagem').inputValue(), question);
    assert.equal(await page.locator('#chat-send').isEnabled(), true);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(traffic.chat, 0);
    await page.reload();
    assert.equal(await page.locator('#chat-panel').isVisible(), false);
    await page.locator('#chat-open').click();
    assert.equal(await page.locator('#chat-mensagem').inputValue(), '');
    healthy(traffic);
  });

  test('confirmação por e-mail em outra aba restaura a pergunta uma única vez', async () => {
    const { page, context, traffic } = await openPage({ width: 393 });
    await ready(page);
    await page.locator('#chat-open').click();
    await page.locator('#chat-mensagem').evaluate((el, text) => { el.value = text; }, question);
    await page.locator('#chat-login').click();
    await page.locator('#auth-mode').click();
    await page.locator('#auth-email').fill('visitante@example.test');
    await page.locator('#auth-password').fill('fixture-only');
    await page.locator('#auth-submit').click();
    await page.waitForFunction(() => !document.querySelector('#auth-status').hidden);
    assert.equal(traffic.signup, 1);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
    assert.equal(stored.message, question);
    assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'message']);
    assert.ok(stored.expiresAt > Date.now() && stored.expiresAt <= Date.now() + draftTtl);
    // newPage não copia sessionStorage da aba original; compartilha só a origem/context.
    const confirmation = await context.newPage();
    const hash = new URLSearchParams({ ...tokenResponse(), type: 'signup' }).toString();
    await ready(confirmation, '/?confirmed=other-tab#' + hash);
    assert.equal(await confirmation.locator('#chat-panel').isVisible(), true);
    assert.equal(await confirmation.locator('#chat-mensagem').inputValue(), question);
    assert.equal(await confirmation.locator('#chat-send').isEnabled(), true);
    assert.equal(await confirmation.evaluate(key => localStorage.getItem(key), draftKey), null);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null);
    assert.equal(await confirmation.evaluate(() => location.hash), '');
    assert.equal(traffic.chat, 0);
    const third = await context.newPage();
    await ready(third);
    assert.equal(await third.locator('#chat-panel').isVisible(), false);
    await third.locator('#chat-open').click();
    assert.equal(await third.locator('#chat-mensagem').inputValue(), '');
    assert.equal(await third.locator('#chat-send').isEnabled(), true);
    assert.equal(traffic.chat, 0, 'nenhuma aba envia ao restaurar');
    healthy(traffic);
  });

  for (const width of [1440, 393]) for (const savedState of ['limpo', 'rockefeller', 'caso', 'historico-desligado', 'restritivo']) test(`hash Mauá ${savedState}, ${width}px; hashchange e id inexistente`, async () => {
    const saved = savedState === 'limpo' ? undefined : {
      schema: 26, view: savedState === 'caso' ? 'caso:OP01' : 'linhagem_rockefeller',
      selected: { kind: 'node', id: savedState === 'caso' ? seed.casos.find(c => c.id === 'OP01').no_mural : 'rockefeller' }, inspectorOpen: true,
      ...(savedState === 'historico-desligado' ? { filters: { historic: false } } : savedState === 'restritivo' ? { filters: { historic: false, identity: false, draft: false, strength: 5, decadeStart: 2000, decadeEnd: 2020, undated: false } } : {}),
    };
    const { page, traffic } = await openPage({ width, saved });
    await ready(page, '/#e=maua');
    const timing = await centered(page, 'maua');
    console.log(JSON.stringify({ aceite: 'hash-maua', width, savedState, ...timing }));
    assert.match(await page.locator('#inspector-content h2').innerText(), /Mauá/);
    assert.equal(await page.evaluate(() => location.hash), '#e=maua');
    if (savedState === 'historico-desligado' || savedState === 'restritivo') {
      const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), muralKey);
      const originalFilters = { historic: true, identity: true, draft: true, strength: 1, decadeStart: null, decadeEnd: null, undated: true, ...saved.filters };
      assert.deepEqual(state.filters, originalFilters, 'revelação não altera nenhuma preferência salva');
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), muralKey), null, 'não usa preferências por aba');
      assert.equal(await page.locator('#historical-filter').isChecked(), true, 'a UI mostra o filtro efetivo temporário');
      assert.equal(await page.locator('#toast').isVisible(), true);
      assert.match(await page.locator('#toast').innerText(), /Filtros ajustados para mostrar.*Mauá/);
      assert.match(await page.locator('#toast').innerText(), /temporariamente.*Preferências salvas mantidas/);
      assert.ok(await page.evaluate(ids => window.mural.getState().visibleEdges.some(id => ids.includes(id)), seed.conexoes.filter(e => e.origem === 'maua' || e.destino === 'maua').map(e => e.id)), 'há ligação direta visível');
      if (savedState === 'restritivo') {
        assert.equal(await page.locator('#strength-filter').inputValue(), '4');
        assert.equal(await page.locator('#decade-start').inputValue(), '1850');
        for (const [id, key] of [['identity-filter', 'identity'], ['draft-filter', 'draft'], ['undated-filter', 'undated']]) assert.equal(await page.locator('#' + id).isChecked(), saved.filters[key], `preserva filtro efetivo ${key}`);
        assert.equal(await page.locator('#decade-end').inputValue(), '2020');
      } else assert.equal(await page.locator('#strength-filter').inputValue(), '1');
    }
    if (savedState === 'limpo') await page.screenshot({ path: path.join(screens, `maua-hash-${width < 500 ? 'mobile' : 'desktop'}.png`) });
    const started = await page.evaluate(() => { const start = performance.now(); location.hash = 'e=morgan'; return start; });
    const changed = await centered(page, 'morgan', started);
    console.log(JSON.stringify({ aceite: 'hashchange-morgan', width, savedState, ...changed }));
    const previous = await page.evaluate(() => window.mural.getState().selected);
    for (const hash of ['e=nao-existe', 'e=%']) {
      await changeHashAndWait(page, hash);
      assert.equal(await page.evaluate(() => location.hash), '#' + hash);
      assert.deepEqual(await page.evaluate(() => window.mural.getState().selected), previous);
      assert.equal(await page.locator('#inspector').isVisible(), true);
    }
    if (saved?.filters) {
      // Remove só a URL; o reload deve descartar os filtros temporários da visita anterior.
      await page.evaluate(() => history.replaceState(null, '', location.pathname + location.search));
      await page.reload();
      await page.waitForFunction(() => !!window.mural && !!window.atlasAuthChat);
      assert.equal(await page.evaluate(() => location.hash), '');
      const originalFilters = { historic: true, identity: true, draft: true, strength: 1, decadeStart: null, decadeEnd: null, undated: true, ...saved.filters };
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).filters, muralKey), originalFilters);
      for (const [id, key] of [['historical-filter', 'historic'], ['identity-filter', 'identity'], ['draft-filter', 'draft'], ['undated-filter', 'undated']]) assert.equal(await page.locator('#' + id).isChecked(), originalFilters[key], `reload aplica ${key} salvo`);
      assert.equal(await page.locator('#strength-filter').inputValue(), String(originalFilters.strength));
      const range = await page.evaluate(filters => ['decade-start', 'decade-end'].map((id, i) => {
        const el = document.getElementById(id), saved = filters[i ? 'decadeEnd' : 'decadeStart'];
        return { actual: el.value, expected: String(saved ?? el.options[i ? el.options.length - 1 : 0].value) };
      }), originalFilters);
      for (const { actual, expected } of range) assert.equal(actual, expected, 'reload aplica período salvo');
      assert.equal(await page.evaluate(() => window.mural.getState().visibleNodes.includes('maua')), false, 'histórico salvo continua excluindo Mauá');
    }
    healthy(traffic);
  });

  test('hashes de caso e preset continuam funcionando na abertura e no hashchange', async () => {
    const { page, traffic } = await openPage();
    await ready(page, '/#OP01');
    assert.equal(await page.evaluate(() => window.mural.getState().view), 'caso:OP01');
    await page.evaluate(() => { location.hash = 'OP02'; });
    await page.waitForFunction(() => window.mural.getState().view === 'caso:OP02');
    await page.evaluate(() => { location.hash = 'br_maua'; });
    await page.waitForFunction(() => window.mural.getState().view === 'br_maua');
    await ready(page, '/?entrada=preset#linhagem_rockefeller');
    assert.equal(await page.evaluate(() => window.mural.getState().view), 'linhagem_rockefeller');
    healthy(traffic);
  });

  for (const width of [1440, 393]) test(`trocar mapa pela UI sai do deep link Mauá e preserva a visão no reload, ${width}px`, async () => {
    const { page, traffic } = await openPage({ width });
    for (const [view, button] of [
      ['caso:OP01', null], ['linhagem_rockefeller', null],
      ['brasil', '#scope-brasil'], ['mundo', '#scope-global'], ['all', '#scope-all'],
    ]) {
      await ready(page, '/?entrada=mapa#e=maua');
      await centered(page, 'maua');
      assert.equal(await page.evaluate(() => location.hash), '#e=maua', 'o deep link funciona também com a visão anterior salva');
      const historyLength = await page.evaluate(() => {
        window.ux4HashChanges = 0;
        window.addEventListener('hashchange', () => window.ux4HashChanges++);
        return history.length;
      });
      if (width < 500) await page.locator('#toggle-sidebar').click();
      if (button) await page.locator(button).click();
      else await page.locator('#map-select').selectOption(view);
      await page.waitForFunction(view => window.mural.getState().view === view, view);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const expectedHash = view.startsWith('caso:') ? '#OP01' : '';
      assert.equal(await page.evaluate(() => location.hash), expectedHash, view);
      assert.equal(await page.evaluate(() => location.search), '?editor=1&entrada=mapa');
      assert.equal(await page.evaluate(() => history.length), historyLength, 'trocar mapa substitui a URL sem criar entrada');
      assert.equal(await page.evaluate(() => window.ux4HashChanges), 0, 'replaceState não inicia ciclos de hashchange');
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).view, muralKey), view);
      await page.reload();
      await page.waitForFunction(() => !!window.mural && !!window.atlasAuthChat);
      const state = await page.evaluate(() => window.mural.getState());
      assert.equal(state.view, view, 'reload mantém o mapa escolhido, sem reaplicar o recorte de Mauá');
      assert.equal(await page.locator('#map-select').inputValue(), view);
      assert.equal(await page.evaluate(() => location.hash), expectedHash);
      if (view === 'caso:OP01') assert.equal(state.selected.id, seed.casos.find(c => c.id === 'OP01').no_mural);
      if (view === 'linhagem_rockefeller') assert.equal(state.visibleNodes.includes('maua'), false);
    }
    healthy(traffic);
  });

  test('selecionar outra entidade atualiza o deep link; ligação e limpar destaque o removem', async () => {
    const { page, traffic } = await openPage();
    await ready(page, '/#e=maua');
    await centered(page, 'maua');
    await page.locator('#close-inspector').click();
    assert.equal(await page.evaluate(() => location.hash), '#e=maua');
    await page.locator('#selection-label').click();
    await page.locator('#search').fill('Morgan');
    await page.locator('[data-result="morgan"]').click();
    await centered(page, 'morgan');
    assert.equal(await page.evaluate(() => location.hash), '#e=morgan');
    await page.reload();
    await centered(page, 'morgan');
    assert.equal(await page.evaluate(() => location.hash), '#e=morgan');
    await page.locator('#clear-highlight').click();
    assert.equal(await page.evaluate(() => location.hash), '');
    await page.reload();
    await page.waitForFunction(() => !!window.mural);
    assert.equal(await page.evaluate(() => window.mural.getState().selected), null);
    assert.equal(await page.locator('#inspector').isVisible(), false);
    await ready(page, '/#e=maua');
    await centered(page, 'maua');
    await page.locator('#inspector-content [data-relation]').first().click();
    const relation = await page.evaluate(() => window.mural.getState().selected);
    assert.equal(relation.kind, 'edge');
    assert.equal(await page.evaluate(() => location.hash), '');
    await page.reload();
    await page.waitForFunction(() => !!window.mural);
    assert.deepEqual(await page.evaluate(() => window.mural.getState().selected), relation);
    assert.equal(await page.evaluate(() => location.hash), '');
    healthy(traffic);
  });

  test('FIX8: arrasto touch iniciado no cartão move a câmera em todos os pontos do gesto', async () => {
    const { page, context, traffic } = await openPage({ width: 393 });
    await ready(page, '/#e=maua');
    await centered(page, 'maua');
    assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true);
    const start = await page.locator('[data-node-id="maua"] .node-card').evaluate(el => {
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (document.elementFromPoint(x, y)?.closest('[data-node-id]')?.dataset.nodeId !== 'maua') throw Error('gesto precisa começar sobre o cartão Mauá');
      window.ux4TouchEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.querySelector('#network').addEventListener(type, event => {
        window.ux4TouchEvents.push({ type, pointerType: event.pointerType, trusted: event.isTrusted });
      });
      return { x, y };
    });
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    await touch('touchStart', start.x, start.y);
    const before = await page.evaluate(() => window.mural.getState());
    const samples = [];
    try {
      for (let step = 1; step <= 6; step++) {
        const dx = step * 20, dy = -step * 10;
        await touch('touchMove', start.x + dx, start.y + dy);
        const sample = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const state = window.mural.getState(), matrix = document.querySelector('#viewport').transform.baseVal.getItem(0).matrix;
          resolve({ camera: state.camera, position: state.positions.maua, rendered: { x: matrix.e, y: matrix.f } });
        }))));
        assert.ok(Math.abs(sample.camera.x - before.camera.x - dx) < 2, `ponto ${step}: câmera x ${JSON.stringify(sample)}`);
        assert.ok(Math.abs(sample.camera.y - before.camera.y - dy) < 2, `ponto ${step}: câmera y ${JSON.stringify(sample)}`);
        assert.equal(sample.camera.k, before.camera.k);
        assert.deepEqual(sample.position, before.positions.maua, 'touch move a câmera, preservando a posição do nó');
        assert.ok(Math.abs(sample.rendered.x - sample.camera.x) < 1 && Math.abs(sample.rendered.y - sample.camera.y) < 1, 'transformação visível acompanha o estado durante o gesto');
        if (samples.length) {
          assert.ok(sample.camera.x > samples.at(-1).camera.x + 18, 'continua movendo após o primeiro movimento');
          assert.ok(sample.camera.y < samples.at(-1).camera.y - 8);
        }
        samples.push(sample);
      }
    } finally {
      await touch('touchEnd');
      await cdp.detach();
    }
    const after = await page.evaluate(() => ({ state: window.mural.getState(), events: window.ux4TouchEvents }));
    assert.equal(after.state.selected.id, 'maua');
    assert.equal(after.state.camera.x, samples.at(-1).camera.x);
    assert.equal(after.state.camera.y, samples.at(-1).camera.y);
    assert.ok(after.events.some(e => e.type === 'pointerdown') && after.events.some(e => e.type === 'pointerup'));
    assert.ok(after.events.filter(e => e.type === 'pointermove').length >= 6);
    assert.ok(after.events.every(e => e.trusted && e.pointerType === 'touch'), 'eventos de toque reais do Chromium, sem dispatchEvent sintético');
    console.log(JSON.stringify({ aceite: 'FIX8-touch', width: 393, samples: samples.map(s => ({ x: s.camera.x - before.camera.x, y: s.camera.y - before.camera.y })) }));
    healthy(traffic);
  });

  test('modo leitura por padrão, rascunho explícito e retorno para leitura', async () => {
    const { page, traffic } = await openPage();
    await ready(page, '/#e=maua');
    await centered(page, 'maua');
    const tools = ['add-node', 'add-edge', 'detail-edit', 'detail-connect', 'export-button', 'import-button', 'undo', 'redo', 'layout', 'note-text'];
    assert.equal(await page.locator('#draft-mode').isChecked(), false);
    for (const id of tools) assert.equal(await page.locator('#' + id).isVisible(), false, id);
    assert.match(await page.locator('#draft-warning').innerText(), /Nada é enviado à base pública/);
    const beforePan = await page.evaluate(() => window.mural.getState().positions.maua);
    const card = await page.locator('[data-node-id="maua"] .node-card').boundingBox();
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2 + 35, card.y + card.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => window.mural.getState().positions.maua), beforePan, 'arrastar em leitura só move a câmera');
    await page.locator('#draft-mode').check();
    for (const id of tools) assert.equal(await page.locator('#' + id).isVisible(), true, id);
    await page.locator('#add-node').click();
    assert.equal(await page.locator('#editor-dialog').evaluate(el => el.open), true);
    await page.locator('#cancel-editor').click();
    await page.locator('#note-text').fill('Anotação local de teste');
    await page.locator('#draft-mode').uncheck();
    for (const id of tools) assert.equal(await page.locator('#' + id).isVisible(), false, id);
    assert.equal(await page.locator('#note-readonly').isVisible(), true);
    assert.equal(await page.locator('#note-preview').innerText(), 'Anotação local de teste');
    assert.equal(await page.locator('#note-readonly textarea, #note-readonly input, #note-readonly [contenteditable="true"]').count(), 0);
    const notes = await page.evaluate(() => window.mural.getState().notes);
    await page.locator('#map-title').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.deepEqual(await page.evaluate(() => window.mural.getState().notes), notes, 'atalho não desfaz em leitura');
    await page.reload();
    assert.equal(await page.locator('#draft-mode').isChecked(), false);
    for (const id of ['add-node', 'export-button', 'note-text']) assert.equal(await page.locator('#' + id).isVisible(), false);
    assert.equal(await page.locator('#note-preview').innerText(), 'Anotação local de teste');
    assert.equal(await page.locator('#note-readonly').isVisible(), true);
    await page.locator('#draft-mode').check();
    assert.equal(await page.locator('#note-readonly').isVisible(), false);
    assert.equal(await page.locator('#note-text').inputValue(), 'Anotação local de teste');
    assert.equal(traffic.chat, 0);
    healthy(traffic);
  });

  test('favicon inline evita 404 e nota técnica aparece só com debug=1', async () => {
    const { page, traffic } = await openPage();
    const generic = seed.nos.find(n => n.tipo === 'universidade').id;
    // O modular já reconhece universidade (mapa de tipos preservado no BUILD2).
    // Testa também esse suporte; o fallback usa um tipo realmente desconhecido.
    await ready(page, '/?debug=1#e=' + generic);
    await centered(page, generic);
    assert.match(await page.locator('#inspector-content .entity-type').textContent(), /Universidade/);
    assert.doesNotMatch(await page.locator('#inspector-content').innerText(), /Tipo sem estilo próprio/);
    const fallbackSeed = structuredClone(seed);
    fallbackSeed.nos.find(n => n.id === generic).tipo = 'tipo_desconhecido_fixture';
    // BUILD4: a base vem de dados.json; o fallback troca o arquivo (e o sha256 esperado no index).
    const fallbackBody = JSON.stringify(fallbackSeed);
    const fallbackSha = require('node:crypto').createHash('sha256').update(fallbackBody).digest('hex');
    const ref = dataRef(html);
    const fallbackHtml = ref.src ? html.replace(ref.attrs, ref.attrs.replace(/data-sha256="[0-9a-f]+"/, `data-sha256="${fallbackSha}"`))
      : html.replace(/(<script id="research-data"[^>]*>)[\s\S]*?(<\/script>)/,
        (_match, start, end) => start + fallbackBody.replace(/<\//g, '<\\/') + end);
    const dataPath = ref.src ? '/' + ref.src.split('?')[0] : null;
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fallbackHtml })
      : dataPath && new URL(route.request().url()).pathname === dataPath
        ? route.fulfill({ contentType: 'application/json; charset=utf-8', body: fallbackBody })
        : route.fallback());
    await ready(page, '/#e=' + generic);
    await centered(page, generic);
    assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), 'data:,');
    assert.equal(await page.locator('#toast').isVisible(), false);
    assert.doesNotMatch(await page.locator('#inspector-content').innerText(), /Tipo sem estilo próprio/);
    await ready(page, '/?debug=1#e=' + generic);
    assert.match(await page.locator('#toast').innerText(), /Tipo sem estilo próprio/);
    assert.equal(await page.locator('#toast').isVisible(), true);
    assert.match(await page.locator('#inspector-content').innerText(), /Tipo sem estilo próprio/);
    assert.equal(traffic.favicon, 0);
    healthy(traffic);
  });
});
