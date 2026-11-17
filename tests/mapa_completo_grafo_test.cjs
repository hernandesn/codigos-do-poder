'use strict';
// Mapa completo: grau, raio, polos, traço por confiança e contagem desenhada.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const grafo = require('../mapa-completo/grafo.js');

const root = path.resolve(__dirname, '..');

test('raio cresce com a raiz do grau e com o zoom', () => {
  assert.equal(grafo.raioDoGrau(0), 1.1);
  const ipes = 1.1 + 1.25 * Math.sqrt(166);
  assert.ok(Math.abs(grafo.raioDoGrau(166) - ipes) < 1e-12);
  assert.ok(grafo.raioDoGrau(523) > grafo.raioDoGrau(166));
  const perto = grafo.raioNaTela(166, true, 2400, 1);
  const longe = grafo.raioNaTela(166, true, 2400, 2);
  assert.ok(Math.abs(longe - perto * 2) < 1e-9);
  assert.ok(grafo.raioNaTela(52, true, 1200, 1) < grafo.raioNaTela(52, false, 1200, 1));
});

test('polos do núcleo em vermelho e KochPAC em osso', () => {
  for (const id of ['ipes', 'rf', 'papacy']) {
    assert.equal(grafo.ehPolo(id), true);
    assert.equal(grafo.estiloNo(id).fill, '#7a0a0a');
    assert.equal(grafo.estiloNo(id).stroke, '#f2e7d2');
  }
  assert.equal(grafo.ehPolo('kochpac'), false);
  assert.equal(grafo.estiloNo('kochpac').fill, '#e2d6bc');
  assert.equal(grafo.estiloNo('kochpac').stroke, '#0a0706');
  assert.equal(grafo.estiloNo('ford_foundation').fill, '#e2d6bc');
});

test('traço da ligação segue a confiança; polo usa sangue', () => {
  const alta = grafo.estiloLinha('alta', false);
  const media = grafo.estiloLinha('média', false);
  const baixa = grafo.estiloLinha('baixa', false);
  const solta = grafo.estiloLinha('não verificada', false);
  assert.equal(alta.cor, '#d8cbb0');
  assert.equal(alta.opacidade, 0.3);
  assert.deepEqual(alta.traco, []);
  assert.equal(media.cor, '#c49660');
  assert.equal(media.opacidade, 0.55);
  assert.deepEqual(media.traco, [4, 3]);
  assert.equal(baixa.cor, '#b5afc4');
  assert.equal(baixa.opacidade, 0.75);
  assert.deepEqual(baixa.traco, [1, 2.5]);
  assert.deepEqual(solta.traco, [1, 2.5]);
  const poloAlta = grafo.estiloLinha('alta', true);
  const poloMedia = grafo.estiloLinha('media', true);
  assert.equal(poloAlta.cor, '#c43a30');
  assert.equal(poloAlta.opacidade, 0.45);
  assert.deepEqual(poloAlta.traco, []);
  assert.equal(poloMedia.cor, '#c43a30');
  assert.equal(poloMedia.opacidade, 0.7);
  assert.deepEqual(poloMedia.traco, [4, 3]);
});

test('cena de exemplo conta grau, polo e o que seria desenhado', () => {
  const nos = [
    { id: 'ipes', nome: 'IPES · Instituto de Pesquisas e Estudos Sociais' },
    { id: 'rf', nome: 'Rockefeller Foundation' },
    { id: 'papacy', nome: 'Papado / Santa Sé' },
    { id: 'kochpac', nome: 'KochPAC · C00236489' },
    { id: 'a', nome: 'A' },
  ];
  const ligacoes = [
    { id: 'e1', origem: 'ipes', destino: 'a', confianca: 'alta' },
    { id: 'e2', origem: 'kochpac', destino: 'a', confianca: 'media' },
    { id: 'e3', origem: 'a', destino: 'rf', confianca: 'baixa' },
    { id: 'e4', origem: 'papacy', destino: 'a', confianca: 'média' },
    { id: 'fora', origem: 'a', destino: 'ninguem', confianca: 'alta' },
  ];
  const cena = grafo.prepararCena(nos, ligacoes, {
    ipes: [0, 0], rf: [1, 0], papacy: [0, 1], kochpac: [2, 0], a: [0.2, 0.2],
  });
  assert.deepEqual(grafo.contagemDesenhada(cena), { nos: 5, ligacoes: 4 });
  assert.equal(grafo.grauDe('a', cena.ligacoes), 4);
  assert.equal(cena.nos.find(n => n.id === 'a').grau, 4);
  assert.equal(cena.nos.find(n => n.id === 'ipes').grau, 1);
  assert.equal(cena.ligacoes.find(e => e.id === 'e1').estilo.cor, '#c43a30');
  assert.equal(cena.ligacoes.find(e => e.id === 'e2').estilo.cor, '#c49660');
  assert.deepEqual(cena.ligacoes.find(e => e.id === 'e2').estilo.traco, [4, 3]);
  assert.equal(cena.ligacoes.find(e => e.id === 'e2').polo, false);
  assert.equal(cena.nos.find(n => n.id === 'kochpac').estilo.fill, '#e2d6bc');
  assert.equal(cena.nos.find(n => n.id === 'ipes').estilo.fill, '#7a0a0a');
  assert.equal(grafo.nomeCurto('Ford Foundation (Fundação Ford)'), 'Ford Foundation');
});

test('a base carregada cabe inteira na cena, com posições finitas', () => {
  const dados = JSON.parse(fs.readFileSync(path.join(root, 'dados-nucleo.json'), 'utf8'));
  const pos = JSON.parse(fs.readFileSync(path.join(root, 'mapa-completo/posicoes.json'), 'utf8'));
  const cena = grafo.prepararCena(dados.nos, dados.conexoes, pos);
  const contagem = grafo.contagemDesenhada(cena);
  assert.equal(contagem.nos, dados.nos.length);
  assert.equal(contagem.ligacoes, dados.conexoes.length);
  assert.equal(contagem.nos, 1644);
  assert.equal(contagem.ligacoes, 2417);
  const conf = grafo.contagemConfianca(cena);
  assert.equal(conf.alta, 2080);
  assert.equal(conf.media, 320);
  assert.equal(conf.baixa, 17);
  assert.equal(cena.nos.find(n => n.id === 'ipes').grau, 166);
  assert.equal(cena.nos.find(n => n.id === 'rf').grau, 52);
  assert.equal(cena.nos.find(n => n.id === 'papacy').grau, 88);
  assert.equal(cena.nos.find(n => n.id === 'kochpac').grau, 523);
  assert.equal(cena.nos.find(n => n.id === 'kochpac').estilo.fill, '#e2d6bc');
  for (const id of ['ipes', 'rf', 'papacy']) assert.equal(cena.nos.find(n => n.id === id).estilo.fill, '#7a0a0a');
  for (const n of cena.nos) {
    assert.equal(Object.hasOwn(pos.pos, n.id), true, n.id);
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id);
  }
  const koch = pos.pos.kochpac;
  assert.ok(koch[0] > 1.2, 'KochPAC fica à direita do núcleo');
});
