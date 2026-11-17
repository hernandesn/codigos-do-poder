'use strict';
// F4: Turnstile explícito. Fetch simulado; nenhuma chamada sai para Cloudflare ou Supabase.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const siteRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(siteRoot, 'mapa', 'index.html'), 'utf8');
const authScript = html.match(/<script>\s*(\/\* Login Supabase Auth e chat[\s\S]*?)<\/script>/)?.[1];
assert.ok(authScript, 'script de auth embutido no index');

const TEST_SITE_KEY = '1x00000000000000000000AA';
const SECRET_TEST_KEYS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SUPABASE = 'https://fixture.supabase.co';

function loadApi() {
  const realm = vm.createContext({
    module: { exports: {} },
    URL, URLSearchParams, TextDecoder, atob,
  });
  vm.runInContext(authScript, realm, { filename: 'index.html:auth-chat' });
  return { api: realm.module.exports, realm };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

function publicConfig(siteKey) {
  const raw = { supabaseUrl: SUPABASE, supabaseAnonKey: 'public-test-placeholder' };
  if (siteKey !== undefined) raw.turnstileSiteKey = siteKey;
  return raw;
}

function tokenPayload() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access = ['fixture', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'fixture'].join('.');
  return { access_token: access, refresh_token: 'fixture-refresh', expires_in: 3600 };
}

function signupPayload() {
  return { user: { identities: [{}], confirmation_sent_at: '2026-11-16T12:00:00Z' } };
}

function element() {
  let text = '';
  return {
    value: '', hidden: false, disabled: false, open: false, children: [], listeners: {}, dataset: {}, attributes: {},
    get textContent() { return text; },
    set textContent(value) { text = String(value ?? ''); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    appendChild(child) { this.children.push(child); return child; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    remove() {},
  };
}

function mountAuth(siteKey, options = {}) {
  const { api, realm } = loadApi();
  const ids = [
    'chat-login', 'auth-dialog', 'auth-form', 'auth-email', 'auth-password',
    'auth-error', 'auth-status', 'auth-turnstile', 'auth-mode', 'auth-title',
    'auth-submit', 'auth-note', 'auth-cancel',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const calls = [];
  const turnstile = { renders: [], resets: [], api: null };
  turnstile.api = {
    render(target, options) {
      turnstile.renders.push({ target, options });
      return 'widget-1';
    },
    reset(id) { turnstile.resets.push(id); },
  };
  const head = element();
  head.appendChild = (child) => {
    head.children.push(child);
    if (typeof child.onload === 'function') {
      realm.turnstile = turnstile.api;
      child.onload();
    }
    return child;
  };
  const doc = {
    head,
    getElementById: (id) => elements[id] || null,
    createElement: () => element(),
  };
  api.mount(doc, {
    config: publicConfig(siteKey),
    storage: memoryStorage(),
    location: { origin: 'http://127.0.0.1', pathname: '/', search: '', hash: '' },
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: JSON.parse(init.body),
        resetsBefore: turnstile.resets.length,
      });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      const signup = String(url).includes('/auth/v1/signup');
      return { ok: true, status: 200, json: async () => (signup ? signupPayload() : tokenPayload()) };
    },
  });
  return { api, elements, calls, turnstile, head };
}

async function submit(ui, email, password) {
  ui.elements['auth-email'].value = email;
  ui.elements['auth-password'].value = password;
  await ui.elements['auth-form'].listeners.submit({ preventDefault() {} });
}

