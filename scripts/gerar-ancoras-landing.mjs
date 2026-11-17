// Gera a lista de âncoras da landing em inicio/redirecionar-app.js.
// Os ids vêm de index.html (atributo id), fora de comentários e de <script>.
// O redirect roda no <head>, antes do body: a lista tem de existir nesse momento.
//
//   node scripts/gerar-ancoras-landing.mjs          reescreve o bloco
//   node scripts/gerar-ancoras-landing.mjs --check  sai 1 se o bloco divergir
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'index.html');
const scriptPath = path.join(root, 'inicio', 'redirecionar-app.js');
const MARCA_INICIO = '// ANCORAS-LANDING:inicio';
const MARCA_FIM = '// ANCORAS-LANDING:fim';

export function idsDoHtml(html) {
  const limpo = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const ids = [];
  const re = /\bid\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(limpo))) {
    if (!match[1]) throw new Error('id vazio em index.html');
    ids.push(match[1]);
  }
  const vistos = new Set();
  for (const id of ids) {
    if (vistos.has(id)) throw new Error('id duplicado em index.html: ' + id);
    vistos.add(id);
  }
  return ids;
}

export function idsNoScript(js) {
  const inicio = js.indexOf(MARCA_INICIO);
  const fim = js.indexOf(MARCA_FIM);
  if (inicio < 0 || fim < inicio) throw new Error('bloco ANCORAS-LANDING ausente');
  const bloco = js.slice(inicio + MARCA_INICIO.length, fim);
  const match = bloco.match(/\n\s*var ancoras = (\[[\s\S]*?\]);\s*$/);
  if (!match) throw new Error('var ancoras ausente no bloco ANCORAS-LANDING');
  const ids = JSON.parse(match[1]);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
    throw new Error('var ancoras não é uma lista de strings');
  }
  return ids;
}

export function aplicar(js, ids) {
  const inicio = js.indexOf(MARCA_INICIO);
  const fim = js.indexOf(MARCA_FIM);
  if (inicio < 0 || fim < inicio) throw new Error('bloco ANCORAS-LANDING ausente');
  const bloco = `${MARCA_INICIO}\n  var ancoras = ${JSON.stringify(ids)};\n  ${MARCA_FIM}`;
  return js.slice(0, inicio) + bloco + js.slice(fim + MARCA_FIM.length);
}

function main() {
  const html = fs.readFileSync(indexPath, 'utf8');
  const js = fs.readFileSync(scriptPath, 'utf8');
  const ids = idsDoHtml(html);
  const check = process.argv.includes('--check');
  if (check) {
    const atuais = idsNoScript(js);
    if (JSON.stringify(atuais) !== JSON.stringify(ids)) {
      console.error('lista divergente dos ids de index.html');
      console.error('script: ' + JSON.stringify(atuais));
      console.error('html:   ' + JSON.stringify(ids));
      process.exit(1);
    }
    console.log('âncoras em dia: ' + ids.length);
    return;
  }
  const next = aplicar(js, ids);
  if (next !== js) fs.writeFileSync(scriptPath, next);
  console.log((next === js ? 'âncoras em dia: ' : 'âncoras reescritas: ') + ids.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
