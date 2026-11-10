'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const { seedText } = require('./dados_site.cjs');
const muralScript = html.match(/<script>\s*((?:\(\(\) => \{|\(function mural\(\) \{)[\s\S]*?)<\/script>/)[1];
const muralKey = 'codigos-do-poder:mural:v25';
const plain = value => JSON.parse(JSON.stringify(value));

// Monta o script inteiro do mural, incluindo boot, handlers, desenho e persistência.
// Só o DOM, relógio e Storage são adaptadores offline; nenhuma função do app é stub.
// As sondas de leitura/fixture são inseridas apenas na cópia executada pelo teste.
function mountMural({ hash = '#e=maua', saved = { schema: 25, view: 'all', filters: { historic: false } } } = {}) {
  const elements = new Map(), frames = new Map(), listeners = new Map();
  const stored = new Map([[muralKey, JSON.stringify(saved)]]), writes = [];
  const current = new URL('http://127.0.0.1/' + hash);
  let sequence = 0, now = 0;
  const camel = key => key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  function element(tagName = 'div') {
    const classes = new Set(), events = new Map(), attributes = new Map();
    const el = {
      tagName, dataset: {}, children: [], parentElement: null, textContent: '', innerHTML: '', value: '', hidden: false,
      style: { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } },
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
      },
      setAttribute(key, value) {
        attributes.set(key, value);
        if (key === 'class') { classes.clear(); value.split(/\s+/).forEach(name => classes.add(name)); }
        else if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = value;
      },
      getAttribute: key => attributes.get(key) ?? null,
      // FIX8 modular agrupa paths em DocumentFragment; reproduz seu esvaziamento real.
      get childNodes() { return this.children; },
      append(...children) { for (const child of children) {
        if (child.tagName === '#document-fragment') { this.append(...child.children.slice()); continue; }
        child.remove(); child.parentElement = this; this.children.push(child);
      } },
      appendChild(child) { this.append(child); return child; },
      prepend(...children) { this.append(...children); this.children.unshift(...this.children.splice(-children.length)); },
      replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      matches(selector) {
        if (selector.startsWith('.')) return classes.has(selector.slice(1));
        const data = selector.match(/^\[data-([\w-]+)\]$/);
        return data ? Object.hasOwn(this.dataset, camel(data[1])) : this.tagName === selector;
      },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      addEventListener(type, callback) { events.set(type, [...(events.get(type) || []), callback]); },
      dispatch(type, event = {}) { for (const callback of events.get(type) || []) callback({ target: this, preventDefault() {}, ...event }); },
      getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }; },
      getBBox() { return { x: 0, y: 0, width: this.textContent.length * 6, height: 12 }; },
      setPointerCapture() {}, close() { this.open = false; },
    };
    return el;
  }
  function get(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  get('research-data').textContent = seedText(html, path.join(__dirname, '..'));
  get('research-views').textContent = html.match(/<script id="research-views"[^>]*>([\s\S]*?)<\/script>/)[1];
  const document = {
    getElementById: get, createElement: element, createDocumentFragment: () => element('#document-fragment'), createElementNS: (_namespace, tag) => element(tag), body: element('body'),
    querySelector: selector => get(selector), addEventListener() {}, getElementsByTagName: () => [],
  };
  const host = {
    document, URL, URLSearchParams, console, innerWidth: 1440, innerHeight: 800,
    location: { get href() { return current.href; }, get hash() { return current.hash; }, get search() { return current.search; } },
    history: { replaceState(_state, _title, href) { current.href = href; } },
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem(key, value) { stored.set(key, value); writes.push({ key, value }); },
    },
    sessionStorage: { setItem() { assert.fail('o mural não pode persistir o ajuste em sessionStorage'); } },
    fetch() { assert.fail('rede desabilitada'); },
    performance: { now: () => now },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id), setTimeout: () => ++sequence, clearTimeout() {},
    matchMedia: () => ({ matches: false }), ResizeObserver: class { observe() {} },
    addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
  };
  host.window = host;
  const probes = `
    globalThis.probes = {
      snapshot: () => clone({ work, temporaryFilters, effectiveFilters: effectiveFilters() }),
      remember, refresh, work: () => work
    };
  `;
  vm.runInNewContext(muralScript.replace(/\}\)\(\);\s*$/, probes + '\n})();'), host, { filename: 'index.html:mural' });
  function settle() {
    for (let count = 0; frames.size; count++) {
      assert.ok(count < 20, 'animações precisam terminar');
      const callbacks = [...frames.values()]; frames.clear(); now += 300;
      callbacks.forEach(callback => callback(now));
    }
  }
  settle();
  return {
    get, stored, writes, probes: host.probes, state: () => plain(host.mural.getState()), settle,
    hash(value) { current.hash = value; (listeners.get('hashchange') || []).forEach(callback => callback()); settle(); },
    clickItem(kind, id) {
      const layer = get(kind === 'node' ? 'node-layer' : 'edge-layer');
      const target = layer.querySelectorAll(kind === 'node' ? '[data-node-id]' : '[data-edge-id]').find(el => el.dataset[kind === 'node' ? 'nodeId' : 'edgeId'] === id);
      assert.ok(target, 'o alvo clicado precisa existir no SVG: ' + id);
      const event = { target, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 };
      get('network').dispatch('pointerdown', event); get('network').dispatch('pointerup', event); settle();
    },
    enableDraft() { get('draft-mode').checked = true; get('draft-mode').onchange(); },
    unload() { (listeners.get('beforeunload') || []).forEach(callback => callback()); },
  };
}

