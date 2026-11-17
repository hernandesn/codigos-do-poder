'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const FAVICON_FILES = [
  'favicon.ico',
  'favicon.svg',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'site.webmanifest',
];

const PAGES = ['index.html', '404.html', 'inicio/index.html'];

const LINKS = [
  ['icon', '/favicon.ico'],
  ['icon', '/favicon.svg'],
  ['icon', '/favicon-32.png'],
  ['icon', '/favicon-16.png'],
  ['apple-touch-icon', '/apple-touch-icon.png'],
  ['manifest', '/site.webmanifest'],
];

test('landing /inicio sem style ou script inline e com rotas reais', () => {
  const html = read('inicio/index.html');
  const css = read('inicio/landing.css');
  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi), ['<script src="cobranca.js" defer></script>']);
  assert.equal(/<style\b/i.test(html), false);
  assert.equal(/\sstyle\s*=/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/<form\b/i.test(html), false);
  assert.equal(/https?:\/\//i.test(html), false);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(html, /property="og:image" content="\/inicio\/img\/mapa-brasil-desk\.png"/);
  assert.match(html, /href="\/#all"/);
  assert.match(html, /href="\/#mapa-mundi"/);
  assert.match(html, /href="#planos"/);
  assert.match(html, />Entrar</);
  assert.match(html, />Explorar o mural por 7 dias grátis</);
  assert.match(html, />Começar 7 dias grátis no Básico</);
  assert.match(html, />Começar 7 dias grátis no Plus</);
  assert.match(html, />Cadastre-se · 7 dias grátis</);
  assert.match(html, /\[placeholder:/);
  for (const font of ['eb-garamond-400.woff2', 'eb-garamond-400i.woff2', 'eb-garamond-600.woff2', 'courier-prime-400.woff2']) {
    assert.match(css, new RegExp(`url\\("\\.\\./fonts/${font}"\\)`));
    assert.ok(fs.statSync(path.join(root, 'fonts', font)).size > 0, font);
  }
  assert.equal(/url\("fonts\//.test(css), false);
  assert.equal(fs.existsSync(path.join(root, 'inicio/fonts')), false);
});

test('planos só Básico e Plus, cobrança no 8º dia e cobranca.js externo', () => {
  const html = read('inicio/index.html');
  const js = read('inicio/cobranca.js');
  assert.equal(html.includes('799'), false);
  assert.equal(/\bPro\b/.test(html), false);
  assert.match(html, /preço visível e plano âncora destacado \(Plus\); anual fora por decisão do Hernandes em 17\/11/);
  const semPremissa = html.replace(/anual fora por decisão do Hernandes em 17\/11/g, '');
  assert.equal(/anual/i.test(semPremissa), false);
  assert.equal(html.includes('66,58'), false);
  assert.equal(html.includes('79,90'), false);
  assert.doesNotMatch(html, /regra do teste de 7 dias|fluxo de cancelamento|\[regra a confirmar\]|\[checkout na semana 2\]/);

  const hero = '7 dias grátis. Pedimos o cartão no cadastro; a primeira cobrança (R$&nbsp;9,90 no Básico ou R$&nbsp;29,90 no Plus) acontece <span class="data-cobranca">no 8º dia</span>, se você não cancelar. Cancele quando quiser, em [caminho do cancelamento].';
  const basico = 'Grátis por 7 dias · depois R$&nbsp;9,90/mês · primeira cobrança <span class="data-cobranca">no 8º dia</span> · cancele antes e não paga nada';
  const plus = 'Grátis por 7 dias · depois R$&nbsp;29,90/mês · primeira cobrança <span class="data-cobranca">no 8º dia</span> · cancele antes e não paga nada';
  const cadastro = 'Primeiro, e-mail e senha. Na etapa seguinte pedimos o cartão: os 7 primeiros dias são grátis e a primeira cobrança acontece <span class="data-cobranca">no 8º dia</span>, se você não cancelar antes.';
  const faqCartao = 'Sim. O cartão é pedido no cadastro, depois do e-mail e da senha. Os 7 primeiros dias são grátis; a primeira cobrança (R$&nbsp;9,90 no Básico ou R$&nbsp;29,90 no Plus) acontece <span class="data-cobranca">no 8º dia</span>, se você não cancelar. Para não pagar nada, cancele antes, em [caminho do cancelamento].';
  const faqCancela = 'Em [caminho do cancelamento], quando quiser. Se cancelar durante os 7 dias grátis, não há cobrança.';
  assert.equal(html.includes(hero), true);
  assert.equal(html.includes(basico), true);
  assert.equal(html.includes(plus), true);
  assert.equal(html.includes(cadastro), true);
  assert.match(html, /<summary>Preciso de cartão para testar\?<\/summary><p>Sim\./);
  assert.equal(html.includes(faqCartao), true);
  assert.match(html, /<summary>Como cancelo\?<\/summary>/);
  assert.equal(html.includes(faqCancela), true);

  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi), ['<script src="cobranca.js" defer></script>']);
  assert.equal(/<form\b/i.test(html), false);
  assert.match(js, /querySelectorAll\('\.data-cobranca'\)/);
  assert.match(js, /no 8º dia/);
  assert.equal(fs.existsSync(path.join(root, 'inicio/cobranca.js')), true);
});

test('favicon linkado nas páginas HTML, arquivos existem e o manifest é válido', () => {
  for (const name of FAVICON_FILES) {
    const file = path.join(root, name);
    assert.equal(fs.existsSync(file), true, name);
    assert.ok(fs.statSync(file).size > 0, name);
  }
  const ico = fs.readFileSync(path.join(root, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  for (const name of FAVICON_FILES.filter(n => n.endsWith('.png'))) {
    const png = fs.readFileSync(path.join(root, name));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name);
  }
  const manifest = JSON.parse(read('site.webmanifest'));
  assert.equal(manifest.name, 'Códigos do Poder');
  assert.equal(manifest.theme_color, '#0a0706');
  assert.equal(manifest.background_color, '#0a0706');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.equal(icon.src.startsWith('/'), true, icon.src);
    assert.equal(fs.existsSync(path.join(root, icon.src.slice(1))), true, icon.src);
  }
  for (const page of PAGES) {
    const html = read(page);
    assert.equal(html.includes('href="data:,"'), false, page);
    assert.match(html, /<meta name="theme-color" content="#0a0706">/, page);
    for (const [rel, href] of LINKS) {
      const needle = `rel="${rel}" href="${href}"`;
      assert.equal(html.includes(needle), true, `${page} ${needle}`);
    }
  }
});
