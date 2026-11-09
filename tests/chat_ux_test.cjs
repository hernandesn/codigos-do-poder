'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const authScript = html.match(/<script>\s*(\/\* Login Supabase Auth e chat[\s\S]*?)<\/script>/)?.[1];
const muralApi = html.match(/^\s*window\.mural=.+;$/m)?.[0];
assert.ok(authScript, 'inline auth/chat script exists');
assert.ok(muralApi, 'mural state API exists');

const plain = (value) => JSON.parse(JSON.stringify(value));
const failureSse = 'event: error\ndata: {"code":"fora_da_base","message":"Não encontrei isso na base do atlas."}\n\n';
const hint = 'Selecione uma pessoa ou instituição no mural, ou cite o nome dela na pergunta.';

function load() {
  // Evaluate the real mural API against local model stubs, without booting the mural.
  const host = {
    module: { exports: {} },
    URL, URLSearchParams, TextDecoder, AbortController, atob,
    fetch() { throw new Error('Network disabled in chat UX tests'); },
    work: { view: 'all', notes: {} }, selected: null,
    clone: plain, inspectorOpen: false, hovered: null,
    directEdges: new Set(), secondEdges: new Set(), labelBoxes: [],
    mobile: () => false, camera: () => ({}), layout: () => ({ positions: {} }),
    shownNodes: [], shownEdges: [], nodes: new Map(), edges: new Map(),
    sources: new Map(), model: { casos: [] },
  };
  host.window = host;
  const context = vm.createContext(host);
  vm.runInContext(muralApi, context, { filename: 'index.html:mural-api' });
  vm.runInContext(authScript, context, { filename: 'index.html:auth-chat' });
  return { host, api: host.module.exports };
}

function mountChat(api, result) {
  function element(tagName = 'div') {
    let text = '';
    return {
      tagName, attributes: {}, children: [], listeners: {}, dataset: {}, value: '',
      get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
      set textContent(value) { text = String(value); this.children = []; },
      set innerHTML(value) { throw new Error('Use DOM APIs and textContent in chat rendering'); },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    };
  }
  const nodes = Object.fromEntries([
    'chat-context', 'chat-log', 'chat-form', 'chat-mensagem', 'chat-status',
  ].map((id) => [id, element()]));
  const mounted = api.mount({
    getElementById: (id) => nodes[id] || null,
    createElement: element,
  }, {
    config: null,
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetchImpl() { throw new Error('Network disabled in chat UX tests'); },
  });
  const sent = [];
  mounted.client.ask = async (input) => {
    sent.push(api.buildChatBody(input));
    return result;
  };
  return {
    ...mounted, nodes, sent,
    async submit() {
      nodes['chat-mensagem'].value = 'Qual é a relação entre eles?';
      await nodes['chat-form'].listeners.submit({ preventDefault() {} });
    },
  };
}

test('fora_da_base SSE maps to its error code at HTTP 200', () => {
  const { api } = load();
  const result = api.mapChatFailure(200, api.parseSse(failureSse), failureSse);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'fora_da_base');
  assert.equal(result.message, 'Não encontrei isso na base do atlas.');
});

