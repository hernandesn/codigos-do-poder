'use strict';
// Toast de cópia com DOM mínimo falso. Sem rede e sem dependências além de node:test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/telegram/copy-toast.js'), 'utf8');
const linkSource = fs.readFileSync(path.resolve(__dirname, '../scripts/telegram/telegram-link.js'), 'utf8');
const PAYLOAD = '<img src=x onerror=alert(1)>';

function classList() {
  const names = new Set();
  return {
    add(...items) { for (const name of items) names.add(name); },
    remove(...items) { for (const name of items) names.delete(name); },
    contains(name) { return names.has(name); },
  };
}

function createElement(tag) {
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    readOnly: false,
    value: '',
    parentNode: null,
    children: [],
    classList: classList(),
    innerHTMLWrites: 0,
    _text: '',
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(value) { el._text = String(value); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._text; },
    set() { el.innerHTMLWrites += 1; },
  });
  return el;
}

function harness({ clipboard, secure = true, exec = () => true } = {}) {
  const body = createElement('body');
  const command = createElement('strong');
  command.textContent = '/start ABCDE-FGHJK-MNPQR-STUVW';
  const selection = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); } };
  let execCalls = 0;
  let clock = 0;
  let seq = 0;
  const pending = new Map();
  const document = {
    body,
    activeElement: null,
    createElement,
    createRange() { return { node: null, selectNodeContents(node) { this.node = node; } }; },
    execCommand(commandName) {
      execCalls += 1;
      assert.equal(commandName, 'copy');
      const area = body.children.find(node => node.tagName === 'TEXTAREA');
      assert.ok(area, 'textarea temporário presente durante execCommand');
      assert.equal(area.className, 'copy-fallback');
      assert.equal(area.readOnly, true);
      assert.equal(area.getAttribute('style'), null);
      const result = exec(area);
      return result;
    },
  };
  const navigator = {};
  if (clipboard !== undefined) navigator.clipboard = clipboard;
  const window = {
    isSecureContext: secure,
    document,
    navigator,
    getSelection() { return selection; },
  };
  const context = {
    window,
    document,
    navigator,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { fn, due: clock + ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
  };
  vm.runInNewContext(source, context);
  function advance(ms) {
    clock += ms;
    const due = [...pending.entries()].filter(([, timer]) => timer.due <= clock).sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
    for (const [id, timer] of due) {
      if (!pending.has(id)) continue;
      pending.delete(id);
      timer.fn();
    }
  }
  function toast() {
    return body.children.find(node => node.className === 'copy-toast') || null;
  }
  function settle() {
    advance(50);
    return toast();
  }
  function textareas() {
    return body.children.filter(node => node.tagName === 'TEXTAREA');
  }
  return { window, document, command, selection, toast, settle, textareas, advance, execCalls: () => execCalls };
}

test('clipboard ok anuncia Copiado!', async () => {
  let written = null;
  const h = harness({ clipboard: { async writeText(value) { written = value; } } });
  const ok = await h.window.copyText(h.command.textContent, h.command);
  assert.equal(ok, true);
  assert.equal(written, h.command.textContent);
  assert.equal(h.execCalls(), 0);
  assert.equal(h.toast().textContent, '');
  const toast = h.settle();
  assert.equal(toast.textContent, 'Copiado!');
  assert.equal(toast.classList.contains('is-visible'), true);
  assert.equal(h.textareas().length, 0);
});

test('clipboard ausente usa execCommand e anuncia Copiado!', async () => {
  const h = harness({ clipboard: undefined, exec: () => true });
  const ok = await h.window.copyText('comando ausente', h.command);
  assert.equal(ok, true);
  assert.equal(h.execCalls(), 1);
  assert.equal(h.settle().textContent, 'Copiado!');
  assert.equal(h.textareas().length, 0);
});

test('clipboard que rejeita cai no execCommand com sucesso', async () => {
  const h = harness({
    clipboard: { async writeText() { throw new Error('negado'); } },
    exec: area => { assert.equal(area.value, 'texto'); return true; },
  });
  const ok = await h.window.copyText('texto', h.command);
  assert.equal(ok, true);
  assert.equal(h.execCalls(), 1);
  assert.equal(h.settle().textContent, 'Copiado!');
  assert.equal(h.textareas().length, 0);
});

test('clipboard e execCommand falham: erro, seleção e textarea removido', async () => {
  const h = harness({
    clipboard: { async writeText() { throw new Error('negado'); } },
    exec: () => false,
  });
  const ok = await h.window.copyText(h.command.textContent, h.command);
  assert.equal(ok, false);
  assert.equal(h.settle().textContent, 'Não deu para copiar, selecione o código');
  assert.equal(h.command.classList.contains('copy-select-all'), true);
  assert.equal(h.selection.ranges.length, 1);
  assert.equal(h.selection.ranges[0].node, h.command);
  assert.equal(h.textareas().length, 0);
});