test('CSP do index libera challenges.cloudflare.com só em script-src e frame-src', () => {
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(policy, /script-src 'self' https:\/\/challenges\.cloudflare\.com /);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.doesNotMatch(policy, /connect-src[^;]*challenges\.cloudflare\.com/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-eval'/);
  assert.equal(/<script[^>]*src=["']https:\/\/challenges\.cloudflare\.com/.test(html), false);
  assert.match(html, /id="auth-turnstile"/);
  const configJs = fs.readFileSync(path.join(siteRoot, 'config.js'), 'utf8');
  // Sitekey pública de produção (não é segredo). A secreta fica só no Supabase Auth.
  assert.match(configJs, /"turnstileSiteKey":"0x4AAAAAAGDto-Jqyp0wkmqA"/);
  assert.equal(loadApi().api.parsePublicConfig(publicConfig('0x4AAAAAAGDto-Jqyp0wkmqA')).turnstileSiteKey, '0x4AAAAAAGDto-Jqyp0wkmqA');
  assert.equal(configJs.includes(TEST_SITE_KEY), false);
  for (const secret of SECRET_TEST_KEYS) assert.equal(configJs.includes(secret), false);
});

test('parsePublicConfig deixa a sitekey vazia e recusa chave secreta', () => {
  const { api } = loadApi();
  assert.equal(api.parsePublicConfig(publicConfig()).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig(publicConfig('')).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig(publicConfig('  ')).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig(publicConfig(TEST_SITE_KEY)).turnstileSiteKey, TEST_SITE_KEY);
  for (const secret of SECRET_TEST_KEYS) {
    assert.equal(api.parsePublicConfig(publicConfig(secret)).turnstileSiteKey, '');
  }
  assert.equal(api.parsePublicConfig(publicConfig('chave-secreta')).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig(publicConfig('sk-or-abc')).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig(publicConfig('sb_secret_abc')).turnstileSiteKey, '');
  assert.equal(api.parsePublicConfig({ supabaseUrl: 'nota-url', supabaseAnonKey: 'public-test-placeholder', turnstileSiteKey: TEST_SITE_KEY }).ok, false);
});

test('sitekey vazia omite gotrue_meta_security no login e no cadastro', async () => {
  const { api } = loadApi();
  const calls = [];
  const client = api.createClient({
    config: publicConfig(''),
    storage: memoryStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const signup = String(url).includes('/auth/v1/signup');
      return { ok: true, status: 200, json: async () => (signup ? signupPayload() : tokenPayload()) };
    },
  });
  assert.equal((await client.login('pessoa@example.test', 'senha-forte')).ok, true);
  assert.equal((await client.signup('pessoa@example.test', 'senha-forte', { origin: 'http://127.0.0.1', pathname: '/' })).ok, true);
  assert.equal((await client.login('pessoa@example.test', 'senha-forte', '')).ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.body, { email: 'pessoa@example.test', password: 'senha-forte' });
    assert.equal('gotrue_meta_security' in call.body, false);
  }
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.match(calls[1].url, /\/auth\/v1\/signup\?/);

  const ui = mountAuth('');
  assert.equal(ui.head.children.length, 0);
  ui.elements['chat-login'].listeners.click();
  assert.equal(ui.elements['auth-dialog'].open, true);
  assert.equal(ui.head.children.length, 0);
  assert.equal(ui.turnstile.renders.length, 0);
  await submit(ui, 'pessoa@example.test', 'senha-forte');
  assert.equal(ui.calls.length, 1);
  assert.deepEqual(ui.calls[0].body, { email: 'pessoa@example.test', password: 'senha-forte' });
  assert.equal('gotrue_meta_security' in ui.calls[0].body, false);
  assert.equal(ui.turnstile.resets.length, 0);
});

test('sitekey de teste envia o token no login e no cadastro e reinicia o widget', async () => {
  const { api } = loadApi();
  const calls = [];
  const client = api.createClient({
    config: publicConfig(TEST_SITE_KEY),
    storage: memoryStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const signup = String(url).includes('/auth/v1/signup');
      return { ok: true, status: 200, json: async () => (signup ? signupPayload() : tokenPayload()) };
    },
  });
  assert.equal((await client.login('pessoa@example.test', 'senha-forte', 'token-login')).ok, true);
  assert.equal((await client.signup('pessoa@example.test', 'senha-forte', { origin: 'http://127.0.0.1', pathname: '/' }, 'token-signup')).ok, true);
  assert.deepEqual(calls[0].body, {
    email: 'pessoa@example.test',
    password: 'senha-forte',
    gotrue_meta_security: { captcha_token: 'token-login' },
  });
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.deepEqual(calls[1].body.gotrue_meta_security, { captcha_token: 'token-signup' });
  assert.match(calls[1].url, /\/auth\/v1\/signup\?/);

  const ui = mountAuth(TEST_SITE_KEY);
  assert.equal(ui.head.children.length, 0);
  ui.elements['chat-login'].listeners.click();
  assert.equal(ui.head.children.length, 1);
  assert.equal(ui.head.children[0].src, TURNSTILE_SRC);
  assert.equal(ui.head.children[0].attributes['data-turnstile'], 'explicit');
  assert.equal(ui.turnstile.renders.length, 1);
  assert.equal(ui.turnstile.renders[0].options.sitekey, TEST_SITE_KEY);
  assert.equal(ui.turnstile.renders[0].target, ui.elements['auth-turnstile']);
  ui.elements['chat-login'].listeners.click();
  assert.equal(ui.head.children.length, 1, 'abrir de novo não recarrega o script');

  await submit(ui, 'pessoa@example.test', 'senha-forte');
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.elements['auth-error'].hidden, false);
  assert.equal(ui.elements['auth-error'].textContent, ui.api.MESSAGES.captcha_pendente);
  assert.equal(ui.elements['auth-password'].value, 'senha-forte');

  ui.turnstile.renders[0].options.callback('token-login');
  await submit(ui, 'pessoa@example.test', 'senha-forte');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].method, 'POST');
  assert.deepEqual(ui.calls[0].body.gotrue_meta_security, { captcha_token: 'token-login' });
  assert.match(ui.calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(ui.calls[0].resetsBefore, 0, 'login não reinicia antes do envio');
  assert.deepEqual(ui.turnstile.resets, ['widget-1']);

  await submit(ui, 'pessoa@example.test', 'senha-forte');
  assert.equal(ui.calls.length, 1, 'token usado não volta no pedido seguinte');
  assert.equal(ui.elements['auth-error'].textContent, ui.api.MESSAGES.captcha_pendente);
  assert.deepEqual(ui.turnstile.resets, ['widget-1']);

  ui.elements['auth-mode'].listeners.click();
  ui.turnstile.renders[0].options.callback('token-signup');
  await submit(ui, 'pessoa@example.test', 'senha-forte');
  assert.equal(ui.calls.length, 2);
  assert.match(ui.calls[1].url, /\/auth\/v1\/signup\?/);
  assert.deepEqual(ui.calls[1].body.gotrue_meta_security, { captcha_token: 'token-signup' });
  assert.equal(ui.calls[1].resetsBefore, 1, 'cadastro não reinicia antes do envio');
  assert.deepEqual(ui.turnstile.resets, ['widget-1', 'widget-1']);
  ui.turnstile.renders[0].options['expired-callback']();
  await submit(ui, 'pessoa@example.test', 'outra-senha');
  assert.equal(ui.calls.length, 2);
});

test('erro de credencial reinicia o token depois da tentativa', async () => {
  const ui = mountAuth(TEST_SITE_KEY, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }),
  });
  ui.elements['chat-login'].listeners.click();
  ui.turnstile.renders[0].options.callback('token-erro');
  await submit(ui, 'pessoa@example.test', 'senha-errada');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].resetsBefore, 0, 'erro não reinicia antes do envio');
  assert.deepEqual(ui.calls[0].body.gotrue_meta_security, { captcha_token: 'token-erro' });
  assert.deepEqual(ui.turnstile.resets, ['widget-1']);
  assert.equal(ui.elements['auth-error'].hidden, false);
  assert.equal(ui.elements['auth-password'].value, '');
});
