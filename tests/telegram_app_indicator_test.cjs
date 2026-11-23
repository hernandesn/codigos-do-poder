'use strict';
// Cobre o indicador do mini app sem browser. O teste Playwright continua opcional.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/telegram/telegram-app.js'), 'utf8');
const start = source.indexOf('const PT_WORDS');
const end = source.indexOf('/* fim idioma */');
const api = new Function(source.slice(start, end) + '\nreturn { noticeLanguage, searchingLabel };')();

test('idioma do aviso: texto claro ganha do language_code; senão o código; senão pt', () => {
  assert.equal(api.searchingLabel('O que a base não documenta?', 'en'), 'Pesquisando…');
  assert.equal(api.searchingLabel('What does the base document about Mauá?', 'pt'), 'Searching…');
  assert.equal(api.searchingLabel('¿Qué documenta la base?', 'pt'), 'Investigando…');
  assert.equal(api.searchingLabel('Mauá', 'en-US'), 'Searching…');
  assert.equal(api.searchingLabel('Mauá', 'es'), 'Investigando…');
  assert.equal(api.searchingLabel('Mauá', 'pt-BR'), 'Pesquisando…');
  assert.equal(api.searchingLabel('Mauá', ''), 'Pesquisando…');
  assert.equal(api.noticeLanguage('Você viu isso?', 'en'), 'pt');
});

test('o mini app mostra o indicador, limpa no fim e não trata vínculo feito como pendente', () => {
  const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
  assert.match(html, /id="pending"/);
  assert.match(html, /id="account-link"/);
  assert.match(source, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(source, /clearTimeout\(pendingTimer\)/);
  assert.match(source, /\$\('account-link'\)\.hidden = true/);
  assert.match(source, /showPending\(message\)/);
  assert.match(source, /clearPending\(\)/);
  assert.doesNotMatch(source, /initDataUnsafe/);
  assert.doesNotMatch(source, /CloudStorage/);
  assert.match(source, /language_code/);
  assert.match(html, /Pesquisando…/);
  assert.match(html, /Searching…/);
  assert.match(html, /Investigando…/);
});