function assertSavedFilters(ui, expected) {
  assert.deepEqual(JSON.parse(ui.stored.get(muralKey)).filters, expected);
  for (const { key, value } of ui.writes) {
    assert.equal(key, muralKey);
    const work = JSON.parse(value);
    assert.deepEqual(work.filters, expected, 'nenhum save pode adotar os filtros temporários');
    assert.equal(Object.hasOwn(work, 'temporaryFilters'), false);
  }
}

function assertRestoredFilters(ui) {
  const snapshot = ui.probes.snapshot();
  assert.equal(snapshot.temporaryFilters, null);
  assert.deepEqual(snapshot.effectiveFilters, snapshot.work.filters);
  // Compara o refresh da transição com um boot sem hash do mesmo estado restaurado.
  const pristine = mountMural({ hash: '', saved: plain(snapshot.work) });
  assert.deepEqual(ui.state().visibleNodes, pristine.state().visibleNodes);
  assert.deepEqual(ui.state().visibleEdges, pristine.state().visibleEdges);
  for (const id of ['visible-count', 'map-subtitle', 'strength-value']) assert.equal(ui.get(id).textContent, pristine.get(id).textContent, id);
  for (const id of ['historical-filter', 'identity-filter', 'draft-filter', 'undated-filter']) assert.equal(ui.get(id).checked, pristine.get(id).checked, id);
  for (const id of ['strength-filter', 'decade-start', 'decade-end']) assert.equal(ui.get(id).value, pristine.get(id).value, id);
}

for (const kind of ['node', 'edge']) test('selecionar ' + kind + ' visível no recorte temporário mantém mapa e preferências', () => {
  const ui = mountMural(), original = plain(ui.probes.work().filters);
  const before = ui.state();
  assert.equal(before.selected.id, 'maua');
  assert.ok(ui.probes.snapshot().temporaryFilters);
  assert.equal(original.historic, false);
  assert.equal(ui.probes.snapshot().effectiveFilters.historic, true);
  const id = kind === 'node' ? 'bb1851' : before.visibleEdges[0];
  assert.ok(before[kind === 'node' ? 'visibleNodes' : 'visibleEdges'].includes(id));
  ui.clickItem(kind, id);
  const after = ui.state();
  assert.deepEqual(after.selected, { kind, id });
  assert.ok(after.visibleNodes.length > 0);
  assert.ok(after.visibleEdges.length > 0);
  assert.ok(after[kind === 'node' ? 'visibleNodes' : 'visibleEdges'].includes(id), 'o item clicado continua visível');
  assert.deepEqual(after.visibleNodes, before.visibleNodes);
  assert.deepEqual(after.visibleEdges, before.visibleEdges);
  assert.ok(ui.probes.snapshot().temporaryFilters);
  ui.unload();
  assertSavedFilters(ui, original);
  ui.get('clear-highlight').onclick(); ui.settle();
  assert.equal(ui.probes.snapshot().temporaryFilters, null);
  assert.deepEqual(plain(ui.probes.snapshot().effectiveFilters), original);
  assertSavedFilters(ui, original);
});

