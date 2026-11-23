'use strict';
// Servidor local + SDK falso + backend interceptado: nenhuma conexão externa.
// PLAYWRIGHT_PATH=<pacote existente na box> node --test tests/telegram_app_test.cjs
// Sem PLAYWRIGHT_PATH o teste é ignorado, para `node --test tests/` não exigir browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const prints = path.resolve(root, '../prints');
const API = 'https://ozeiyqpbtggvuyhplisa.supabase.co';
// Ignora integralmente o ambiente real: token e todos os dados abaixo são sintéticos.
const FAKE_TOKEN = '000000000:AAFAKE_TOKEN_FOR_UNIT_TESTS_ONLY__';
function initData() {
  const values = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: randomBytes(12).toString('hex'), user: JSON.stringify({ id: 101, first_name: 'Teste local' }) };
  const check = Object.keys(values).sort().map(key => key + '=' + values[key]).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(FAKE_TOKEN).digest();
  return new URLSearchParams({ ...values, hash: createHmac('sha256', key).update(check).digest('hex') }).toString();
}
function validate(header) {
  assert.ok(header.startsWith('tma '));
  const fields = new URLSearchParams(header.slice(4));
  const expected = createHmac('sha256', createHmac('sha256', 'WebAppData').update(FAKE_TOKEN).digest())
    .update([...fields.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n')).digest();
  assert.ok(timingSafeEqual(expected, Buffer.from(fields.get('hash'), 'hex')));
  assert.ok(Math.abs(Date.now() / 1000 - Number(fields.get('auth_date'))) < 60);
  assert.equal(JSON.parse(fields.get('user')).id, 101);
  return fields.get('hash');
}
function fakeSession(sub = '11111111-1111-4111-8111-111111111111') {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  // JWT apenas sintético; o backend mockado não é o Auth real.
  return { access_token: part({ alg: 'HS256' }) + '.' + part({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.assinatura-sintetica', refresh_token: 'refresh-sintetico-' + sub, expires_in: 3600 };
}

test('Telegram: vínculo, conversa, erros, login e CSP em 1440×900 e 390×844', { timeout: 120000, skip: process.env.PLAYWRIGHT_PATH ? false : 'defina PLAYWRIGHT_PATH; o Chromium não é instalado neste job' }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_PATH);
  const server = http.createServer(async (req, res) => {
    const file = new URL(req.url, 'http://local').pathname;
    if (file === '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`window.ATLAS_PUBLIC_CONFIG={supabaseUrl:${JSON.stringify(API)},supabaseAnonKey:"public-test-placeholder"};`); return; }
    if (!['/app.html', '/vincular.html'].includes(file) && !/^\/fonts\/[a-z0-9-]+\.woff2$/.test(file)) { res.writeHead(404); res.end(); return; }
    try { const body = await fs.promises.readFile(root + file); res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'font/woff2' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    fs.mkdirSync(prints, { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 900], ['celular', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500, serviceWorkers: 'block' });
      try {
        let currentInit = '', linked = false, releaseChat, holdCode = false, releaseCode;
        const accepted = new Set(), proof = 'e'.repeat(64), external = [], errors = [], apiCalls = [];
        let authSession = fakeSession();
        await context.route('**/*', async route => {
          const req = route.request(), url = new URL(req.url());
          const reply = result => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type,apikey,x-telegram-app-session', 'access-control-allow-methods': 'POST,OPTIONS' }, body: JSON.stringify(result) });
          if (url.href === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(currentInit)},ready(){},expand(){}}};` });
          if (url.origin === API) {
            apiCalls.push(url.pathname);
            if (req.method() === 'OPTIONS') return reply({});
            if (url.pathname === '/auth/v1/token') {
              const body = req.postDataJSON();
              if (url.searchParams.get('grant_type') === 'password') {
                assert.ok(['teste@example.invalid', 'outra@example.invalid'].includes(body.email)); assert.equal(body.password, 'senha-sintetica-local');
                assert.equal(body.gotrue_meta_security, undefined);
                authSession = fakeSession(body.email === 'outra@example.invalid' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111');
              }
              else assert.equal(body.refresh_token, authSession.refresh_token);
              return reply(authSession);
            }
            if (url.pathname === '/auth/v1/logout') return reply({});
            if (url.pathname === '/functions/v1/telegram-link') {
              assert.equal(req.headers().authorization, 'Bearer ' + authSession.access_token);
              const payload = req.postDataJSON();
              if (payload && payload.revogar === true) {
                assert.equal(payload.user_id, undefined);
                assert.equal(payload.telegram_id, undefined);
                return reply({ revogado: true });
              }
              assert.deepEqual(payload, {});
              if (holdCode) await new Promise(resolve => { releaseCode = resolve; });
              return reply({ code: 'ABCDE-FGHJK-MNPQR-STUVW', expires_in: 600 });
            }
            if (url.pathname.startsWith('/functions/v1/telegram/app/')) {
              const hash = validate(req.headers().authorization);
              if (url.pathname.endsWith('/session')) { assert.ok(!accepted.has(hash)); accepted.add(hash); return reply({ linked, session: proof, expires_at: Math.floor(Date.now() / 1000) + 3600 }); }
              assert.equal(req.headers()['x-telegram-app-session'], proof);
              assert.ok(accepted.has(hash));
              const body = req.postDataJSON();
              assert.equal(body.user_id, undefined); assert.equal(body.telegram_id, undefined);
              if (body.mensagem === 'Fora da base') return reply({ code: 'fora_da_base', message: 'Não encontrei isso na base do atlas.' });
              if (body.mensagem === 'Cota encerrada') return reply({ code: 'sem_creditos', message: 'Seus créditos acabaram.' });
              if (body.mensagem === 'Falha simulada') return reply({ code: 'rede', message: 'Serviço indisponível. Tente novamente.' });
              await new Promise(resolve => { releaseChat = resolve; });
              return reply({ final: { blocos: [{ tipo: 'documentado', texto: 'Mauá aparece no recorte documental. <script> não é executado.' }], fontes: ['S1'], fontes_detalhe: { S1: { titulo: 'Relatório de Mauá', localizador: 'p. 12' } }, avisos: [], gratis_restantes: 19, saldo_pago: 0 } });
            }
            external.push('rota externa inesperada'); return route.abort();
          }
          if (url.origin !== origin) { external.push('host inesperado'); return route.abort(); }
          return route.continue();
        });
        await context.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', event => window.__csp.push(event.effectiveDirective)); });
        const page = await context.newPage();
        page.on('console', message => { if (message.type() === 'error') errors.push('console.error'); });
        page.on('pageerror', () => errors.push('pageerror'));
        const capture = async state => {
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => { scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
          assert.deepEqual(await page.evaluate(() => window.__csp), [], state + ': CSP');
          assert.deepEqual(errors, [], state + ': console'); assert.deepEqual(external, [], state + ': rede externa');
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sem overflow horizontal');
          await page.screenshot({ path: path.join(prints, `telegram-${name}-${state}.png`), fullPage: false });
        };
        await page.goto(origin + '/app.html');
        await page.getByText('Abra este mini app pelo @aion_codigosdopoder_bot no Telegram.').waitFor();
        assert.equal(apiCalls.length, 0); await capture('fora-telegram');
        currentInit = initData();
        await page.reload(); await page.getByText('Sua conta do Telegram ainda não está vinculada.').waitFor();
        assert.equal(await page.locator('#account-link').isHidden(), false); await capture('nao-vinculado');
        linked = true; currentInit = initData();
        await page.reload(); await page.locator('#question').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#account-link').isHidden(), true); await capture('vinculado');
        await page.locator('#question').fill('O que a base documenta sobre Mauá?'); await page.locator('#send').click();
        await page.getByText('Consultando a base…').waitFor();
        await page.locator('#pending').waitFor({ state: 'visible' }); await capture('carregando');
        await page.waitForFunction(() => document.querySelector('#question-form').getAttribute('aria-busy') === 'true');
        while (!releaseChat) await new Promise(resolve => setImmediate(resolve));
        releaseChat(); await page.getByText('Resposta concluída.').waitFor();
        await page.locator('#pending').waitFor({ state: 'hidden' });
        assert.match(await page.locator('#history').textContent(), /<script> não é executado/);
        await page.getByText('Cota grátis restante: 19. Saldo pago: 0.').waitFor(); await capture('resposta');
        for (const [message, text, state] of [['Fora da base', 'Não encontrei isso na base do atlas.', 'fora-da-base'], ['Cota encerrada', 'Seus créditos acabaram.', 'cota'], ['Falha simulada', 'Serviço indisponível. Tente novamente.', 'erro']]) {
          await page.locator('#question').fill(message); await page.locator('#send').click(); await page.locator('#status').getByText(text, { exact: true }).waitFor(); await capture(state);
        }
        await page.goto(origin + '/vincular.html'); await page.locator('#login-form').waitFor(); await capture('login');
        await page.locator('#email').fill('teste@example.invalid'); await page.locator('#password').fill('senha-sintetica-local'); await page.locator('#login').click();
        await page.locator('#generate').waitFor({ state: 'visible' }); await capture('login-concluido');
        assert.equal(await page.locator('#password').inputValue(), '');
        await page.locator('#generate').click(); await page.locator('#code').getByText('ABCDE-FGHJK-MNPQR-STUVW').waitFor(); await capture('codigo');
        assert.ok(!await page.evaluate(() => JSON.stringify(localStorage).includes('ABCDE-FGHJK-MNPQR-STUVW')));
        await page.locator('#logout').click(); await page.locator('#login-form').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#code').textContent(), ''); await capture('logout');
        // Durante a emissão o logout permanece desabilitado. Só depois da resposta dá para sair, e a revogação apaga o código.
        await page.locator('#email').fill('teste@example.invalid'); await page.locator('#password').fill('senha-sintetica-local'); await page.locator('#login').click();
        await page.locator('#generate').waitFor({ state: 'visible' }); holdCode = true;
        await page.locator('#generate').click();
        while (!releaseCode) await new Promise(resolve => setImmediate(resolve));
        assert.equal(await page.locator('#logout').isDisabled(), true);
        const issued = page.waitForResponse(response => response.url().endsWith('/telegram-link') && response.request().postDataJSON().revogar !== true);
        releaseCode();
        await (await issued).finished();
        await page.locator('#code').getByText('ABCDE-FGHJK-MNPQR-STUVW').waitFor();
        await page.locator('#logout').click(); await page.locator('#login-form').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#code').textContent(), '');
        assert.ok(await page.locator('#code-panel').isHidden()); await capture('codigo-antigo-descartado');
      } finally { await context.close(); }
    }
  } finally { if (browser) await browser.close(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});
