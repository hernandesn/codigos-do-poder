/* Mapa-múndi. Porte do protótipo: zoom no SVG, arcos do país selecionado, painel. */
(function () {
  'use strict';
  var d3 = window.d3mapa;
  if (!d3) return;

  var W, D, P, byNum, tela, svgEl, svg, g, gPais, gHist, gArc, gPin, conteudo;
  var proj, path, anchor, sel, T, zm, moved, downAt, desenhado, ultW, ultH, geo;

  var PINOS = { VA: [12.45, 41.9], MT: [14.4, 35.9], LU: [6.13, 49.8] };
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
    var cena = svgElns('g', { id: 'mm-cena' });
    cena.append(svgElns('g', { id: 'paises' }));
    cena.append(svgElns('g', { id: 'hist' }));
    cena.append(svgElns('g', { id: 'arcos' }));
    cena.append(svgElns('g', { id: 'pinos' }));
    svgEl.append(cena);
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
    var legPainel = legenda();
    legPainel.classList.add('leg-painel');
    painel.append(legPainel);
    tela.append(palco, painel);
    document.body.appendChild(tela);
    conteudo = $('mm-conteudo');
    svg = d3.select(svgEl);
    g = svg.select('#mm-cena');
    gPais = svg.select('#paises');
    gHist = svg.select('#hist');
    gArc = svg.select('#arcos');
    gPin = svg.select('#pinos');
  }

  function maiorParte(f) {
    if (!f.geometry || f.geometry.type !== 'MultiPolygon') return f;
    var best = null, ba = -1, coords = f.geometry.coordinates, i, p, a;
    for (i = 0; i < coords.length; i++) {
      p = { type: 'Polygon', coordinates: coords[i] };
      a = d3.geoArea(p);
      if (a > ba) { ba = a; best = p; }
    }
    return best || f;
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
    anchor = {};
    gPais.selectAll('path').data(geo, function (f) { return f.id; }).join('path')
      .attr('d', path)
      .attr('fill', function (f) {
        var a = byNum[f.id];
        return cor(a ? P[a].fichas.length : 0);
      })
      .attr('class', function (f) { return byNum[f.id] ? 'pais tem' : 'pais'; })
      .attr('data-iso', function (f) { return byNum[f.id] || null; })
      .on('click', function (ev, f) {
        var a = byNum[f.id];
        if (a && !moved) escolher(a);
      });
    geo.forEach(function (f) {
      var a = byNum[f.id];
      if (a) anchor[a] = path.centroid(maiorParte(f));
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
    gHist.selectAll('path').data(xp ? [xp] : []).join('path')
      .attr('d', path)
      .attr('class', 'pais tem hist')
      .attr('data-iso', 'XP')
      .attr('fill', cor(P.XP ? P.XP.fichas.length : 0))
      .on('click', function () { if (!moved) escolher('XP'); });
    if (xp) anchor.XP = path.centroid(xp);
    Object.keys(PINOS).forEach(function (a) {
      if (P[a]) anchor[a] = proj(PINOS[a]);
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
    var B = path.bounds(esfera);
    zm.extent([[0, 0], [w, h]]).translateExtent([
      [Math.min(B[0][0], 0) - 20, Math.min(B[0][1], 0) - 20],
      [Math.max(B[1][0], w) + 20, Math.max(B[1][1], h) + 20]
    ]);
    desenharArcos();
    marcar();
    desenhado = true;
  }

  function grupo(n) {
    if (n >= 8) return ' g3';
    if (n >= 4) return ' g2';
    if (n >= 2) return ' g1';
    return '';
  }
  function arco(a, b) {
    var p1 = anchor[a], p2 = anchor[b];
    if (!p1 || !p2) return '';
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
    var dist = Math.hypot(dx, dy) || 1;
    var o = Math.min(160, dist * 0.32);
    return 'M' + x1 + ',' + y1 + ' Q' + (mx + dy / dist * o * (dx > 0 ? -1 : 1)) + ',' + (my - Math.abs(dx / dist) * o) + ' ' + x2 + ',' + y2;
  }
  function desenharArcos() {
    var data = [];
    if (sel && P[sel]) {
      Object.keys(P[sel].ligacoes).forEach(function (b) {
        if (!anchor[b]) return;
        var L = P[sel].ligacoes[b];
        ['s', 't', 'p'].forEach(function (k) {
          if (L[k]) data.push({ b: b, k: k, n: L[k] });
        });
      });
    }
    gArc.selectAll('path').data(data, function (d) { return d.b + d.k; }).join('path')
      .attr('class', function (d) { return 'arco ' + d.k + grupo(d.n); })
      .attr('d', function (d) { return arco(sel, d.b); });
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
    conteudo.scrollTop = 0;
  }

  function escolher(a, opt) {
    opt = opt || {};
    if (a && !P[a]) a = null;
    sel = a || null;
    desenharArcos();
    marcar();
    if (opt.hist !== false) {
      var hash = sel ? '#mapa-mundi/' + sel : '#mapa-mundi';
      if (location.hash !== hash) history.pushState({ mm: sel || '' }, '', location.pathname + location.search + hash);
    }
    painel();
    document.body.classList.toggle('com-sel', !!sel);
    if (sel) abrirFolha(true);
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
    sel = null;
    T = d3.zoomIdentity;
    moved = false;
    montarTela();
    zm = d3.zoom().scaleExtent([1, 8]).on('start', function (ev) {
      moved = false;
      downAt = ev.transform;
    }).on('zoom', function (ev) {
      T = ev.transform;
      if (downAt && (Math.abs(T.x - downAt.x) > 3 || Math.abs(T.y - downAt.y) > 3 || T.k !== downAt.k)) moved = true;
      g.attr('transform', T);
      svg.attr('data-k', T.k.toFixed(2));
      gPin.selectAll('g').attr('transform', function (a) {
        return 'translate(' + anchor[a] + ') scale(' + (1 / T.k) + ')';
      });
    }).on('end', function () { setTimeout(function () { moved = false; }, 0); });
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
