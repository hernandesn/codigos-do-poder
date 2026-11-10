// BUILD4/SPLIT1: o index aponta para o núcleo (data-src) e, no split, para a extensão (data-ext-src).
const fs = require('node:fs');
const path = require('node:path');

const DATA_TAG = /<script id="research-data"([^>]*)>([\s\S]*?)<\/script>/;

function attrFrom(attrs, name) {
  return attrs.match(new RegExp('\\bdata-' + name + '="([^"]*)"'))?.[1] || null;
}

function dataRef(html) {
  const match = html.match(DATA_TAG);
  if (!match) throw new Error('research-data ausente no index');
  return {
    attrs: match[1],
    embedded: match[2],
    src: attrFrom(match[1], 'src'),
    sha256: attrFrom(match[1], 'sha256'),
    extSrc: attrFrom(match[1], 'ext-src'),
    extSha256: attrFrom(match[1], 'ext-sha256'),
    unionSha256: attrFrom(match[1], 'union-sha256'),
    counts: {
      nucleo: {
        nos: attrFrom(match[1], 'nucleo-nos'),
        conexoes: attrFrom(match[1], 'nucleo-conexoes'),
        fontes: attrFrom(match[1], 'nucleo-fontes'),
        casos: attrFrom(match[1], 'nucleo-casos'),
      },
      extensao: {
        nos: attrFrom(match[1], 'ext-nos'),
        conexoes: attrFrom(match[1], 'ext-conexoes'),
        fontes: attrFrom(match[1], 'ext-fontes'),
        casos: attrFrom(match[1], 'ext-casos'),
      },
    },
  };
}

function mergeParts(nucleo, extensao) {
  const out = JSON.parse(JSON.stringify(nucleo));
  if (!extensao || typeof extensao !== 'object') return out;
  if (extensao.versao != null && out.versao != null && String(extensao.versao) !== String(out.versao)) {
    throw new Error('versão da extensão diverge do núcleo');
  }
  for (const key of ['nos', 'conexoes', 'fontes', 'casos']) {
    if (!extensao[key]) continue;
    const by = new Map((out[key] || []).map((item) => [item.id, item]));
    for (const rec of extensao[key]) {
      if (!rec || !by.has(rec.id)) throw new Error('extensão com id ausente do núcleo');
      Object.assign(by.get(rec.id), rec);
    }
    if (out[key]) out[key] = out[key].map((item) => by.get(item.id));
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

// Texto JSON da base que o mural recebe: embutido, arquivo único, ou união núcleo+extensão.
function seedText(html, root) {
  const ref = dataRef(html);
  if (ref.embedded.trim() || !ref.src) return ref.embedded;
  const nucleoPath = path.join(root, ref.src.split('?')[0]);
  const nucleo = JSON.parse(fs.readFileSync(nucleoPath, 'utf8'));
  if (!ref.extSrc) return fs.readFileSync(nucleoPath, 'utf8');
  const extensao = JSON.parse(fs.readFileSync(path.join(root, ref.extSrc.split('?')[0]), 'utf8'));
  return stableStringify(mergeParts(nucleo, extensao));
}

module.exports = { DATA_TAG, dataRef, mergeParts, stableStringify, seedText };
