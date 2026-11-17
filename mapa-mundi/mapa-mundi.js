/* Mapa-múndi. Porte do protótipo: zoom no SVG, arcos do país selecionado, painel. */
(function () {
  'use strict';
  var d3 = window.d3mapa;
  if (!d3) return;

  var W, D, P, byNum, porId, tela, svgEl, svg, g, gPais, gHist, gArc, gPin, gFora, conteudo, legPainel, xpFeat;
  var proj, path, anchor, ancoraGeo, sel, T, zm, moved, downAt, desenhado, ultW, ultH, geo, cameras;

  var PINOS = { VA: [12.45, 41.9], MT: [14.4, 35.9], LU: [6.13, 49.8] };
  var ID_ISO = { '840': 'US', '250': 'FR', '826': 'GB', '578': 'NO', '643': 'RU' };
  var ROT = { s: 'documentado', t: 'inferência', p: 'hipótese / rascunho' };

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  function pl(n, a, b) { return n === 1 ? a : b; }
  function rotulo(t) {
    var s = String(t || '');
    if (!s) return '';
    var mapa = window.ROTULOS_PT;
    if (mapa && Object.prototype.hasOwnProperty.call(mapa, s)) return mapa[s];
    return s.replace(/_/g, ' ');
  }
  function cor(n) {
    if (!n) return '#1c1612';
    if (n < 3) return '#4d3d2f';
    if (n < 10) return '#6e5540';
    if (n < 30) return '#94735a';
    if (n < 100) return '#a2513f';
    return '#8e1a12';
  }
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.append(arguments[i]);
    return e;
  }
  function svgElns(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function traco() {
    return svgElns('svg', { width: '30', height: '8', 'aria-hidden': 'true' });
  }
  function linhaLegenda(classe, texto, tracoAttrs) {
    var s = traco();
    s.append(svgElns('line', tracoAttrs));
    return el('li', null, s, document.createTextNode(texto));
  }
  function legenda() {
    var esc = el('div', { class: 'esc' },
      el('span', { class: 'c0' }), el('span', { class: 'c1' }), el('span', { class: 'c2' }),
      el('span', { class: 'c3' }), el('span', { class: 'c4' }));
    var lista = el('ul', null,
      linhaLegenda('s', 'documentado (sólido)', { x1: '1', y1: '4', x2: '29', y2: '4', stroke: '#d47a6e', 'stroke-width': '2.5' }),
      linhaLegenda('t', 'inferência (tracejado)', { x1: '1', y1: '4', x2: '29', y2: '4', stroke: '#d47a6e', 'stroke-width': '2.5', 'stroke-dasharray': '7 5' }),
      linhaLegenda('p', 'hipótese / rascunho (pontilhado)', { x1: '1', y1: '4', x2: '29', y2: '4', stroke: '#ab9b82', 'stroke-width': '2.5', 'stroke-dasharray': '1.5 5', 'stroke-linecap': 'round' })
    );
    return el('div', { class: 'legenda', 'aria-label': 'Legenda' },
      el('div', { text: 'Fichas por país' }),
      esc,
      el('div', { class: 'esct' }, el('span', { text: '1' }), el('span', { text: '3' }), el('span', { text: '10' }), el('span', { text: '30' }), el('span', { text: '100+' })),
      lista
    );
  }

  function montarTela() {
    tela = el('section', { id: 'mapa-mundi-tela', 'aria-label': 'Mapa-múndi', hidden: '' });
    var palco = el('div', { id: 'mm-palco' });
    svgEl = svgElns('svg', {
      id: 'mapa',
      role: 'img',
      'aria-label': 'Mapa-múndi dos países com fichas. Alternativa acessível: lista de países no painel.'
    });
    var defs = svgElns('defs');
    var tintaPena = svgElns('linearGradient', { id: 'mm-tinta-pena', gradientUnits: 'userSpaceOnUse', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
    tintaPena.append(
      svgElns('stop', { offset: '0%', class: 'pena-borda' }),
      svgElns('stop', { offset: '38%' }),
      svgElns('stop', { offset: '58%', class: 'pena-centro' }),
      svgElns('stop', { offset: '100%', class: 'pena-borda' })
    );
    var pontaPena = svgElns('marker', { id: 'mm-ponta-pena', viewBox: '0 0 6 6', refX: '3', refY: '3', markerWidth: '3', markerHeight: '3', markerUnits: 'strokeWidth', orient: 'auto' });
    pontaPena.append(svgElns('path', { d: 'M3 0.5 5.5 3 3 5.5 0.5 3Z' }));
    var pontaHipotese = svgElns('marker', { id: 'mm-ponta-hipotese', viewBox: '0 0 6 6', refX: '3', refY: '3', markerWidth: '3', markerHeight: '3', markerUnits: 'strokeWidth' });
    pontaHipotese.append(svgElns('circle', { cx: '3', cy: '3', r: '2' }));
    defs.append(tintaPena, pontaPena, pontaHipotese);
    svgEl.append(defs);
    var cena = svgElns('g', { id: 'mm-cena' });
    cena.append(svgElns('g', { id: 'paises' }));
    cena.append(svgElns('g', { id: 'hist' }));
    cena.append(svgElns('g', { id: 'arcos' }));
    cena.append(svgElns('g', { id: 'pinos' }));
    svgEl.append(cena);
    svgEl.append(svgElns('g', { id: 'mm-fora' }));
    palco.append(svgEl);
    palco.append(el('p', { id: 'nota', text: 'Mostrando só as fichas com país identificado.' }));
    palco.append(el('div', { class: 'zoom' },
      el('button', { id: 'zmais', type: 'button', 'aria-label': 'Aproximar', text: '+' }),
      el('button', { id: 'zmenos', type: 'button', 'aria-label': 'Afastar', text: '−' }),
      el('button', { id: 'zreset', type: 'button', 'aria-label': 'Ver o mundo inteiro', text: '⟲' })
    ));
    palco.append(legenda());
    var painel = el('aside', { class: 'mm-painel', 'aria-label': 'Painel do país' },
      el('button', { id: 'alca', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'mm-conteudo', text: 'Países e histórias' }),
      el('div', { id: 'mm-conteudo', tabindex: '-1' })
    );
    legPainel = legenda();
    legPainel.classList.add('leg-painel');
    tela.append(palco, painel);
    document.body.appendChild(tela);
    conteudo = $('mm-conteudo');
    svg = d3.select(svgEl);
    g = svg.select('#mm-cena');
    gPais = svg.select('#paises');
    gHist = svg.select('#hist');
    gArc = svg.select('#arcos');
    gPin = svg.select('#pinos');
    gFora = svg.select('#mm-fora');
  }

  function geometriaMaior(f) {
    var g0 = f && f.geometry;
    if (!g0) return null;
    if (g0.type !== 'MultiPolygon') return g0;
    var best = null, ba = -1, coords = g0.coordinates, i, p, a;
    for (i = 0; i < coords.length; i++) {
      p = { type: 'Polygon', coordinates: coords[i] };
      a = d3.geoArea(p);
      if (a > ba) { ba = a; best = p; }
    }
    return best || g0;
  }

  function faixaRetrato() {
    var nota = $('nota').getBoundingClientRect();
    var alca = $('alca').getBoundingClientRect();
    var svgR = svgEl.getBoundingClientRect();
    var top = Math.max(8, nota.bottom - svgR.top + 2);
    var bot = alca.top - svgR.top - 2;
    if (!(bot > top + 40)) bot = svgR.height - 64;
    return { top: top, aH: bot - top };
  }

  function layout() {
    var r = svgEl.getBoundingClientRect();
    var w = r.width, h = r.height;
    if (w < 2 || h < 2) return;
    ultW = w;
    ultH = h;
    var esfera = { type: 'Sphere' };
    var retrato = w < 760 && h > w;
    if (retrato) {
      var faixa = faixaRetrato();
      proj = d3.geoNaturalEarth1().fitSize([Math.max(w, faixa.aH * 1.93), faixa.aH], esfera);
      var cx = proj([-25, 0])[0];
      var t = proj.translate();
      proj.translate([t[0] + w / 2 - cx, t[1] + faixa.top]);
    } else {
      proj = d3.geoNaturalEarth1().fitExtent([[8, 8], [w - 8, h - 8]], esfera);
    }
    path = d3.geoPath(proj);
    svg.attr('viewBox', '0 0 ' + w + ' ' + h);
    porId = {};
    geo.forEach(function (f) { porId[f.id] = f; });
    anchor = {};
    ancoraGeo = {};
    gPais.selectAll('path').data(geo, function (f) { return f.id; }).join('path')
      .attr('d', path)
      .attr('fill', function (f) {
        var a = byNum[f.id];
        return cor(a ? P[a].fichas.length : 0);
      })
      .attr('class', function (f) { return byNum[f.id] ? 'pais tem' : 'pais'; })
      .attr('data-num', function (f) { return f.id; })
      .attr('data-iso', function (f) { return byNum[f.id] || null; })
      .on('click', function (ev, f) {
        var a = byNum[f.id];
        if (a && !moved) escolher(a);
      });
    geo.forEach(function (f) {
      var a = byNum[f.id] || ID_ISO[f.id];
      var maior = a && geometriaMaior(f);
      if (!maior) return;
      var c = d3.geoCentroid(maior);
      if (!isFinite(c[0]) || !isFinite(c[1])) c = d3.geoCentroid(f);
      ancoraGeo[a] = c;
      if (P[a]) anchor[a] = proj(c);
    });
    var xp = null;
    if (P.XP) {
      xp = {
        type: 'Feature',
        id: 'XP',
        properties: {},
        geometry: d3.merge(W, W.objects.countries.geometries.filter(function (gg) {
          return gg.id === '376' || gg.id === '275';
        }))
      };
    }
    xpFeat = xp;
    gHist.selectAll('path').data(xp ? [xp] : []).join('path')
      .attr('d', path)
      .attr('class', 'pais tem hist')
      .attr('data-iso', 'XP')
      .attr('fill', cor(P.XP ? P.XP.fichas.length : 0))
      .on('click', function () { if (!moved) escolher('XP'); });
    if (xp) {
      var cXp = d3.geoCentroid(xp);
      if (isFinite(cXp[0]) && isFinite(cXp[1])) {
        ancoraGeo.XP = cXp;
        anchor.XP = proj(cXp);
      } else anchor.XP = path.centroid(xp);
    }
    Object.keys(PINOS).forEach(function (a) {
      if (!P[a]) return;
      ancoraGeo[a] = PINOS[a];
      anchor[a] = proj(PINOS[a]);
    });
    var pins = Object.keys(P).filter(function (a) { return PINOS[a]; });
    var pg = gPin.selectAll('g').data(pins, function (a) { return a; }).join(function (enter) {
      var k = enter.append('g').attr('class', 'pino').attr('data-iso', function (a) { return a; })
        .on('click', function (ev, a) { if (!moved) escolher(a); });
      k.append('circle').attr('class', 'alvo').attr('r', 22);
      k.append('circle').attr('class', 'ponto').attr('r', 3.5);
      return k;
    });
    pg.attr('transform', function (a) { return 'translate(' + anchor[a] + ') scale(' + (1 / T.k) + ')'; });
    zm.extent([[0, 0], [w, h]]).translateExtent([[-w * 4, -h * 4], [w * 5, h * 5]]);
    g.attr('transform', T);
    svg.attr('data-k', T.k.toFixed(2));
    desenharArcos();
    marcar();
    desenharFora();
    desenhado = true;
  }

  function featureDe(a) {
    if (a === 'XP' && xpFeat) return xpFeat;
    var p = P[a];
    if (p && p.num != null && porId) {
      var f = porId[String(p.num).padStart(3, '0')];
      if (f) return f;
    }
    if (ancoraGeo && ancoraGeo[a]) {
      return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ancoraGeo[a] } };
    }
    return null;
  }

  function areaVisivel() {
    var svgR = svgEl.getBoundingClientRect();
    var x0 = 0, y0 = 0, x1 = svgR.width, y1 = svgR.height;
    var painelEl = document.querySelector('#mapa-mundi-tela .mm-painel');
    if (painelEl) {
      var p = painelEl.getBoundingClientRect();
      var left = p.left - svgR.left;
      var top = p.top - svgR.top;
      var right = p.right - svgR.left;
      var bottom = p.bottom - svgR.top;
      var cobreX = right - left > 20 && left < svgR.width - 20 && right > 20;
      var cobreY = bottom - top > 20 && top < svgR.height - 20 && bottom > 20;
      if (cobreX && cobreY) {
        if (top > svgR.height * 0.2) y1 = Math.min(y1, top);
        else if (left > svgR.width * 0.2) x1 = Math.min(x1, left);
      }
    }
    if (x1 - x0 < 80) { x0 = 0; x1 = svgR.width; }
    if (y1 - y0 < 80) { y0 = 0; y1 = svgR.height; }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function aplicar(k, tx, ty) {
    svg.call(zm.transform, new d3.zoomIdentity.constructor(k, tx, ty));
  }

  function modoCelular() {
    return window.innerWidth < 700;
  }

  function enquadrar(iso, opt) {
    opt = opt || {};
    if (!P[iso] || !path) return;
    if (modoCelular() && !opt.conjunto) enquadrarPais(iso);
    else enquadrarConjunto(iso);
    desenharFora();
  }

  function enquadrarConjunto(iso) {
    var ids = [iso].concat(Object.keys(P[iso].ligacoes || {}));
    var feats = [];
    ids.forEach(function (a) {
      var f = featureDe(a);
      if (f) feats.push(f);
    });
    if (!feats.length) return;
    var b = path.bounds({ type: 'FeatureCollection', features: feats });
    if (!isFinite(b[0][0]) || !isFinite(b[1][0]) || !isFinite(b[0][1]) || !isFinite(b[1][1])) return;
    var vis = areaVisivel();
    var pad = 24;
    var iw = Math.max(40, vis.w - pad * 2);
    var ih = Math.max(40, vis.h - pad * 2);
    var bw = Math.max(b[1][0] - b[0][0], 1);
    var bh = Math.max(b[1][1] - b[0][1], 1);
    var k = Math.min(4, iw / bw, ih / bh);
    if (!(k > 0)) return;
    var cx = (b[0][0] + b[1][0]) / 2;
    var cy = (b[0][1] + b[1][1]) / 2;
    var tx = vis.x + vis.w / 2 - cx * k;
    var ty = vis.y + vis.h / 2 - cy * k;
    var aj = ajustarPais(iso, k, tx, ty, vis);
    aplicar(aj.k, aj.tx, aj.ty);
  }

  function enquadrarPais(iso) {
    var f = featureDe(iso);
    if (!f) return;
    var b = path.bounds(f);
    if (!isFinite(b[0][0]) || !isFinite(b[1][0]) || !isFinite(b[0][1]) || !isFinite(b[1][1])) return;
    var vis = areaVisivel();
    var bw = Math.abs(b[1][0] - b[0][0]);
    var bh = Math.abs(b[1][1] - b[0][1]);
    var pontual = bw < 1 && bh < 1;
    var k;
    if (pontual) k = 6;
    else {
      bw = Math.max(bw, 1);
      bh = Math.max(bh, 1);
      var k35 = (0.35 * vis.w) / bw;
      var kLado = Math.max(40, vis.w - 224) / bw;
      var kAlto = Math.max(40, vis.h - 12) / bh;
      k = Math.min(6, Math.max(k35, Math.min(kLado, kAlto)));
      if (!(k > 0)) return;
    }
    var cx = (b[0][0] + b[1][0]) / 2;
    var cy = (b[0][1] + b[1][1]) / 2;
    var tx = vis.x + vis.w / 2 - cx * k;
    var folga = pontual ? 16 : 8;
    var topo = vis.y + 4;
    var base = vis.y + vis.h - 4;
    var alt = (b[1][1] - b[0][1]) * k + folga * 2;
    var ty = alt <= base - topo ? (topo + base) / 2 - cy * k : base - folga - b[1][1] * k;
    aplicar(k, tx, ty);
  }

  function ajustarPais(iso, k, tx, ty, vis) {
    var f = featureDe(iso);
    if (!f) return { k: k, tx: tx, ty: ty };
    var b = path.bounds(f);
    if (!isFinite(b[0][1]) || !isFinite(b[1][1])) return { k: k, tx: tx, ty: ty };
    var pontual = Math.abs(b[1][0] - b[0][0]) < 1 && Math.abs(b[1][1] - b[0][1]) < 1;
    var folga = pontual ? 12 : 6;
    var topo = vis.y + 2;
    var base = vis.y + vis.h - 2;
    function faixa(kk, tyy) {
      return {
        y0: b[0][1] * kk + tyy - folga,
        y1: b[1][1] * kk + tyy + folga
      };
    }
    var y = faixa(k, ty);
    if (y.y1 <= base && y.y0 >= topo) return { k: k, tx: tx, ty: ty };
    var alt = Math.max(y.y1 - y.y0, 1);
    var banda = Math.max(40, base - topo);
    if (alt > banda) {
      var mx = (b[0][0] + b[1][0]) / 2;
      var my = (b[0][1] + b[1][1]) / 2;
      k = Math.max(0.05, Math.min(4, k * (banda / alt)));
      tx = vis.x + vis.w / 2 - mx * k;
      ty = (topo + base) / 2 - my * k;
      return { k: k, tx: tx, ty: ty };
    }
    if (y.y1 > base) ty -= y.y1 - base;
    y = faixa(k, ty);
    if (y.y0 < topo) ty += topo - y.y0;
    return { k: k, tx: tx, ty: ty };
  }

  function quadro() {
    if (!sel || !P[sel] || !path) return { ok: false, k: T ? T.k : 0 };
    var ids = [sel].concat(Object.keys(P[sel].ligacoes || {}));
    var feats = [];
    ids.forEach(function (a) {
      var f = featureDe(a);
      if (f) feats.push(f);
    });
    var b = path.bounds({ type: 'FeatureCollection', features: feats });
    var vis = areaVisivel();
    function xy(x, y) { return [x * T.k + T.x, y * T.k + T.y]; }
    var cantos = [xy(b[0][0], b[0][1]), xy(b[1][0], b[0][1]), xy(b[0][0], b[1][1]), xy(b[1][0], b[1][1])];
    var tol = 3;
    var ok = T.k <= 4.001 && cantos.every(function (p) {
      return p[0] >= vis.x - tol && p[0] <= vis.x + vis.w + tol && p[1] >= vis.y - tol && p[1] <= vis.y + vis.h + tol;
    });
    return { ok: ok, k: T.k, vis: vis, cantos: cantos };
  }

  function nomeCurto(iso) {
    if (iso === 'US') return 'EUA';
    if (iso === 'GB') return 'R. Unido';
    var n = P[iso] ? P[iso].nome : iso;
    if (n.length <= 10) return n;
    var pedaco = n.split(/[\s,–-]/)[0];
    return pedaco.length <= 10 ? pedaco : pedaco.slice(0, 9);
  }

  function caixaTela(iso) {
    var f = featureDe(iso);
    if (!f || !path || !T) return null;
    var b = path.bounds(f);
    if (!isFinite(b[0][0]) || !isFinite(b[1][0]) || !isFinite(b[0][1]) || !isFinite(b[1][1])) return null;
    var x0 = b[0][0] * T.k + T.x, y0 = b[0][1] * T.k + T.y;
    var x1 = b[1][0] * T.k + T.x, y1 = b[1][1] * T.k + T.y;
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  function cruzaCaixa(a, b, folga) {
    folga = folga || 0;
    return a.x < b.x + b.w + folga && a.x + a.w + folga > b.x && a.y < b.y + b.h + folga && a.y + a.h + folga > b.y;
  }

  function bordaRaio(cx, cy, vis) {
    var mx = vis.x + vis.w / 2, my = vis.y + vis.h / 2;
    var dx = cx - mx, dy = cy - my;
    var ang = Math.atan2(dy, dx);
    if (!isFinite(ang)) ang = 0;
    var vx0 = vis.x, vy0 = vis.y, vx1 = vis.x + vis.w, vy1 = vis.y + vis.h;
    var tMin = Infinity, dir = 'd', hx = mx, hy = my;
    function considera(t, edge, x, y) {
      if (t > 1e-4 && t < tMin) { tMin = t; dir = edge; hx = x; hy = y; }
    }
    if (dx > 1e-6) considera((vx1 - mx) / dx, 'd', vx1, my + dy * (vx1 - mx) / dx);
    else if (dx < -1e-6) considera((vx0 - mx) / dx, 'e', vx0, my + dy * (vx0 - mx) / dx);
    if (dy > 1e-6) considera((vy1 - my) / dy, 'b', mx + dx * (vy1 - my) / dy, vy1);
    else if (dy < -1e-6) considera((vy0 - my) / dy, 'c', mx + dx * (vy0 - my) / dy, vy0);
    var secund = (dir === 'e' || dir === 'd') ? (dy < 0 ? 'c' : 'b') : (dx < 0 ? 'e' : 'd');
    return { dir: dir, secund: secund, ang: ang * 180 / Math.PI, cruzX: hx, cruzY: hy };
  }

  function pontoTela(iso) {
    if (!T) return null;
    if (anchor[iso]) return [anchor[iso][0] * T.k + T.x, anchor[iso][1] * T.k + T.y];
    var box = caixaTela(iso);
    if (!box) return null;
    return [box.x + box.w / 2, box.y + box.h / 2];
  }

  function naTela(iso) {
    var p = pontoTela(iso);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return false;
    var vis = areaVisivel();
    return p[0] >= vis.x && p[0] <= vis.x + vis.w && p[1] >= vis.y && p[1] <= vis.y + vis.h;
  }

  function pesoLig(iso) {
    var L = sel && P[sel] && P[sel].ligacoes[iso];
    if (!L) return 0;
    return (L.s || 0) + (L.t || 0) + (L.p || 0);
  }

  function caixaRel(el, folga) {
    if (!el || !svgEl) return null;
    var s = svgEl.getBoundingClientRect();
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    folga = folga || 0;
    return { x: r.left - s.left - folga, y: r.top - s.top - folga, w: r.width + folga * 2, h: r.height + folga * 2 };
  }

  function caixaPrincipal(iso) {
    var p = pontoTela(iso);
    if (PINOS[iso] && p) return { x: p[0] - 18, y: p[1] - 18, w: 36, h: 36 };
    var f = featureDe(iso);
    if (!f || !path || !T) return null;
    var maior = geometriaMaior(f);
    var b = path.bounds({ type: 'Feature', properties: {}, geometry: maior });
    if (!isFinite(b[0][0]) || !isFinite(b[1][0])) return null;
    var x0 = b[0][0] * T.k + T.x, y0 = b[0][1] * T.k + T.y;
    var x1 = b[1][0] * T.k + T.x, y1 = b[1][1] * T.k + T.y;
    return { x: Math.min(x0, x1) - 6, y: Math.min(y0, y1) - 6, w: Math.abs(x1 - x0) + 12, h: Math.abs(y1 - y0) + 12 };
  }

  function cabeFora(r, vis, bloqueios) {
    var m = 4;
    if (r.x < vis.x + m - 0.5 || r.y < vis.y + m - 0.5) return false;
    if (r.x + r.w > vis.x + vis.w - m + 0.5 || r.y + r.h > vis.y + vis.h - m + 0.5) return false;
    var i;
    for (i = 0; i < bloqueios.length; i++) if (cruzaCaixa(r, bloqueios[i], 2)) return false;
    return true;
  }

  function larguraChip(nome) {
    return Math.max(44, Math.min(108, Math.round(28 + String(nome).length * 8.2)));
  }

  function varrerBorda(dir, W, H, vis, bloqueios, ideal) {
    var m = 4;
    var vx0 = vis.x, vy0 = vis.y, vx1 = vis.x + vis.w, vy1 = vis.y + vis.h;
    var vertical = dir === 'e' || dir === 'd';
    var fixo = vertical ? (dir === 'e' ? vx0 + m : vx1 - m - W) : (dir === 'c' ? vy0 + m : vy1 - m - H);
    var min = vertical ? vy0 + m : vx0 + m;
    var max = vertical ? vy1 - m - H : vx1 - m - W;
    if (max < min) return null;
    var alvo = Math.max(min, Math.min(max, ideal));
    var passo, k, val, r;
    for (passo = 0; passo <= max - min + 4; passo += 4) {
      var vals = passo === 0 ? [alvo] : [alvo - passo, alvo + passo];
      for (k = 0; k < vals.length; k++) {
        val = vals[k];
        if (val < min - 0.5 || val > max + 0.5) continue;
        r = vertical ? { x: fixo, y: val, w: W, h: H } : { x: val, y: fixo, w: W, h: H };
        if (cabeFora(r, vis, bloqueios)) return r;
      }
    }
    return null;
  }

  function acharLugar(it, vis, bloqueios) {
    // Vale também na segunda tentativa, sem alterar a fila ou as direções.
    var notaBox = caixaRel($('nota'), 8);
    if (notaBox) bloqueios = bloqueios.concat([notaBox]);
    var H = 44;
    var larguras = [larguraChip(it.nome), 44];
    var borda = bordaRaio(it.cx, it.cy, vis);
    var dirs = [borda.dir];
    if (dirs.indexOf(borda.secund) < 0) dirs.push(borda.secund);
    var di, li, W, dir, ideal, achado;
    for (di = 0; di < dirs.length; di++) {
      dir = dirs[di];
      for (li = 0; li < larguras.length; li++) {
        W = larguras[li];
        if (dir === borda.dir) {
          ideal = (dir === 'e' || dir === 'd') ? borda.cruzY - H / 2 : borda.cruzX - W / 2;
        } else if (dir === 'e' || dir === 'd') {
          ideal = borda.dir === 'c' ? vis.y : vis.y + vis.h;
        } else {
          ideal = borda.dir === 'e' ? vis.x : vis.x + vis.w;
        }
        achado = varrerBorda(dir, W, H, vis, bloqueios, ideal);
        if (achado) {
          var meioX = achado.x + achado.w / 2, meioY = achado.y + achado.h / 2;
          var ang = Math.atan2(it.cy - meioY, it.cx - meioX) * 180 / Math.PI;
          if (!isFinite(ang)) ang = borda.ang;
          return { x: achado.x, y: achado.y, w: achado.w, h: achado.h, dir: dir, ang: ang };
        }
      }
    }
    return null;
  }

  function desenharFora() {
    if (!gFora) return;
    var postos = [];
    if (modoCelular() && sel && P[sel] && T && path) {
      var vis = areaVisivel();
      var fixos = [];
      var zoomBox = caixaRel(document.querySelector('#mapa-mundi-tela .zoom'), 6);
      var notaBox = caixaRel($('nota'), 6);
      if (zoomBox) fixos.push(zoomBox);
      if (notaBox) fixos.push(notaBox);
      var selBox = caixaPrincipal(sel);
      var ocupados = fixos.slice();
      if (selBox) ocupados.push(selBox);
      function colocar(it) {
        var lugar = acharLugar(it, vis, ocupados);
        if (lugar) return lugar;
        return acharLugar(it, vis, fixos.concat(ocupados.filter(function (b) { return b !== selBox; })));
      }
      var fila = Object.keys(P[sel].ligacoes || {}).filter(function (iso) { return !naTela(iso); });
      fila.sort(function (a, b) { return pesoLig(b) - pesoLig(a) || (a < b ? -1 : a > b ? 1 : 0); });
      var extras = [];
      if (fila.length > 6) {
        extras = fila.slice(5);
        fila = fila.slice(0, 5);
      }
      function guardar(iso, nome, resto, lugar) {
        ocupados.push(lugar);
        postos.push({ iso: iso, nome: nome, resto: resto, x: lugar.x, y: lugar.y, w: lugar.w, h: lugar.h, dir: lugar.dir, ang: lugar.ang });
      }
      fila.forEach(function (iso) {
        var p = pontoTela(iso) || [vis.x, vis.y];
        var it = { iso: iso, nome: nomeCurto(iso), cx: p[0], cy: p[1] };
        var lugar = colocar(it);
        if (lugar) guardar(iso, it.nome, '', lugar);
      });
      if (extras.length) {
        var sx = 0, sy = 0, nMeio = 0, ie, pe;
        for (ie = 0; ie < extras.length; ie++) {
          pe = pontoTela(extras[ie]);
          if (!pe) continue;
          sx += pe[0];
          sy += pe[1];
          nMeio++;
        }
        var nomeMais = '+' + extras.length;
        var lugarMais = colocar({
          nome: nomeMais,
          cx: nMeio ? sx / nMeio : vis.x + vis.w,
          cy: nMeio ? sy / nMeio : vis.y + vis.h / 2
        });
        if (lugarMais) guardar('+', nomeMais, extras.join(','), lugarMais);
      }
    }
    var join = gFora.selectAll('g.fora').data(postos, function (d) { return d.iso; });
    join.exit().remove();
    var enter = join.enter().append('g')
      .attr('class', 'fora')
      .attr('role', 'button')
      .attr('tabindex', '0');
    enter.append('rect').attr('class', 'alvo').attr('rx', 3);
    enter.append('path').attr('class', 'haste');
    enter.append('path').attr('class', 'seta');
    enter.append('text');
    var all = enter.merge(join);
    all.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; })
      .attr('data-iso', function (d) { return d.iso; })
      .attr('data-resto', function (d) { return d.resto || null; })
      .attr('aria-label', function (d) {
        if (d.resto) return 'Enquadrar o conjunto. Mais ' + d.resto.split(',').length + ' países fora da tela.';
        return 'Enquadrar o conjunto. ' + d.nome + ' está fora da tela.';
      })
      .on('pointerdown mousedown touchstart', function (ev) { ev.stopPropagation(); })
      .on('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!sel) return;
        enquadrar(sel, { conjunto: true });
        cameras[location.hash] = { x: T.x, y: T.y, k: T.k };
      })
      .on('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        if (!sel) return;
        enquadrar(sel, { conjunto: true });
        cameras[location.hash] = { x: T.x, y: T.y, k: T.k };
      });
    all.select('rect').attr('width', function (d) { return d.w; }).attr('height', function (d) { return d.h; });
    function giroSeta(d) {
      var deg = isFinite(d.ang) ? d.ang : 0;
      return 'translate(8,16) rotate(' + deg.toFixed(2) + ',6.5,6)';
    }
    all.select('path.haste').attr('d', 'M0 6 H8').attr('transform', giroSeta);
    all.select('path.seta').attr('d', 'M6 2 L13 6 L6 10 Z').attr('data-ponta', '13,6').attr('transform', giroSeta);
    all.select('text').attr('x', 24).attr('y', 28).text(function (d) { return d.nome; });
  }

  function grupo(n) {
    if (n >= 8) return ' g3';
    if (n >= 4) return ' g2';
    if (n >= 2) return ' g1';
    return '';
  }
  function arco(a, b) {
    var p1 = anchor[a], p2 = anchor[b];
    if (!p1 || !p2) return null;
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
    var dist = Math.hypot(dx, dy) || 1;
    var o = Math.min(160, dist * 0.32);
    var cx = mx + dy / dist * o * (dx > 0 ? -1 : 1), cy = my - Math.abs(dx / dist) * o;
    var inteiro = 'M' + x1 + ',' + y1 + ' Q' + cx + ',' + cy + ' ' + x2 + ',' + y2;
    // Subcurvas quadráticas exatas: mesmas âncoras, curvatura e tangentes.
    function ponto(t) {
      var u = 1 - t;
      return [u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2];
    }
    var partes = [];
    for (var i = 0; i < 3; i++) {
      var t0 = i / 3, t1 = (i + 1) / 3, dt = t1 - t0;
      var a0 = ponto(t0), b0 = ponto(t1);
      var qx = a0[0] + dt * ((1 - t0) * (cx - x1) + t0 * (x2 - cx));
      var qy = a0[1] + dt * ((1 - t0) * (cy - y1) + t0 * (y2 - cy));
      partes.push('M' + a0 + ' Q' + qx + ',' + qy + ' ' + b0);
    }
    return { partes: partes, inteiro: inteiro };
  }
  function desenharArcos() {
    var data = [];
    if (sel && P[sel]) {
      Object.keys(P[sel].ligacoes).forEach(function (b) {
        if (!anchor[b]) return;
        var L = P[sel].ligacoes[b];
        var curva = arco(sel, b);
        if (!curva) return;
        ['s', 't', 'p'].forEach(function (k) {
          if (!L[k]) return;
          curva.partes.concat([curva.inteiro]).forEach(function (d, i) {
            data.push({ b: b, k: k, n: L[k], i: i, d: d });
          });
        });
      });
    }
    // Três larguras e um caminho sem traço para conservar só as pontas originais.
    gArc.selectAll('path').data(data, function (d) { return d.b + d.k + d.i; }).join('path')
      .attr('class', function (d) { return 'arco ' + d.k + grupo(d.n) + ' ' + ['inicio', 'meio', 'fim', 'pontas'][d.i]; })
      .attr('d', function (d) { return d.d; });
  }
  function marcar() {
    var lig = sel && P[sel] ? P[sel].ligacoes : {};
    gPais.selectAll('path')
      .classed('sel', function (f) { return byNum[f.id] === sel; })
      .classed('lig', function (f) { return !!(byNum[f.id] && lig[byNum[f.id]]); });
    gHist.selectAll('path').classed('sel', sel === 'XP').classed('lig', !!(lig && lig.XP));
    gPin.selectAll('g').classed('sel', function (a) { return a === sel; }).classed('lig', function (a) { return !!(lig && lig[a]); });
    gPais.selectAll('path.sel').raise();
    gHist.selectAll('path.sel').raise();
    // Cópias só da seleção. Traços em pixels dispensam filtros e atualização no zoom.
    var fHalo = sel && !PINOS[sel] ? featureDe(sel) : null;
    var halo = g.selectAll('g.mm-halo').data(fHalo ? [fHalo] : []).join(function (enter) {
      return enter.insert('g', '#arcos').attr('class', 'mm-halo').attr('aria-hidden', 'true');
    });
    var contorno = fHalo ? path(fHalo) : '';
    halo.selectAll('path').data([0, 1, 2, 3]).join('path')
      .attr('class', function (n) { return 'mm-halo-traco mm-halo-' + n; })
      .attr('d', contorno);
    // Os pinos já têm escala inversa ao zoom; o halo acompanha o mesmo círculo.
    gPin.selectAll('g').each(function (a) {
      d3.select(this).selectAll('circle.mm-halo-traco').data(a === sel ? [0, 1, 2] : []).join(function (enter) {
        return enter.insert('circle', '.ponto');
      }).attr('class', function (n) { return 'mm-halo-traco mm-halo-' + n; })
        .attr('r', 3.5).attr('aria-hidden', 'true');
    });
  }

  function linkFicha(id, nome) {
    var a = el('a', { href: '#e=' + encodeURIComponent(id), text: nome });
    return a;
  }
  function linkCaso(id, nome) {
    return el('a', { href: '#' + encodeURIComponent(id), text: nome });
  }

  function abrirFolha(v) {
    var B = document.body.classList;
    B.toggle('folha-aberta', !!v);
    if (!v || v !== 'cheia') B.remove('folha-cheia');
    if (v === 'cheia') B.add('folha-cheia');
    var alca = $('alca');
    if (alca) alca.setAttribute('aria-expanded', v ? 'true' : 'false');
  }

  function painel() {
    conteudo.replaceChildren();
    if (!sel || !P[sel]) {
      var lista = Object.keys(P).sort(function (a, b) {
        return P[b].fichas.length - P[a].fichas.length || P[a].nome.localeCompare(P[b].nome, 'pt');
      });
      conteudo.append(
        el('h2', { class: 'ptitulo', text: 'Escolha um país' }),
        el('p', { class: 'ajuda', text: 'Toque num país do mapa ou use a lista. A cor indica o número de fichas.' })
      );
      var ul = el('ul', { class: 'paises', 'aria-label': 'Países com fichas' });
      lista.forEach(function (a) {
        var p = P[a];
        ul.append(el('li', null, el('button', { type: 'button', class: 'linha', 'data-iso': a },
          el('span', { text: p.nome }),
          el('b', { text: fmt(p.fichas.length) })
        )));
      });
      conteudo.append(ul);
      conteudo.append(legPainel);
      return;
    }
    var p = P[sel];
    var destinos = Object.keys(p.ligacoes).sort(function (a, b) {
      var A = p.ligacoes[a], B = p.ligacoes[b];
      return (B.s + B.t + B.p) - (A.s + A.t + A.p);
    });
    conteudo.append(el('button', { type: 'button', class: 'voltar', id: 'limpar', text: '← Todos os países' }));
    conteudo.append(el('h2', { class: 'ptitulo', text: p.nome }));
    if (p.hist) conteudo.append(el('p', { class: 'ajuda', text: 'Região histórica. O mapa desenha a sede; o nome é o rótulo do registro.' }));
    conteudo.append(el('p', { class: 'conta' },
      el('b', { text: fmt(p.fichas.length) }),
      document.createTextNode(' ' + pl(p.fichas.length, 'ficha', 'fichas') + ' · '),
      el('b', { text: fmt(p.casos.length) }),
      document.createTextNode(' ' + pl(p.casos.length, 'história', 'histórias') + ' · '),
      el('b', { text: fmt(destinos.length) }),
      document.createTextNode(' ' + pl(destinos.length, 'país ligado', 'países ligados') + ' · ' + fmt(p.internas) + ' ' + pl(p.internas, 'ligação interna', 'ligações internas'))
    ));
    conteudo.append(el('h3', { text: 'Países ligados' }));
    if (!destinos.length) conteudo.append(el('p', { class: 'ajuda', text: 'Nenhuma ligação com outro país mapeado.' }));
    else {
      var ulL = el('ul', { class: 'ligados' });
      destinos.forEach(function (b) {
        var v = p.ligacoes[b];
        var tipos = el('p', { class: 'tipos' });
        ['s', 't', 'p'].forEach(function (k) {
          if (!v[k]) return;
          tipos.append(el('span', { class: 'tag ' + k }, el('i'), document.createTextNode(v[k] + ' ' + ROT[k])));
        });
        var li = el('li', null, el('button', { type: 'button', class: 'linha', 'data-iso': b },
          el('span', { text: P[b] ? P[b].nome : b }),
          el('b', { text: String(v.s + v.t + v.p) })
        ), tipos);
        if (v.ex && v.ex[0]) li.append(el('p', { class: 'ex', text: v.ex[0][0] + ' · ' + rotulo(v.ex[0][1]) + ' · ' + v.ex[0][2] }));
        ulL.append(li);
      });
      conteudo.append(ulL);
    }
    if (p.ligadas && p.ligadas.length) {
      conteudo.append(el('h3', { text: 'Famílias e instituições ligadas' }));
      var ulE = el('ul', { class: 'ligadas' });
      p.ligadas.forEach(function (x) {
        ulE.append(el('li', null, linkFicha(x[0], x[1]), document.createTextNode(' '), el('small', { text: rotulo(x[2]) + ' · ' + x[3] + ' lig.' })));
      });
      conteudo.append(ulE);
    }
    if (p.casos && p.casos.length) {
      conteudo.append(el('h3', { text: 'Histórias' }));
      var ulC = el('ul', { class: 'casos' });
      p.casos.forEach(function (c) {
        ulC.append(el('li', null, linkCaso(c[0], c[1]), document.createTextNode(' '), el('small', { text: c[2] || '' })));
      });
      conteudo.append(ulC);
    }
    conteudo.append(el('h3', { text: 'Fichas (' + fmt(p.fichas.length) + ')' }));
    var ulF = el('ul', { class: 'fichas' });
    p.fichas.slice(0, 60).forEach(function (e) {
      var extra = rotulo(e[2]) + (e[3] ? ' · ' + e[3] : '');
      ulF.append(el('li', null, linkFicha(e[0], e[1]), document.createTextNode(' '), el('small', { text: extra })));
    });
    conteudo.append(ulF);
    if (p.fichas.length > 60) conteudo.append(el('p', { class: 'ajuda', text: '+ ' + fmt(p.fichas.length - 60) + ' fichas.' }));
    conteudo.append(legPainel);
    conteudo.scrollTop = 0;
  }

  function escolher(a, opt) {
    opt = opt || {};
    if (a && !P[a]) a = null;
    var novo = a || null;
    var mudou = novo !== sel;
    sel = novo;
    var hash = sel ? '#mapa-mundi/' + sel : '#mapa-mundi';
    var navega = opt.hist !== false && location.hash !== hash;
    if (navega) {
      cameras[location.hash] = { x: T.x, y: T.y, k: T.k };
      history.pushState({ mm: sel || '' }, '', location.pathname + location.search + hash);
    }
    desenharArcos();
    marcar();
    painel();
    document.body.classList.toggle('com-sel', !!sel);
    if (sel) abrirFolha(true);
    if (opt.hist === false && cameras[hash]) {
      aplicar(cameras[hash].k, cameras[hash].x, cameras[hash].y);
      return;
    }
    if (!mudou && !navega) return;
    if (sel) enquadrar(sel);
    else aplicar(1, 0, 0);
    cameras[hash] = { x: T.x, y: T.y, k: T.k };
  }

  function tamanhoMudou() {
    var r = svgEl.getBoundingClientRect();
    return Math.abs(r.width - ultW) > 1 || Math.abs(r.height - ultH) > 1;
  }

  function mount(opts) {
    if (desenhado) return;
    W = opts.world;
    D = opts.dados;
    P = D.paises;
    byNum = {};
    Object.keys(P).forEach(function (a) { if (P[a].num != null) byNum[String(P[a].num).padStart(3, '0')] = a; });
    geo = d3.feature(W, W.objects.countries).features;
    anchor = {};
    ancoraGeo = {};
    cameras = {};
    sel = null;
    T = d3.zoomIdentity;
    moved = false;
    montarTela();
    zm = d3.zoom().scaleExtent([0.05, 8]).on('start', function (ev) {
      moved = false;
      downAt = ev.transform;
    }).on('zoom', function (ev) {
      T = ev.transform;
      if (ev.sourceEvent) cameras[location.hash] = { x: T.x, y: T.y, k: T.k };
      if (downAt && (Math.abs(T.x - downAt.x) > 3 || Math.abs(T.y - downAt.y) > 3 || T.k !== downAt.k)) moved = true;
      g.attr('transform', T);
      svg.attr('data-k', T.k.toFixed(2));
      gPin.selectAll('g').attr('transform', function (a) {
        return 'translate(' + anchor[a] + ') scale(' + (1 / T.k) + ')';
      });
    }).on('end', function () {
      setTimeout(function () { moved = false; }, 0);
      desenharFora();
    });
    svg.call(zm).on('dblclick.zoom', null);
    $('zmais').addEventListener('click', function () { svg.call(zm.scaleBy, 1.6); });
    $('zmenos').addEventListener('click', function () { svg.call(zm.scaleBy, 1 / 1.6); });
    $('zreset').addEventListener('click', function () { svg.call(zm.transform, d3.zoomIdentity); });
    $('alca').addEventListener('click', function () {
      var B = document.body.classList;
      if (!B.contains('folha-aberta')) abrirFolha(true);
      else if (B.contains('folha-cheia')) abrirFolha(true);
      else abrirFolha('cheia');
    });
    conteudo.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-iso]');
      if (b) escolher(b.getAttribute('data-iso'));
      if (ev.target.closest('#limpar')) { escolher(null); abrirFolha(false); }
    });
    var rt;
    new ResizeObserver(function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (!tela.hidden && tamanhoMudou()) layout();
      }, 120);
    }).observe(svgEl);
    window.__mapa = {
      get t() { return { x: T.x, y: T.y, k: T.k }; },
      escolher: function (a) { escolher(a); },
      reler: function () {
        desenharArcos();
        marcar();
        painel();
        g.attr('transform', T);
      },
      quadro: quadro,
      ancora: function (a) { return ancoraGeo[a] ? ancoraGeo[a].slice() : null; },
      naTela: function (a) { return naTela(a); },
      ponto: function (a) {
        var p = pontoTela(a);
        return p ? [p[0], p[1]] : null;
      },
      mundo: W,
      caminho: function (geom) { return path ? path(geom) : ''; },
      fichas: function (a) { return P[a] ? P[a].fichas.length : 0; },
      nome: function (a) { return P[a] ? P[a].nome : ''; }
    };
  }

  function mostrar(iso) {
    if (!tela) return;
    tela.hidden = false;
    if (!desenhado || tamanhoMudou()) layout();
    escolher(iso || null, { hist: false });
  }

  window.MapaMundi = { mount: mount, mostrar: mostrar };
})();
