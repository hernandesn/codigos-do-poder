'use strict';
// CSP de cancelar.html. Sem navegador e sem rede: só o arquivo e os hashes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'cancelar.html'), 'utf8');
const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
const TURNSTILE = "style-src-attr 'unsafe-hashes' 'sha256-HcrxrymsUfZBh2iqACpi+YzaRtmhmGlNKYCmyB23K2o='";

function hashes(tag) {
  return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((achado) => {
    return "'sha256-" + crypto.createHash('sha256').update(achado[1]).digest('base64') + "'";
  });
}

test('cancelar.html trava script e estilo no hash e só fala com o projeto', () => {
  assert.equal(policy.includes("'unsafe-inline'"), false);
  assert.equal(policy.includes("'unsafe-eval'"), false);
  assert.match(html, /connect-src 'self' https:\/\/ozeiyqpbtggvuyhplisa\.supabase\.co/);
  assert.equal(policy.includes('github.io'), false);
  assert.equal(policy.includes('localhost'), false);
  assert.equal(policy.includes('https://challenges.cloudflare.com '), true);
  assert.equal(policy.includes(TURNSTILE), true);
  assert.equal(policy.includes("frame-src https://challenges.cloudflare.com"), true);
  for (const tag of ['style', 'script']) {
    const lista = hashes(tag);
    assert.equal(lista.length, 1);
    assert.equal(policy.includes(lista[0]), true);
  }
  assert.equal(/\son(?:click|submit|load|error)=/.test(html), false);
  assert.equal(/\sstyle=/.test(html), false);
  assert.equal(html.includes('window.confirm'), false);
  assert.equal(html.includes('codigos-do-poder:auth:v1'), true);
  assert.equal(html.includes('localStorage'), true);
  assert.equal(html.includes('/functions/v1/asaas-cancel'), true);
  assert.equal(html.includes('grant_type=password'), true);
  assert.equal(html.includes('gotrue_meta_security'), true);
  assert.equal(html.includes('service_role'), true);
  assert.equal(html.includes('id="confirma"'), true);
  assert.equal(html.includes('não confirma o pagamento'), true);
  assert.equal(html.includes('não trata de devolução'), true);
  assert.equal(html.includes('Tentar de novo'), true);
  assert.equal(html.includes('pode_tentar_de_novo'), true);
  assert.equal(html.includes('sb_publishable_'), false);
  assert.equal(html.includes('0x4AAAAAAGDto'), false);
});