test('meta/delta/delta/final replay yields ok with final blocos', () => {
  const { api } = load();
  const blocos = [{ tipo: 'documentado', texto: 'Relação documentada.', entidades: ['walther_ms'], relacoes: [], fontes: ['fonte_1'] }];
  const replay = [
    ['meta', { modelo: 'basico' }],
    ['delta', { text: 'Relação ' }],
    ['delta', { text: 'documentada.' }],
    ['final', { blocos, gratis_restantes: 2, saldo_pago: 0 }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const parser = api.createSseParser();
  const events = [];
  // Split event names, JSON and separators across chunks like a streamed response.
  for (let i = 0; i < replay.length; i += 7) events.push(...parser.push(replay.slice(i, i + 7)));
  events.push(...parser.finish());
  assert.deepEqual(plain(events.map((item) => item.event)), ['meta', 'delta', 'delta', 'final']);
  const result = api.mapChatFailure(200, events, replay);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.deepEqual(plain(result.final.blocos), blocos);
});

test('cited sources render safe HTTP(S) links and literal titles/locators before meta', async () => {
  const { api } = load();
  const ui = mountChat(api, { ok: true, final: {
    blocos: [{ tipo: 'documentado', texto: 'Resposta.', fontes: ['ignored'] }],
    fontes: ['S1', 'S2', 'S1'],
    fontes_detalhe: {
      S1: { titulo: '<img src=x onerror=alert(1)>', url: 'https://example.test/report', localizador: '<b>p. 12</b>' },
      S2: { titulo: 'Outra fonte', url: 'http://example.test/other' },
    },
  } });
  await ui.submit();
  const lines = ui.nodes['chat-log'].children[0].children;
  assert.equal(lines[1].className, 'chat-answer');
  const sources = lines[2];
  assert.equal(sources.tagName, 'div');
  assert.equal(sources.className, 'chat-sources');
  assert.equal(sources.children[0].textContent, 'Fontes citadas');
  const list = sources.children[1];
  assert.equal(list.tagName, 'ul');
  assert.equal(list.children.length, 2);
  for (const [index, protocol] of ['https', 'http'].entries()) {
    const li = list.children[index];
    const link = li.children[0];
    assert.equal(li.tagName, 'li');
    assert.equal(link.tagName, 'a');
    assert.equal(link.attributes.href, `${protocol}://example.test/${index ? 'other' : 'report'}`);
    assert.equal(link.attributes.target, '_blank');
    assert.equal(link.attributes.rel, 'noopener noreferrer');
    assert.equal(link.children.length, 0);
  }
  assert.equal(list.children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(list.children[0].textContent, '<img src=x onerror=alert(1)> · <b>p. 12</b>');
  assert.equal(list.children[0].children[1].tagName, 'span');
  assert.equal(sources.children.length, 2, 'empty relations section is omitted');
  assert.equal(lines[3].className, 'chat-meta');
});

test('unsafe or invalid source URLs stay plain text and partial details fall back to IDs', async () => {
  const { api } = load();
  const invalidUrls = ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.test/file', '/relative', 'not a URL'];
  const ids = invalidUrls.map((_, i) => `S${i}`);
  const ui = mountChat(api, { ok: true, final: {
    blocos: [{ tipo: 'documentado', texto: 'Resposta.' }],
    fontes: [...ids, 'missing', 'partial', 'blank', 'locatorOnly'],
    fontes_detalhe: {
      ...Object.fromEntries(ids.map((id, i) => [id, { titulo: `Fonte ${i}`, url: invalidUrls[i] }])),
      partial: { url: 'https://example.test/partial' },
      blank: { titulo: ' ' },
      locatorOnly: { localizador: 'p. 7' },
    },
  } });
  await ui.submit();
  const sources = ui.nodes['chat-log'].children[0].children[2];
  const items = sources.children[1].children;
  for (const [index, id] of ids.entries()) {
    assert.equal(items[index].textContent, `Fonte ${index}`, id);
    assert.equal(items[index].children.length, 0, 'untrusted URL is not a link');
  }
  assert.equal(items[5].textContent, 'missing');
  assert.equal(items[5].children.length, 0);
  assert.equal(items[6].children[0].tagName, 'a');
  assert.equal(items[6].children[0].textContent, 'partial');
  assert.equal(items[7].textContent, 'blank');
  assert.equal(items[7].children.length, 0);
  assert.equal(items[8].textContent, 'locatorOnly · p. 7');
});

test('missing or empty final fontes falls back to the ordered union of block sources', async () => {
  const { api } = load();
  for (const fontes of [undefined, []]) {
    const ui = mountChat(api, { ok: true, final: {
      fontes,
      blocos: [
        { tipo: 'documentado', texto: 'Primeiro.', fontes: ['S2', 'S1'] },
        { tipo: 'documentado', texto: 'Segundo.', fontes: ['S1', 'S3'] },
        { tipo: 'inferencia', texto: 'Leitura.', base: [] },
      ],
    } });
    await ui.submit();
    const sources = ui.nodes['chat-log'].children[0].children[4];
    assert.equal(sources.className, 'chat-sources');
    assert.deepEqual(sources.children[1].children.map((li) => li.textContent), ['S2', 'S1', 'S3']);
  }
});

test('documented relations and inference bases are de-duplicated and limited to 12', async () => {
  const { api } = load();
  const ui = mountChat(api, { ok: true, final: {
    blocos: [
      { tipo: 'documentado', texto: 'Fato.', relacoes: ['r1', 'r2', 'r1'], base: ['unused'] },
      { tipo: 'inferencia', texto: 'Leitura.', base: ['r2', 'r3'], relacoes: ['unused'] },
      { tipo: 'documentado', texto: 'Mais fatos.', relacoes: Array.from({ length: 13 }, (_, i) => `r${i + 1}`) },
    ],
  } });
  await ui.submit();
  const sources = ui.nodes['chat-log'].children[0].children[4];
  // Sem fontes: só a seção de relações aparece.
  assert.equal(sources.className, 'chat-sources');
  assert.equal(sources.children.length, 2);
  assert.equal(sources.children[0].textContent, 'Relações usadas');
  assert.equal(sources.children[1].tagName, 'p');
  assert.equal(sources.children[1].textContent, Array.from({ length: 12 }, (_, i) => `r${i + 1}`).join(', '));
});

test('answer without sources or relations renders no empty sources box', async () => {
  const { api } = load();
  const ui = mountChat(api, { ok: true, final: { blocos: [{ tipo: 'documentado', texto: 'Só texto.' }] } });
  await ui.submit();
  const kids = ui.nodes['chat-log'].children[0].children;
  assert.equal(kids.some((node) => node.className === 'chat-sources'), false);
});

test('selected edge resolves origem/destino and buildChatBody sends both entity IDs', async () => {
  const { host, api } = load();
  host.selected = { kind: 'edge', id: 'edge_1' };
  host.edges.set('edge_1', { id: 'edge_1', origem: 'walther_ms', destino: 'banco_ms' });
  const endpoints = host.mural.getState().selectedEndpoints;
  assert.deepEqual(plain(endpoints), ['walther_ms', 'banco_ms']);
  assert.deepEqual(plain(api.buildChatBody({ mensagem: 'Relação?', entidades: endpoints }).contexto.entidades), ['walther_ms', 'banco_ms']);
  const ui = mountChat(api, { ok: false, code: 'fora_da_base' });
  await ui.submit();
  assert.deepEqual(plain(ui.sent[0].contexto), { entidades: ['walther_ms', 'banco_ms'], view: 'all' });
  assert.equal(ui.nodes['chat-context'].textContent, 'Recorte enviado: walther_ms, banco_ms');
  // Read from the current edge map, including personal edits, rather than seed data.
  host.edges.set('edge_1', { id: 'edge_1', origem: 'soros', destino: 'rothschild' });
  await ui.submit();
  assert.deepEqual(plain(ui.sent[1].contexto.entidades), ['soros', 'rothschild']);
});

test('edge context is capped at two IDs and rejects invalid endpoint IDs', async () => {
  const { host, api } = load();
  host.mural.getState = () => ({
    selected: { kind: 'edge', id: 'edge_1' },
    selectedEndpoints: ['valid.ID_1:-', 'second_id', 'third_id'],
  });
  const ui = mountChat(api, { ok: false, code: 'fora_da_base' });
  await ui.submit();
  assert.deepEqual(plain(ui.sent[0].contexto.entidades), ['valid.ID_1:-', 'second_id']);
  for (const invalid of ['bad id', 'bad/id', '<script>', '', 'a'.repeat(121), null, 42]) {
    host.mural.getState = () => ({ selected: { kind: 'edge' }, selectedEndpoints: ['valid_id', invalid] });
    await ui.submit();
    assert.deepEqual(plain(ui.sent.at(-1).contexto.entidades), ['valid_id']);
  }
  host.mural.getState = () => ({ selected: { kind: 'edge' }, selectedEndpoints: ['same', 'same'] });
  await ui.submit();
  assert.deepEqual(plain(ui.sent.at(-1).contexto.entidades), ['same']);
});

test('unselected, node and missing-edge contexts behave correctly', async () => {
  const { host, api } = load();
  const ui = mountChat(api, { ok: false, code: 'fora_da_base' });
  assert.equal(ui.nodes['chat-context'].textContent, hint);
  await ui.submit();
  assert.deepEqual(plain(ui.sent[0].contexto.entidades), []);
  host.selected = { kind: 'node', id: 'walther_ms' };
  ui.renderSession();
  assert.equal(ui.nodes['chat-context'].textContent, 'Recorte enviado: walther_ms');
  await ui.submit();
  assert.deepEqual(plain(ui.sent[1].contexto.entidades), ['walther_ms']);
  host.selected = { kind: 'edge', id: 'missing_edge' };
  await ui.submit();
  assert.deepEqual(plain(ui.sent[2].contexto.entidades), []);
  assert.equal(ui.nodes['chat-context'].textContent, hint);
});

test('fora_da_base renders a second error line with the chat-tip class', async () => {
  const { api } = load();
  const result = api.mapChatFailure(200, api.parseSse(failureSse), failureSse);
  const ui = mountChat(api, result);
  await ui.submit();
  const lines = ui.nodes['chat-log'].children[0].children;
  assert.equal(lines[1].className, 'chat-error');
  assert.equal(lines[1].dataset.code, 'fora_da_base');
  assert.equal(lines[1].textContent, result.message);
  assert.equal(lines[2].className, 'chat-tip');
  assert.equal(lines[2].textContent, 'Dica: selecione a entidade no mural antes de perguntar.');
  assert.equal(lines.length, 3);
});

test('other errors do not render the fora_da_base tip', async () => {
  const { api } = load();
  const ui = mountChat(api, { ok: false, code: 'rede', message: 'Falha de conexão.' });
  await ui.submit();
  const lines = ui.nodes['chat-log'].children[0].children;
  assert.equal(lines.length, 2);
  assert.equal(lines[1].className, 'chat-error');
  assert.equal(lines[1].dataset.code, 'rede');
});
