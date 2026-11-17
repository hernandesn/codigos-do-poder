'use strict';
const path = require('node:path');

function caminhoPublico(pathname) {
  let p = pathname || '/';
  if (p === '/') return '/index.html';
  if (p === '/mapa' || p === '/mapa/') return '/mapa/index.html';
  if (p.endsWith('/')) return p + 'index.html';
  return p;
}

function arquivoDoSite(root, pathname) {
  const rel = caminhoPublico(pathname).replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

module.exports = { caminhoPublico, arquivoDoSite };
