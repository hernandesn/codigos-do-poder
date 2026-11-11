'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const chat = path.resolve(__dirname, '../../../chat/supabase/functions/chat/fixtures');
test('P1–P4/P7: ids e afirmações dos contextos conferem com os dados desta base', { skip: !fs.existsSync(chat) }, () => {
  const maps = { nos:new Map(), conexoes:new Map(), fontes:new Map() };
  for (const name of ['dados-nucleo.json','dados-extensao.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', name)));
    for (const key of Object.keys(maps)) for (const row of data[key]) maps[key].set(row.id, { ...maps[key].get(row.id), ...row });
  }
  const contexts = JSON.parse(fs.readFileSync(path.join(chat, 'pauta_contextos.json')));
  const rock = JSON.parse(fs.readFileSync(path.join(chat, 'ctx_rockefeller_golpe64.json')));
  // Conferir os ids usados na pauta (P1 seleciona um subconjunto; P2–P4 vêm das fixtures).
  const p1 = ['PR3-E016','E044','E006','E009','PR7-E019','E150','E005'];
  contexts.rock = { ...rock, relacoes: rock.relacoes.filter(r => p1.includes(r.id)) };
  const onlyInFixture = [];
  for (const ctx of Object.values(contexts)) for (const relation of ctx.relacoes) {
    const actual = maps.conexoes.get(relation.id);
    if (!actual) { onlyInFixture.push(relation.id); continue; }
    assert.equal(relation.afirmacao, actual.afirmacao, relation.id);
    for (const id of relation.fontes) { assert(maps.fontes.has(id), id); assert(actual.fontes.includes(id), id); }
    assert(maps.nos.has(relation.origem) && maps.nos.has(relation.destino), relation.id);
  }
  // PR3-E016 vive na fixture da RPC e pode não estar no recorte público dados-*.json.
  for (const id of onlyInFixture) {
    const row = rock.relacoes.find(r => r.id === id);
    assert(row && row.afirmacao && row.fontes?.length, 'id só na fixture precisa de afirmação e fonte: ' + id);
  }
});