test('undo e redo descartam o ajuste ao substituir work, sem gravá-lo', () => {
  const ui = mountMural({ hash: '' }), original = plain(ui.probes.work().filters);
  const all = ui.state();
  ui.enableDraft();
  ui.probes.remember();
  ui.hash('#e=maua');
  assert.equal(ui.state().view, 'custom');
  assert.ok(ui.probes.snapshot().temporaryFilters);
  ui.get('undo').onclick(); ui.settle();
  assertRestoredFilters(ui);
  assert.equal(ui.state().view, 'all');
  assert.equal(ui.state().selected, null);
  assert.deepEqual(ui.state().visibleNodes, all.visibleNodes);
  assert.deepEqual(ui.state().visibleEdges, all.visibleEdges);
  // Recria a revelação entre undo e redo: reveal não altera a pilha de histórico.
  ui.hash('#e=maua');
  assert.ok(ui.probes.snapshot().temporaryFilters);
  ui.get('redo').onclick(); ui.settle();
  assertRestoredFilters(ui);
  assert.equal(ui.state().view, 'custom');
  assert.equal(ui.state().selected.id, 'maua');
  assert.equal(ui.get('historical-filter').checked, false);
  assertSavedFilters(ui, original);
});

test('importar substitui work e descarta o ajuste; importação inválida preserva a visita', async () => {
  const ui = mountMural(), original = plain(ui.probes.work().filters);
  ui.enableDraft();
  const importJSON = async value => {
    const input = ui.get('import-file');
    input.value = 'copia.json';
    input.files = [{ size: value.length, text: async () => value }];
    await input.onchange({ target: input }); ui.settle();
    assert.equal(input.value, '');
  };
  await importJSON('{');
  assert.ok(ui.probes.snapshot().temporaryFilters, 'falha antes de substituir work mantém o ajuste atual');
  assert.equal(ui.state().selected.id, 'maua');
  const next = plain(ui.probes.work());
  next.view = 'all'; next.selected = null; next.inspectorOpen = false;
  const base = JSON.parse(ui.get('research-data').textContent);
  await importJSON(JSON.stringify({ formato: 'codigos-do-poder/mural', base, espaco_pessoal: next }));
  const state = ui.state();
  assertRestoredFilters(ui);
  assert.equal(state.view, 'all');
  assert.equal(state.selected, null);
  assert.equal(ui.get('historical-filter').checked, false);
  assert.equal(state.visibleNodes.includes('maua'), false);
  assert.ok(state.visibleNodes.length > 0 && state.visibleEdges.length > 0);
  assertSavedFilters(ui, original);
});

test('reset de work inválido também descarta o ajuste temporário', () => {
  const ui = mountMural();
  assert.ok(ui.probes.snapshot().temporaryFilters);
  ui.probes.work().filters.strength = 0; // Força o caminho real de recuperação do rebuild.
  ui.probes.refresh(); ui.settle();
  const snapshot = ui.probes.snapshot();
  assert.equal(snapshot.temporaryFilters, null);
  assert.deepEqual(snapshot.effectiveFilters, snapshot.work.filters);
  assert.equal(ui.state().selected, null);
  assert.equal(ui.state().view, 'all');
});