test('execCommand que lança também falha, seleciona e remove o textarea', async () => {
  const h = harness({
    clipboard: undefined,
    exec() { throw new Error('execCommand indisponível'); },
  });
  const ok = await h.window.copyText('código', h.command);
  assert.equal(ok, false);
  assert.equal(h.settle().textContent, 'Não deu para copiar, selecione o código');
  assert.equal(h.selection.ranges[0].node, h.command);
  assert.equal(h.textareas().length, 0);
});

test('toast usa textContent e o payload com img onerror fica literal', () => {
  const h = harness();
  h.window.showToast(PAYLOAD);
  assert.equal(h.toast().textContent, '');
  const toast = h.settle();
  assert.equal(toast.textContent, PAYLOAD);
  assert.equal(toast.innerHTMLWrites, 0);
  assert.equal(toast.innerHTML, PAYLOAD);
  assert.equal(source.includes('innerHTML'), false);
});

test('região existe vazia antes do clique e o texto entra depois da tarefa', () => {
  const h = harness();
  const toast = h.toast();
  assert.ok(toast);
  assert.equal(toast.textContent, '');
  assert.equal(toast.classList.contains('is-visible'), false);
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
  assert.equal(toast.getAttribute('aria-atomic'), 'true');
  assert.equal(bodyCount(h), 1);
  h.window.showToast('Copiado!');
  assert.equal(h.toast().textContent, '');
  h.advance(49);
  assert.equal(h.toast().textContent, '');
  h.advance(1);
  assert.equal(h.toast().textContent, 'Copiado!');
  h.window.showToast('de novo');
  assert.equal(bodyCount(h), 1);
  assert.equal(h.toast().textContent, '');
  h.advance(50);
  assert.equal(h.toast().textContent, 'de novo');
});

test('sem body a região nasce vazia no DOMContentLoaded', () => {
  let body = null;
  const listeners = [];
  const document = {
    get body() { return body; },
    createElement,
    addEventListener(type, fn) { listeners.push({ type, fn }); },
  };
  const window = { document, isSecureContext: true, getSelection() { return null; } };
  vm.runInNewContext(source, {
    window,
    document,
    navigator: {},
    setTimeout() { return 0; },
    clearTimeout() {},
  });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'DOMContentLoaded');
  assert.equal(body, null);
  body = createElement('body');
  listeners[0].fn();
  const toast = body.children.find(node => node.className === 'copy-toast');
  assert.ok(toast);
  assert.equal(toast.textContent, '');
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
  assert.equal(toast.getAttribute('aria-atomic'), 'true');
  listeners[0].fn();
  assert.equal(body.children.filter(node => node.className === 'copy-toast').length, 1);
});

function bodyCount(h) {
  return h.document.body.children.filter(node => node.className === 'copy-toast').length;
}

test('toast some após 2s e o timer reinicia a cada cópia', async () => {
  const h = harness({ clipboard: { async writeText() {} } });
  assert.equal(h.toast().textContent, '');
  await h.window.copyText('um', h.command);
  assert.equal(h.toast().textContent, '');
  assert.equal(h.toast().classList.contains('is-visible'), true);
  h.advance(50);
  assert.equal(h.toast().textContent, 'Copiado!');
  h.advance(1949);
  assert.equal(h.toast().classList.contains('is-visible'), true);
  h.advance(1);
  assert.equal(h.toast().classList.contains('is-visible'), false);
  await h.window.copyText('dois', h.command);
  h.advance(1500);
  assert.equal(h.toast().textContent, 'Copiado!');
  await h.window.copyText('três', h.command);
  assert.equal(h.toast().textContent, '');
  h.advance(1500);
  assert.equal(h.toast().classList.contains('is-visible'), true);
  assert.equal(h.toast().textContent, 'Copiado!');
  h.advance(500);
  assert.equal(h.toast().classList.contains('is-visible'), false);
});

test('contexto inseguro não chama clipboard e usa o fallback', async () => {
  let called = false;
  const h = harness({
    secure: false,
    clipboard: { async writeText() { called = true; } },
    exec: () => true,
  });
  const ok = await h.window.copyText('fora do https', h.command);
  assert.equal(ok, true);
  assert.equal(called, false);
  assert.equal(h.execCalls(), 1);
  assert.equal(h.settle().textContent, 'Copiado!');
});

test('vincular delega a cópia ao toast e não repete o anúncio no status', () => {
  assert.match(linkSource, /window\.copyText\(command\.textContent, command\)/);
  assert.equal(linkSource.includes('Comando copiado.'), false);
  assert.equal(linkSource.includes('navigator.clipboard'), false);
});
