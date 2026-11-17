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
  assert.equal(/<script\b/i.test(html), false);
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
  assert.match(html, />Começar 7 dias grátis</);
  assert.match(html, />Cadastre-se · 7 dias grátis</);
  assert.match(html, /\[placeholder:/);
  for (const font of ['eb-garamond-400.woff2', 'eb-garamond-400i.woff2', 'eb-garamond-600.woff2', 'courier-prime-400.woff2']) {
    assert.match(css, new RegExp(`url\\("\\.\\./fonts/${font}"\\)`));
    assert.ok(fs.statSync(path.join(root, 'fonts', font)).size > 0, font);
  }
  assert.equal(/url\("fonts\//.test(css), false);
  assert.equal(fs.existsSync(path.join(root, 'inicio/fonts')), false);
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
