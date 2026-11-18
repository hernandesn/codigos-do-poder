'use strict';
// Regressão da corrida de código pendente sem browser, Auth real ou leitura de env.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ORIGIN = 'https://ozeiyqpbtggvuyhplisa.supabase.co';
const CODE = 'ABCDE-FGHJK-MNPQR-STUVW';
const source = fs.readFileSync(path.resolve(__dirname, '../scripts/telegram/telegram-link.js'), 'utf8').replaceAll('__SUPABASE_ORIGIN__', ORIGIN);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(issueMode = 'ok') {
  const nodes = new Map(), events = new Map();
  for (const name of ['status', 'generate', 'logout', 'code-panel', 'code', 'command', 'expires', 'login-form', 'link-section', 'email', 'password', 'login', 'copy']) {
    nodes.set(name, { value: '', textContent: '', hidden: ['code-panel', 'link-section'].includes(name), disabled: false, classList: { toggle(className, force) { this[className] = force === undefined ? !this[className] : !!force; } }, events: new Map(), addEventListener(type, callback) { this.events.set(type, callback); } });
  }
  let session = null;
  let revokeMode = 'ok';
  const started = deferred(), result = deferred();
  const server = { codes: [] };
  const order = [];
  const client = {
    restore: () => null,
    readSession: () => session,
    async refresh() { return { ok: true, session }; },
    async login(email) { session = { accessToken: 'jwt-sintetico-' + email }; return { ok: true }; },
    async logout() { session = null; },
  };
  const window = { ATLAS_PUBLIC_CONFIG: { supabaseUrl: ORIGIN, supabaseAnonKey: 'public-test-placeholder' }, atlasAuthChat: { createClient: () => client }, addEventListener: (type, callback) => events.set(type, callback) };
  await vm.runInNewContext(source, {
    window, document: { getElementById: name => nodes.get(name) }, navigator: {}, Date, AbortSignal,
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      assert.equal(url, ORIGIN + '/functions/v1/telegram-link');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      const body = options.body === '{}' ? {} : JSON.parse(options.body);
      if (body.revogar === true) {
        order.push('revoke');
        if (revokeMode === 'network') throw new TypeError('Failed to fetch');
        if (revokeMode === 'http') return Response.json({ revogado: true }, { status: 403 });
        if (revokeMode === 'false') return Response.json({ revogado: false });
        server.codes = [];
        return Response.json({ revogado: true });
      }
      assert.deepEqual(body, {});
      order.push('issue-start');
      started.resolve();
      const response = await result.promise;
      if (issueMode !== 'rate') server.codes.push(CODE);
      if (issueMode === 'network') throw new TypeError('Failed to fetch');
      if (issueMode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      order.push('issue-end');
      return response;
    },
  });
  return {
    nodes, started, result, events, server, order,
    loggedIn: () => session !== null,
    setAccessToken(value) { if (session) session.accessToken = value; },
    setRevokeMode(mode) { revokeMode = mode; },
    async fire(name, event = 'click') { return nodes.get(name).events.get(event)({ preventDefault() {} }); },
  };
}
async function login(f, email = 'teste@example.invalid') {
  f.nodes.get('email').value = email;
  f.nodes.get('password').value = 'senha-sintetica';
  await f.fire('login-form', 'submit');
}
test('emissão em voo e logout não deixam código válido no servidor', async () => {
  const f = await fixture();
  await login(f);
  const pending = f.fire('generate');
  await f.started.promise;
  assert.equal(f.nodes.get('logout').disabled, true);
  assert.deepEqual(f.server.codes, []);
  const loggingOut = f.fire('logout');
  assert.deepEqual(f.order, ['issue-start']);
  f.result.resolve(Response.json({ code: CODE, expires_in: 600 }));
  await loggingOut;
  await pending;
  assert.deepEqual(f.order, ['issue-start', 'issue-end', 'revoke']);
  assert.deepEqual(f.server.codes, []);
  assert.equal(f.loggedIn(), false);
  assert.equal(f.nodes.get('login-form').hidden, false);
  assert.equal(f.nodes.get('link-section').hidden, true);
  assert.equal(f.nodes.get('code-panel').hidden, true);
  assert.equal(f.nodes.get('code').textContent, '');
  assert.equal(f.nodes.get('command').textContent, '');
  f.nodes.get('email').value = 'segunda@example.invalid';
  f.nodes.get('password').value = 'senha-sintetica';
  await f.fire('login-form', 'submit');
  assert.equal(f.nodes.get('code-panel').hidden, true);
  assert.equal(f.nodes.get('code').textContent, '');
  assert.equal(f.nodes.get('command').textContent, '');
  assert.equal(f.nodes.get('password').value, '');
  assert.equal(f.loggedIn(), true);
});
test('pagehide invalida geração pendente, não revoga e não mostra código ao voltar', async () => {
  const f = await fixture();
  await login(f);
  const pending = f.fire('generate');
  await f.started.promise;
  f.events.get('pagehide')();
  f.result.resolve(Response.json({ code: CODE, expires_in: 600 }));
  await pending;
  assert.deepEqual(f.order, ['issue-start', 'issue-end']);
  assert.deepEqual(f.server.codes, [CODE]);
  assert.equal(f.loggedIn(), true);
  assert.equal(f.nodes.get('login-form').hidden, true);
  assert.equal(f.nodes.get('code-panel').hidden, true);
  assert.equal(f.nodes.get('code').textContent, '');
});
for (const [mode, label] of [['network', 'rede'], ['http', 'HTTP 403'], ['false', '{revogado:false}']]) {
  test(`revogação com falha (${label}) não entra no login como sucesso`, async () => {
    const f = await fixture();
    await login(f);
    const pending = f.fire('generate');
    await f.started.promise;
    f.result.resolve(Response.json({ code: CODE, expires_in: 600 }));
    await pending;
    assert.equal(f.nodes.get('code').textContent, CODE);
    assert.equal(f.nodes.get('logout').disabled, false);
    assert.deepEqual(f.server.codes, [CODE]);
    f.setRevokeMode(mode);
    await f.fire('logout');
    assert.equal(f.loggedIn(), true);
    assert.equal(f.nodes.get('login-form').hidden, true);
    assert.equal(f.nodes.get('link-section').hidden, false);
    assert.equal(f.nodes.get('status').classList.warning, true);
    assert.equal(f.nodes.get('status').textContent, 'Não foi possível revogar os códigos pendentes. A conta continua conectada.');
    assert.deepEqual(f.server.codes, [CODE]);
    assert.equal(f.nodes.get('logout').disabled, false);
    assert.equal(f.nodes.get('generate').disabled, false);
    f.setRevokeMode('ok');
    await f.fire('logout');
    assert.equal(f.loggedIn(), false);
    assert.deepEqual(f.server.codes, []);
    assert.equal(f.nodes.get('login-form').hidden, false);
    assert.equal(f.nodes.get('code').textContent, '');
  });
}
for (const mode of ['network', 'timeout', 'server']) {
  test(`emissão inconclusiva (${mode}) não conclui o logout`, async () => {
    const f = await fixture(mode);
    await login(f);
    const pending = f.fire('generate');
    await f.started.promise;
    const loggingOut = f.fire('logout');
    assert.deepEqual(f.order, ['issue-start']);
    f.result.resolve(mode === 'server' ? Response.json({ message: 'falha' }, { status: 502 }) : Response.json({ code: CODE }));
    await loggingOut;
    await pending;
    assert.equal(f.loggedIn(), true);
    assert.equal(f.order.includes('revoke'), false);
    assert.equal(f.nodes.get('status').classList.warning, true);
    assert.equal(f.nodes.get('status').textContent, 'Não foi possível confirmar a emissão do código. A conta continua conectada. Tente sair de novo.');
    assert.deepEqual(f.server.codes, [CODE]);
    assert.equal(f.nodes.get('login-form').hidden, true);
    assert.equal(f.nodes.get('link-section').hidden, false);
    assert.equal(f.nodes.get('logout').disabled, false);
    assert.equal(f.nodes.get('generate').disabled, false);
    await f.fire('logout');
    assert.equal(f.loggedIn(), false);
    assert.equal(f.order.at(-1), 'revoke');
    assert.deepEqual(f.server.codes, []);
    assert.equal(f.nodes.get('login-form').hidden, false);
  });
}
test('emissão 429 em voo ainda revoga e conclui o logout', async () => {
  const f = await fixture('rate');
  await login(f);
  const pending = f.fire('generate');
  await f.started.promise;
  const loggingOut = f.fire('logout');
  f.result.resolve(Response.json({ message: 'Aguarde 30 segundos antes de gerar outro código.' }, { status: 429 }));
  await loggingOut;
  await pending;
  assert.deepEqual(f.order, ['issue-start', 'issue-end', 'revoke']);
  assert.equal(f.loggedIn(), false);
  assert.deepEqual(f.server.codes, []);
  assert.equal(f.nodes.get('login-form').hidden, false);
});
test('sessão visível sem token não conta como revogação', async () => {
  const f = await fixture();
  await login(f);
  f.setAccessToken('');
  await f.fire('logout');
  assert.deepEqual(f.order, []);
  assert.equal(f.loggedIn(), true);
  assert.equal(f.nodes.get('login-form').hidden, true);
  assert.equal(f.nodes.get('link-section').hidden, false);
  assert.equal(f.nodes.get('status').classList.warning, true);
  assert.equal(f.nodes.get('status').textContent, 'Não foi possível revogar os códigos pendentes. A conta continua conectada.');
  assert.equal(f.nodes.get('logout').disabled, false);
});
test('logout sem sessão não chama o servidor nem afirma revogação', async () => {
  const f = await fixture();
  await f.fire('logout');
  assert.deepEqual(f.order, []);
  assert.equal(f.loggedIn(), false);
  assert.equal(f.nodes.get('status').classList.warning, false);
  assert.equal(f.nodes.get('status').textContent, 'Entre na sua conta para gerar o código.');
  assert.equal(f.nodes.get('status').textContent.includes('revog'), false);
});
test('sem parsePublicConfig o login não exige captcha e o corpo segue só e-mail e senha', async () => {
  const f = await fixture();
  await login(f);
  assert.equal(f.nodes.get('link-section').hidden, false);
  assert.equal(f.nodes.get('password').value, '');
});
