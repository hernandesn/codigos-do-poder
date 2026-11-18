/* Mapa completo (#all) no visual do grafo de força.
   Funções puras (grau, raio, polos, traço) também rodam no teste de nó.
   O mural de cartões continua no DOM, escondido, para as outras visões. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.mapaCompleto = api;
  if (typeof document !== 'undefined') {
    const subir = () => { try { api.montar(); } catch (erro) { console.warn('mapa completo: ' + (erro && erro.message || erro)); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', subir);
    else subir();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const POLOS = { ipes: true, rf: true, papacy: true };
  const SVG = 'http://www.w3.org/2000/svg';
  const PRIORIDADE = { ipes: 4, rf: 3, papacy: 2, kochpac: 1 };

  function normalizarConfianca(valor) {
    const s = String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (s === 'alta') return 'alta';
    if (s === 'media') return 'media';
    return 'baixa';
  }

  function nomeCurto(nome) {
    return String(nome || '').split(' · ')[0].split(' (')[0];
  }

  function ehPolo(id) { return !!POLOS[id]; }

  function grauDe(id, ligacoes) {
    let n = 0;
    for (const e of ligacoes || []) if (e && (e.origem === id || e.destino === id)) n += 1;
    return n;
  }

  function raioDoGrau(grau) {
    const g = Number(grau);
    return 1.1 + 1.25 * Math.sqrt(g > 0 ? g : 0);
  }

  function raioNaTela(grau, polo, largura, zoom) {
    const z = zoom > 0 ? zoom : 1;
    const w = largura > 0 ? largura : 2400;
    return raioDoGrau(grau) * (polo ? 0.8 : 1) * (w / 2400) * 1.6 * z;
  }

  function estiloNo(id) {
    if (ehPolo(id)) return { fill: '#7a0a0a', stroke: '#f2e7d2', opacidade: 1, polo: true };
    return { fill: '#e2d6bc', stroke: '#0a0706', opacidade: 0.9, polo: false };
  }

  function estiloLinha(confianca, polo) {
    const c = normalizarConfianca(confianca);
    const base = c === 'alta'
      ? { cor: '#d8cbb0', opacidade: 0.3, traco: [] }
      : c === 'media'
        ? { cor: '#c49660', opacidade: 0.55, traco: [4, 3] }
        : { cor: '#b5afc4', opacidade: 0.75, traco: [1, 2.5] };
    if (polo) return { cor: '#c43a30', opacidade: c === 'alta' ? 0.45 : 0.7, traco: base.traco.slice(), classe: c };
    return { cor: base.cor, opacidade: base.opacidade, traco: base.traco.slice(), classe: c };
  }

  function posicaoReserva(id) {
    let h = 2166136261;
    const s = String(id);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const u = (h >>> 0) / 4294967296;
    const angulo = u * Math.PI * 2;
    const raio = 1.35 + ((h >>> 8) % 100) / 500;
    return [Math.cos(angulo) * raio, Math.sin(angulo) * raio];
  }

  function lerPar(bruto) {
    if (Array.isArray(bruto) && Number.isFinite(+bruto[0]) && Number.isFinite(+bruto[1])) return [+bruto[0], +bruto[1]];
    if (bruto && Number.isFinite(+bruto.x) && Number.isFinite(+bruto.y)) return [+bruto.x, +bruto.y];
    return null;
  }

  function prepararCena(nos, ligacoes, posicoes) {
    const mapa = posicoes && posicoes.pos ? posicoes.pos : (posicoes || {});
    const ids = new Set();
    const lista = [];
    for (const no of nos || []) {
      if (!no || no.id == null || ids.has(no.id)) continue;
      ids.add(no.id);
      lista.push(no);
    }
    const grau = new Map();
    for (const no of lista) grau.set(no.id, 0);
    const arestas = [];
    for (const e of ligacoes || []) {
      if (!e || !ids.has(e.origem) || !ids.has(e.destino)) continue;
      grau.set(e.origem, grau.get(e.origem) + 1);
      grau.set(e.destino, grau.get(e.destino) + 1);
      const polo = ehPolo(e.origem) || ehPolo(e.destino);
      const conf = normalizarConfianca(e.confianca);
      arestas.push({
        id: e.id == null ? '' : String(e.id),
        origem: e.origem,
        destino: e.destino,
        confianca: conf,
        polo,
        estilo: estiloLinha(conf, polo),
      });
    }
    return {
      nos: lista.map(no => {
        const g = grau.get(no.id) || 0;
        const xy = lerPar(mapa[no.id]) || posicaoReserva(no.id);
        return {
          id: no.id,
          nome: String(no.nome || no.id),
          curto: nomeCurto(no.nome || no.id),
          x: xy[0],
          y: xy[1],
          grau: g,
          polo: ehPolo(no.id),
          estilo: estiloNo(no.id),
        };
      }),
      ligacoes: arestas,
    };
  }

  function contagemConfianca(cena) {
    const c = { alta: 0, media: 0, baixa: 0 };
    for (const e of (cena && cena.ligacoes) || []) c[e.confianca] = (c[e.confianca] || 0) + 1;
    return c;
  }

  const vivo = {
    ativo: false,
    carregando: false,
    pedido: 0,
    cena: null,
    porId: new Map(),
    desenho: { nos: [], ligacoes: [], baldes: null },
    contagem: { nos: 0, ligacoes: 0 },
    cam: { k: 1, x: 0, y: 0 },
    kFit: 1,
    selecionado: null,
    focoId: null,
    ultimo: 0,
    media: 0,
    amostras: [],
    instalado: false,
    montado: false,
    muralCam: null,
    posPromise: null,
    quadro: 0,
    arraste: null,
    ponteiros: new Map(),
    pinca: null,
    ultimoNo: null,
    ultimoQuando: 0,
    ultimoExpandiu: 0,
    pularCentro: false,
    centroPendente: null,
    assinatura: '',
    pendente: false,
    medida: null,
    larguras: new Map(),
    fundo: null,
    fundoChave: '',
    rotulos: new Map(),
    guias: new Map(),
    obsCartoes: null,
  };

  function contagemDesenhada(cena) {
    if (cena) return { nos: cena.nos.length, ligacoes: cena.ligacoes.length };
    return { nos: vivo.contagem.nos, ligacoes: vivo.contagem.ligacoes };
  }

  function ehMobile() {
    return typeof matchMedia === 'function' && matchMedia('(max-width: 620px)').matches;
  }

  function reduzido() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function fmt(n) {
    try { return Number(n).toLocaleString('pt-BR'); } catch { return String(n); }
  }

  function limparMedicao() { vivo.amostras.length = 0; vivo.ultimo = 0; vivo.media = 0; }

  function registrarQuadro(ms) {
    vivo.ultimo = ms;
    vivo.amostras.push(ms);
    if (vivo.amostras.length > 60) vivo.amostras.shift();
    let s = 0;
    for (const v of vivo.amostras) s += v;
    vivo.media = s / vivo.amostras.length;
  }

  function zoomRelativo() {
    return vivo.kFit > 0 ? vivo.cam.k / vivo.kFit : 1;
  }

  function mundoTela(x, y) {
    return { x: x * vivo.cam.k + vivo.cam.x, y: y * vivo.cam.k + vivo.cam.y };
  }

  function pontoNaTela(id) {
    const n = vivo.porId.get(id);
    const canvas = document.getElementById('grafo-canvas');
    if (!n || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    const p = mundoTela(n.x, n.y);
    return { x: r.left + p.x, y: r.top + p.y, dentro: true };
  }

  function limitarZoom(k) {
    const min = vivo.kFit * 0.55;
    const max = vivo.kFit * 14;
    if (!(k > 0)) return min || 1;
    return Math.min(max, Math.max(min, k));
  }

  function atualizarZoomTexto() {
    const el = document.getElementById('zoom-level');
    if (!el || !vivo.ativo) return;
    const texto = Math.round(zoomRelativo() * 100) + '%';
    if (el.textContent !== texto) el.textContent = texto;
  }

  function pedirQuadro() {
    if (vivo.quadro || !vivo.ativo) return;
    vivo.quadro = requestAnimationFrame(() => { vivo.quadro = 0; if (vivo.ativo) desenhar(); });
  }

  function zoomEm(fator, cx, cy) {
    const antes = vivo.cam.k || 1;
    const nk = limitarZoom(antes * fator);
    const real = nk / antes;
    vivo.cam.x = cx - (cx - vivo.cam.x) * real;
    vivo.cam.y = cy - (cy - vivo.cam.y) * real;
    vivo.cam.k = nk;
    atualizarZoomTexto();
    pedirQuadro();
  }

  function zoomCentro(fator) {
    const canvas = document.getElementById('grafo-canvas');
    if (!canvas) return;
    zoomEm(fator, canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  function limitesDe(nos) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nos) {
      if (n.x < x0) x0 = n.x;
      if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x;
      if (n.y > y1) y1 = n.y;
    }
    if (!nos.length || !Number.isFinite(x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 };
    const dx = x1 - x0 || 1;
    const dy = y1 - y0 || 1;
    return { x0: x0 - dx * 0.04, y0: y0 - dy * 0.04, x1: x1 + dx * 0.04, y1: y1 + dy * 0.04 };
  }

  function calcularEnquadramento() {
    const canvas = document.getElementById('grafo-canvas');
    if (!canvas) return null;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 2 || h < 2) return null;
    const base = vivo.desenho.nos.length ? vivo.desenho.nos : (vivo.cena ? vivo.cena.nos : []);
    const b = limitesDe(base);
    const s = Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0));
    vivo.kFit = s > 0 ? s : 1;
    return {
      k: vivo.kFit,
      x: (w - (b.x1 - b.x0) * vivo.kFit) / 2 - b.x0 * vivo.kFit,
      y: (h - (b.y1 - b.y0) * vivo.kFit) / 2 - b.y0 * vivo.kFit,
    };
  }

  function animarPara(k, x, y) {
    const nk = limitarZoom(k);
    if (reduzido()) {
      vivo.cam.k = nk; vivo.cam.x = x; vivo.cam.y = y;
      atualizarZoomTexto();
      pedirQuadro();
      return;
    }
    const a0 = { k: vivo.cam.k, x: vivo.cam.x, y: vivo.cam.y };
    const t0 = performance.now();
    const passo = now => {
      if (!vivo.ativo) return;
      const t = Math.min(1, (now - t0) / 280);
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      vivo.cam.k = a0.k + (nk - a0.k) * e;
      vivo.cam.x = a0.x + (x - a0.x) * e;
      vivo.cam.y = a0.y + (y - a0.y) * e;
      desenhar();
      if (t < 1) requestAnimationFrame(passo);
      else atualizarZoomTexto();
    };
    requestAnimationFrame(passo);
  }

  function enquadrar(animar) {
    const alvo = calcularEnquadramento();
    if (!alvo) { requestAnimationFrame(() => { if (vivo.ativo) enquadrar(animar); }); return; }
    if (animar) animarPara(alvo.k, alvo.x, alvo.y);
    else { vivo.cam.k = alvo.k; vivo.cam.x = alvo.x; vivo.cam.y = alvo.y; atualizarZoomTexto(); pedirQuadro(); }
  }

  function centroEm(id, opts) {
    const n = vivo.porId.get(id);
    const canvas = document.getElementById('grafo-canvas');
    if (!n || !canvas || !vivo.ativo) return false;
    if (!(vivo.kFit > 0)) calcularEnquadramento();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 2 || h < 2) return false;
    const z = Math.max(3.2, Math.min(8, (opts && opts.z) || 3.6));
    const nk = limitarZoom(vivo.kFit * z);
    let cy = h * 0.46;
    const insp = document.getElementById('inspector');
    if (opts && opts.mobile && insp && !insp.hidden) cy = h * 0.3;
    animarPara(nk, w / 2 - n.x * nk, cy - n.y * nk);
    return true;
  }

  function abrirFicha(id, opts) {
    vivo.pularCentro = true;
    if (opts && opts.centro) centroEm(id, opts);
    try {
      const hash = '#e=' + encodeURIComponent(id);
      if (location.hash !== hash) location.hash = hash;
    } catch (erro) { console.warn('mapa completo: ' + (erro && erro.message || erro)); }
  }

  function expandir(id) {
    const botao = document.getElementById('expand-node');
    const acionar = () => { if (botao) botao.click(); };
    if (!id) { acionar(); return; }
    const ehAlvo = () => {
      const st = lerEstado();
      return !!(st && st.selected && st.selected.kind === 'node' && st.selected.id === id);
    };
    if (ehAlvo()) { acionar(); return; }
    // O hashchange do mural seleciona o alvo depois deste turno. Clicar
    // em expandir antes disso expande o nó que ainda está selecionado.
    let feito = false;
    let vezes = 0;
    const seguir = () => {
      if (feito) return;
      if (ehAlvo()) { feito = true; acionar(); return; }
      if (++vezes > 45) return;
      requestAnimationFrame(seguir);
    };
    const noHash = () => {
      window.removeEventListener('hashchange', noHash);
      setTimeout(seguir, 0);
    };
    const hash = '#e=' + encodeURIComponent(id);
    const jaEra = location.hash === hash;
    window.addEventListener('hashchange', noHash);
    abrirFicha(id, { centro: false });
    if (jaEra) {
      window.removeEventListener('hashchange', noHash);
      setTimeout(seguir, 0);
    }
  }

  function toqueNo(id) {
    const agora = Date.now();
    const deNovo = vivo.ultimoNo === id && agora - vivo.ultimoQuando < 500 && agora - vivo.ultimoExpandiu > 500;
    vivo.ultimoNo = id;
    vivo.ultimoQuando = agora;
    if (deNovo) { vivo.ultimoExpandiu = agora; expandir(id); return; }
    abrirFicha(id, { centro: ehMobile(), mobile: ehMobile() });
  }

  function noEm(px, py, w) {
    const z = zoomRelativo();
    let melhor = null, melhorD = Infinity;
    for (const n of vivo.desenho.nos) {
      const p = mundoTela(n.x, n.y);
      const alcance = Math.max(raioNaTela(n.grau, n.polo, w, z), 12);
      const dx = px - p.x, dy = py - p.y, d = dx * dx + dy * dy;
      if (d <= alcance * alcance && d < melhorD) { melhor = n; melhorD = d; }
    }
    return melhor;
  }

  function localDe(ev) {
    const canvas = document.getElementById('grafo-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function aplicarListas(idsNos, idsArestas) {
    const cena = vivo.cena;
    if (!cena) return;
    const nos = idsNos ? cena.nos.filter(n => idsNos.has(n.id)) : cena.nos.slice();
    const lig = idsArestas ? cena.ligacoes.filter(e => e.id && idsArestas.has(e.id)) : cena.ligacoes.slice();
    const baldes = {
      alta: { estilo: estiloLinha('alta', false), arestas: [] },
      media: { estilo: estiloLinha('media', false), arestas: [] },
      baixa: { estilo: estiloLinha('baixa', false), arestas: [] },
      palta: { estilo: estiloLinha('alta', true), arestas: [] },
      pmedia: { estilo: estiloLinha('media', true), arestas: [] },
      pbaixa: { estilo: estiloLinha('baixa', true), arestas: [] },
    };
    for (const e of lig) {
      const chave = (e.polo ? 'p' : '') + e.confianca;
      (baldes[chave] || baldes.pbaixa).arestas.push(e);
    }
    vivo.desenho = { nos, ligacoes: lig, baldes };
    vivo.contagem = { nos: nos.length, ligacoes: lig.length };
  }

  function lerEstado() {
    try { return window.mural && window.mural.getState ? window.mural.getState() : null; }
    catch (erro) { console.warn('mapa completo: ' + (erro && erro.message || erro)); return null; }
  }

  function aplicarEstado(st, opts) {
    if (!st || !vivo.cena) return;
    aplicarListas(new Set(st.visibleNodes || []), new Set(st.visibleEdges || []));
    const sel = st.selected && st.selected.kind === 'node' ? st.selected.id : null;
    const mudou = sel !== vivo.selecionado;
    vivo.selecionado = sel;
    const camera = !(opts && opts.semCamera);
    if (camera && vivo.centroPendente && vivo.porId.has(vivo.centroPendente)) {
      const id = vivo.centroPendente;
      vivo.centroPendente = null;
      centroEm(id, { mobile: ehMobile() });
    } else if (camera && mudou && sel && !vivo.pularCentro) {
      centroEm(sel, { mobile: ehMobile() });
    }
    vivo.pularCentro = false;
    pedirQuadro();
    ajustarFocoCartoes();
  }

  function assinatura() {
    const texto = id => { const el = document.getElementById(id); return el ? el.textContent : ''; };
    const flag = id => { const el = document.getElementById(id); if (!el) return ''; return el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value; };
    const vazio = document.getElementById('empty-state');
    return [
      location.hash,
      texto('map-title'),
      texto('visible-count'),
      texto('selection-label'),
      vazio && vazio.hidden ? '1' : '0',
      ['historical-filter', 'identity-filter', 'draft-filter', 'undated-filter', 'strength-filter', 'decade-start', 'decade-end'].map(flag).join(','),
    ].join('|');
  }

  function sincronizar() {
    const agora = assinatura();
    if (agora === vivo.assinatura) return;
    vivo.assinatura = agora;
    if (vivo.carregando) { vivo.pendente = true; return; }
    const st = lerEstado();
    if (!st) return;
    if (st.view !== 'all') { desligar(); return; }
    if (!vivo.ativo) { ligar(); return; }
    aplicarEstado(st);
  }

  function agendarSync() {
    if (agendarSync.marca) return;
    agendarSync.marca = requestAnimationFrame(() => { agendarSync.marca = 0; sincronizar(); });
  }

  function estiloCritico(on) {
    const palco = document.getElementById('grafo-palco');
    const canvas = document.getElementById('grafo-canvas');
    const svg = document.getElementById('grafo-rotulos');
    const rede = document.getElementById('network');
    if (!palco || !canvas || !svg) return;
    if (on) {
      palco.hidden = false;
      palco.style.position = 'absolute';
      palco.style.inset = '0';
      palco.style.zIndex = '2';
      palco.style.touchAction = 'none';
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      canvas.style.touchAction = 'none';
      svg.style.position = 'absolute';
      svg.style.inset = '0';
      svg.style.width = '100%';
      svg.style.height = '100%';
      svg.style.pointerEvents = 'none';
      svg.style.overflow = 'visible';
      if (rede) {
        rede.style.visibility = 'visible';
        rede.style.opacity = '0';
        rede.style.pointerEvents = 'none';
        rede.style.zIndex = '4';
      }
      for (const id of ['canvas-toolbar', 'selection-toolbar', 'empty-state']) {
        const el = document.getElementById(id);
        if (el) el.style.zIndex = '6';
      }
      document.body.classList.add('grafo-on');
    } else {
      palco.hidden = true;
      palco.classList.remove('arrastando');
      if (rede) {
        rede.style.visibility = '';
        rede.style.opacity = '';
        rede.style.pointerEvents = '';
        rede.style.zIndex = '';
      }
      for (const id of ['canvas-toolbar', 'selection-toolbar', 'empty-state']) {
        const el = document.getElementById(id);
        if (el) el.style.zIndex = '';
      }
      document.body.classList.remove('grafo-on');
    }
    document.querySelectorAll('.board-footer .legend > span').forEach(span => { span.style.display = on ? 'none' : ''; });
    const leg = document.getElementById('grafo-legenda');
    if (leg) {
      if (on) { leg.hidden = false; leg.style.display = 'grid'; }
      else { leg.hidden = true; leg.style.display = ''; }
    }
  }

  function swatch(tipo) {
    const i = document.createElement('i');
    i.className = 'grafo-pt grafo-pt-' + tipo;
    i.style.display = 'inline-block';
    i.style.width = '11px';
    i.style.height = '11px';
    i.style.marginRight = '6px';
    i.style.borderRadius = '50%';
    i.style.verticalAlign = '-1px';
    i.style.background = tipo === 'polo' ? '#7a0a0a' : '#e2d6bc';
    i.style.boxShadow = 'inset 0 0 0 1.5px ' + (tipo === 'polo' ? '#f2e7d2' : '#0a0706');
    return i;
  }

  function swatchLinha(tipo) {
    const i = document.createElement('i');
    i.className = 'grafo-ln grafo-ln-' + tipo;
    const cor = tipo === 'alta' ? '#d8cbb0' : tipo === 'media' ? '#c49660' : '#b5afc4';
    i.style.display = 'inline-block';
    i.style.width = '28px';
    i.style.marginRight = '6px';
    i.style.verticalAlign = 'middle';
    i.style.borderTop = '2px ' + (tipo === 'alta' ? 'solid' : tipo === 'media' ? 'dashed' : 'dotted') + ' ' + cor;
    return i;
  }

  function montarLegenda() {
    const box = document.getElementById('grafo-legenda');
    const cena = vivo.cena;
    if (!box || !cena) return;
    const por = vivo.porId;
    box.replaceChildren();
    box.style.gridColumn = '1 / -1';
    box.style.gap = '8px 18px';
    box.style.minWidth = '0';
    box.style.maxHeight = 'min(58vh, 460px)';
    box.style.overflow = 'auto';
    box.style.color = 'var(--ink)';
    box.style.fontFamily = '"EB Garamond", Georgia, serif';
    box.style.lineHeight = '1.4';
    box.style.overflowWrap = 'anywhere';
    const estreita = ehMobile() || box.clientWidth && box.clientWidth < 420;
    box.style.gridTemplateColumns = estreita ? '1fr' : '1fr 1fr';
    box.style.fontSize = estreita ? '12px' : '14px';
    const linhaNo = (id, extra) => {
      const n = por.get(id);
      if (!n) return null;
      const li = document.createElement('li');
      li.append(swatch(n.polo ? 'polo' : 'osso'));
      li.append(document.createTextNode(n.nome + ' · ' + fmt(n.grau) + (extra || '')));
      return li;
    };
    const polos = document.createElement('ul');
    for (const item of [linhaNo('ipes', ' ligações'), linhaNo('rf', ''), linhaNo('papacy', ''), linhaNo('kochpac', ', grupo à parte')]) if (item) polos.append(item);
    const cont = contagemConfianca(cena);
    const linhas = document.createElement('ul');
    for (const [tipo, rotulo] of [['alta', 'confiança alta'], ['media', 'média'], ['baixa', 'baixa']]) {
      const li = document.createElement('li');
      li.append(swatchLinha(tipo));
      li.append(document.createTextNode(rotulo + ' · ' + fmt(cont[tipo] || 0)));
      linhas.append(li);
    }
    const nota = document.createElement('p');
    nota.className = 'grafo-nota';
    nota.style.gridColumn = '1 / -1';
    nota.style.margin = '0';
    nota.style.fontSize = estreita ? '12px' : '13px';
    nota.textContent = fmt(cena.nos.length) + ' fichas e ' + fmt(cena.ligacoes.length) + ' ligações. Posições por layout de força, sem sentido geográfico. Os grupos que não se ligam ao núcleo principal ficam em volta. O KochPAC forma um grupo à parte, à direita.';
    box.append(polos, linhas, nota);
  }

  function garantirPos() {
    if (!vivo.posPromise) {
      vivo.posPromise = fetch('mapa-completo/posicoes.json', { credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(erro => { console.warn('mapa completo: posições indisponíveis (' + (erro && erro.message || erro) + ')'); return null; });
    }
    return vivo.posPromise;
  }

  function lerDados() {
    const el = document.getElementById('research-data');
    const texto = el && el.textContent && el.textContent.trim();
    if (!texto) return null;
    try { return JSON.parse(texto); }
    catch (erro) { console.warn('mapa completo: base ilegível'); return null; }
  }

  function ligar() {
    if (vivo.ativo || vivo.carregando) return;
    vivo.carregando = true;
    const ticket = ++vivo.pedido;
    garantirPos().then(pos => {
      if (ticket !== vivo.pedido) { vivo.carregando = false; return; }
      const st = lerEstado();
      if (!st || st.view !== 'all') { vivo.carregando = false; return; }
      const dados = lerDados();
      if (!dados) { vivo.carregando = false; console.warn('mapa completo: base ainda vazia'); return; }
      vivo.cena = prepararCena(dados.nos, dados.conexoes, pos || {});
      vivo.porId = new Map(vivo.cena.nos.map(n => [n.id, n]));
      vivo.ativo = true;
      vivo.carregando = false;
      estiloCritico(true);
      montarLegenda();
      aplicarEstado(st, { semCamera: true });
      ajustarFocoCartoes();
      requestAnimationFrame(() => {
        if (!vivo.ativo) return;
        if (!calcularEnquadramento()) { enquadrar(false); return; }
        if (vivo.selecionado) centroEm(vivo.selecionado, { mobile: ehMobile() });
        else enquadrar(false);
        if (vivo.pendente || assinatura() !== vivo.assinatura) {
          vivo.pendente = false;
          vivo.assinatura = '';
          sincronizar();
        }
      });
    });
  }

  function desligar() {
    vivo.pedido += 1;
    vivo.carregando = false;
    if (!vivo.ativo) return;
    vivo.ativo = false;
    vivo.arraste = null;
    vivo.pinca = null;
    vivo.ponteiros.clear();
    estiloCritico(false);
    ajustarFocoCartoes();
    const svg = document.getElementById('grafo-rotulos');
    if (svg) svg.replaceChildren();
    vivo.rotulos.clear();
    vivo.guias.clear();
    vivo.muralCam = null;
    const leg = document.getElementById('grafo-legenda');
    if (leg) leg.replaceChildren();
  }

  function medir(texto, fs) {
    if (!vivo.medida) {
      const c = document.createElement('canvas');
      vivo.medida = c.getContext('2d');
    }
    const chave = fs.toFixed(1) + '\n' + texto;
    const ja = vivo.larguras.get(chave);
    if (ja) return ja;
    vivo.medida.font = '600 ' + fs.toFixed(1) + 'px "EB Garamond", Georgia, serif';
    const w = vivo.medida.measureText(texto).width;
    vivo.larguras.set(chave, w);
    return w;
  }

  function colide(a, lista, folga) {
    const f = folga || 0;
    for (const b of lista) {
      if (a.x < b.x + b.w + f && a.x + a.w + f > b.x && a.y < b.y + b.h + f && a.y + a.h + f > b.y) return true;
    }
    return false;
  }

  const DIRECOES = [
    { id: 'acima', ax: 0, ay: -1, anchor: 'middle' },
    { id: 'abaixo', ax: 0, ay: 1, anchor: 'middle' },
    { id: 'direita', ax: 1, ay: 0, anchor: 'start' },
    { id: 'esquerda', ax: -1, ay: 0, anchor: 'end' },
    { id: 'ne', ax: 0.72, ay: -0.72, anchor: 'start' },
    { id: 'no', ax: -0.72, ay: -0.72, anchor: 'end' },
    { id: 'se', ax: 0.72, ay: 0.72, anchor: 'start' },
    { id: 'so', ax: -0.72, ay: 0.72, anchor: 'end' },
  ];

  function montarCaixa(s, r, tw, th, fs, pad, dir, step) {
    const dist = r + 8 + step;
    const px = s.x + dir.ax * dist;
    const py = s.y + dir.ay * dist;
    let ax, ay, x, y, anchor;
    if (dir.ay < 0 && dir.anchor === 'middle') {
      anchor = 'middle';
      ax = px;
      ay = py;
      x = px - tw / 2 - pad;
      y = py - th - pad;
    } else if (dir.ay > 0 && dir.anchor === 'middle') {
      anchor = 'middle';
      ax = px;
      ay = py + fs * 0.82;
      x = px - tw / 2 - pad;
      y = py - pad;
    } else if (dir.ax >= 0) {
      anchor = 'start';
      ax = px;
      ay = py + fs * 0.32;
      x = px - pad;
      y = py - th / 2 - pad;
    } else {
      anchor = 'end';
      ax = px;
      ay = py + fs * 0.32;
      x = px - tw - pad;
      y = py - th / 2 - pad;
    }
    return { x, y, w: tw + pad * 2, h: th + pad * 2, ax, ay, anchor, dir: dir.id, step };
  }

  function deslocarParaDentro(caixa, w, h) {
    let dx = 0;
    let dy = 0;
    if (caixa.x < 2) dx = 2 - caixa.x;
    if (caixa.y < 2) dy = 2 - caixa.y;
    if (caixa.x + caixa.w > w - 2) dx = (w - 2) - (caixa.x + caixa.w);
    if (caixa.y + caixa.h > h - 2) dy = (h - 2) - (caixa.y + caixa.h);
    if (caixa.x + dx < 2 || caixa.y + dy < 2) return null;
    if (caixa.x + caixa.w + dx > w - 2 || caixa.y + caixa.h + dy > h - 2) return null;
    if (!dx && !dy) return caixa;
    return { x: caixa.x + dx, y: caixa.y + dy, w: caixa.w, h: caixa.h, ax: caixa.ax + dx, ay: caixa.ay + dy, anchor: caixa.anchor, dir: caixa.dir, step: caixa.step };
  }

  function guiaCurta(s, r, caixa) {
    const dx = caixa.ax - s.x;
    const dy = caixa.ay - s.y;
    const len = Math.hypot(dx, dy);
    const gap = len - r;
    if (!(gap > 8)) return null;
    const ux = dx / len;
    const uy = dy / len;
    const comp = Math.min(gap - 2, gap <= 40 ? gap - 2 : 22);
    if (comp < 6) return null;
    const x1 = s.x + ux * (r + 1);
    const y1 = s.y + uy * (r + 1);
    return { x1, y1, x2: x1 + ux * comp, y2: y1 + uy * comp };
  }

  function obstaculos() {
    const canvas = document.getElementById('grafo-canvas');
    if (!canvas) return [];
    const c = canvas.getBoundingClientRect();
    const caixas = [];
    for (const id of ['canvas-toolbar', 'selection-toolbar']) {
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      caixas.push({ x: r.left - c.left - 8, y: r.top - c.top - 8, w: r.width + 16, h: r.height + 16 });
    }
    return caixas;
  }

  function limiarDe(z) {
    if (z < 1.35) return 36;
    if (z < 2.2) return 22;
    if (z < 4.5) return 16;
    return 8;
  }

  function candidatosDeCaixa(s, r, tw, th, fs, pad, w, h, polo) {
    const passos = polo ? [0, 18, 36, 56, 80, 108, 140, 180] : [0, 18, 36, 56];
    const dirs = polo ? DIRECOES : DIRECOES.slice(0, 4);
    const lista = [];
    const por = caixa => {
      const dentro = deslocarParaDentro(caixa, w, h);
      if (dentro) lista.push(dentro);
    };
    for (const step of passos) {
      for (const dir of dirs) por(montarCaixa(s, r, tw, th, fs, pad, dir, step));
    }
    if (polo) {
      for (const dir of [DIRECOES[0], DIRECOES[1]]) {
        for (const step of [0, 28, 56]) {
          const base = montarCaixa(s, r, tw, th, fs, pad, dir, step);
          for (const dx of [-48, 48, -96, 96, -144, 144]) por({ ...base, x: base.x + dx, ax: base.ax + dx });
        }
      }
    }
    return lista;
  }

  function escolherRotulos(w, h) {
    const z = zoomRelativo();
    const limiar = limiarDe(z);
    const cap = z < 1.35 ? (ehMobile() ? 7 : 12) : z < 2.2 ? (ehMobile() ? 9 : 14) : z < 4.5 ? (ehMobile() ? 10 : 14) : (ehMobile() ? 16 : 22);
    const fsBase = Math.max(12, Math.min(22, 26 * w / 2400));
    const cand = [];
    for (const n of vivo.desenho.nos) {
      if (!PRIORIDADE[n.id] && n.grau < limiar) continue;
      if (z < 1.5 && !PRIORIDADE[n.id] && (n.nome.startsWith('The Susan') || n.nome.startsWith('Project MK'))) continue;
      cand.push(n);
    }
    cand.sort((a, b) => (PRIORIDADE[b.id] || 0) - (PRIORIDADE[a.id] || 0) || b.grau - a.grau || (a.id < b.id ? -1 : 1));
    const ocupados = obstaculos();
    const postos = [];
    const pad = 5;
    const publicar = (n, texto, fs, caixa, s, r) => {
      const deslocado = caixa.step > 0 || caixa.dir !== 'acima';
      ocupados.push(caixa);
      postos.push({
        id: n.id,
        texto,
        nome: n.nome,
        fs,
        x: caixa.ax,
        y: caixa.ay,
        anchor: caixa.anchor,
        fill: n.polo ? '#f2e7d2' : '#ede3cd',
        polo: n.polo,
        guia: deslocado ? guiaCurta(s, r, caixa) : null,
      });
    };
    for (const n of cand) {
      const polo = !!POLOS[n.id];
      if (postos.length >= cap && !PRIORIDADE[n.id]) continue;
      const s = mundoTela(n.x, n.y);
      if (!polo && (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40)) continue;
      if (polo && (s.x < -w || s.y < -h || s.x > w * 2 || s.y > h * 2)) continue;
      const r = Math.max(raioNaTela(n.grau, n.polo, w, z), 1);
      let fs = Math.max(12, fsBase * (n.polo ? 1.2 : 1));
      const texto = n.curto || n.id;
      let tw = Math.max(8, medir(texto, fs));
      const teto = Math.max(96, w * (ehMobile() ? 0.52 : 0.36));
      if (tw > teto) {
        fs = Math.max(12, fs * teto / tw);
        tw = Math.max(8, medir(texto, fs));
      }
      const th = fs * 1.25;
      const opcoes = candidatosDeCaixa(s, r, tw, th, fs, pad, w, h, polo);
      let caixa = null;
      for (const b of opcoes) {
        if (!colide(b, ocupados, 1)) { caixa = b; break; }
      }
      if (!caixa && polo) {
        // Barra de zoom pode ceder; outro polo, não. Grau menor nem chegou a entrar.
        const soPolos = ocupados.filter(b => b.polo);
        for (const b of opcoes) {
          if (!colide(b, soPolos, 1)) { caixa = b; break; }
        }
      }
      if (!caixa) continue;
      caixa.polo = polo;
      caixa.id = n.id;
      publicar(n, texto, fs, caixa, s, r);
    }
    return postos;
  }

  function sincronizarRotulos(itens) {
    const svg = document.getElementById('grafo-rotulos');
    if (!svg) return;
    const vistos = new Set();
    for (const item of itens) {
      vistos.add(item.id);
      let linha = vivo.guias.get(item.id);
      if (item.guia) {
        if (!linha) {
          linha = document.createElementNS(SVG, 'line');
          linha.setAttribute('class', 'grafo-guia');
          linha.setAttribute('data-grafo-guia', item.id);
          vivo.guias.set(item.id, linha);
        }
        if (linha.parentNode !== svg) svg.insertBefore(linha, svg.firstChild);
        linha.setAttribute('x1', item.guia.x1.toFixed(1));
        linha.setAttribute('y1', item.guia.y1.toFixed(1));
        linha.setAttribute('x2', item.guia.x2.toFixed(1));
        linha.setAttribute('y2', item.guia.y2.toFixed(1));
      } else if (linha && linha.parentNode) linha.remove();
      let el = vivo.rotulos.get(item.id);
      if (!el) {
        el = document.createElementNS(SVG, 'text');
        el.setAttribute('data-grafo-no', item.id);
        el.setAttribute('text-anchor', 'middle');
        el.setAttribute('font-family', 'EB Garamond, Georgia, serif');
        el.setAttribute('font-weight', '600');
        el.setAttribute('stroke', '#0a0706');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('paint-order', 'stroke');
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.addEventListener('keydown', ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          const id = ev.currentTarget.getAttribute('data-grafo-no');
          if (ev.key === 'Enter' && ev.shiftKey) expandir(id);
          else toqueNo(id);
        });
        el.addEventListener('focus', () => { vivo.focoId = el.getAttribute('data-grafo-no'); pedirQuadro(); });
        el.addEventListener('blur', () => { if (vivo.focoId === el.getAttribute('data-grafo-no')) { vivo.focoId = null; pedirQuadro(); } });
        vivo.rotulos.set(item.id, el);
      }
      if (el.parentNode !== svg) svg.appendChild(el);
      if (el.textContent !== item.texto) el.textContent = item.texto;
      el.setAttribute('text-anchor', item.anchor || 'middle');
      el.setAttribute('x', item.x.toFixed(1));
      el.setAttribute('y', item.y.toFixed(1));
      el.setAttribute('font-size', item.fs.toFixed(1));
      el.setAttribute('fill', item.fill);
      el.setAttribute('stroke-width', (item.fs / 4).toFixed(2));
      el.setAttribute('aria-label', item.nome);
      if (item.polo) el.setAttribute('data-polo', '1');
      else el.removeAttribute('data-polo');
    }
    for (const [id, el] of vivo.rotulos) if (!vistos.has(id) && el.parentNode) el.remove();
    for (const [id, linha] of vivo.guias) if (!vistos.has(id) && linha.parentNode) linha.remove();
  }

  function pintarFundo(ctx, w, h, dpr) {
    const chave = w + 'x' + h + '@' + dpr;
    if (chave !== vivo.fundoChave) {
      const fora = document.createElement('canvas');
      fora.width = Math.max(1, Math.round(w * dpr));
      fora.height = Math.max(1, Math.round(h * dpr));
      const g = fora.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rad = g.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
      rad.addColorStop(0, '#1b1410');
      rad.addColorStop(0.6, '#0d0907');
      rad.addColorStop(1, '#050302');
      g.fillStyle = rad;
      g.fillRect(0, 0, w, h);
      vivo.fundo = fora;
      vivo.fundoChave = chave;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(vivo.fundo, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tracar(ctx, lista, estilo, pred, alpha, w, h, lw) {
    if (!lista.length) return;
    ctx.beginPath();
    let n = 0;
    const k = vivo.cam.k, ox = vivo.cam.x, oy = vivo.cam.y;
    for (const e of lista) {
      if (pred && !pred(e)) continue;
      const a = vivo.porId.get(e.origem), b = vivo.porId.get(e.destino);
      if (!a || !b) continue;
      const x1 = a.x * k + ox, y1 = a.y * k + oy, x2 = b.x * k + ox, y2 = b.y * k + oy;
      if ((x1 < -30 && x2 < -30) || (y1 < -30 && y2 < -30) || (x1 > w + 30 && x2 > w + 30) || (y1 > h + 30 && y2 > h + 30)) continue;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      n += 1;
    }
    if (!n) return;
    ctx.strokeStyle = estilo.cor;
    ctx.globalAlpha = estilo.opacidade * alpha;
    ctx.lineWidth = lw;
    ctx.setLineDash(estilo.traco);
    ctx.stroke();
  }

  function lerCameraMural() {
    const vp = document.getElementById('viewport');
    const base = vp && vp.transform && vp.transform.baseVal;
    if (!base || !base.numberOfItems) return null;
    const t = base.getItem(0).matrix;
    // translate(x y) scale(k): a escala é o segundo item. O primeiro só translada.
    const escala = base.numberOfItems > 1 ? base.getItem(1).matrix.a : t.a;
    return { x: t.e, y: t.f, k: escala > 0 ? escala : 1 };
  }

  function focoNoGrafo(fx, fy) {
    const canvas = document.getElementById('grafo-canvas');
    const rede = document.getElementById('network');
    if (!canvas || !rede) return { x: fx, y: fy };
    const c = canvas.getBoundingClientRect();
    const n = rede.getBoundingClientRect();
    return { x: fx + (n.left - c.left), y: fy + (n.top - c.top) };
  }

  // O mural é a fonte do gesto (roda e pinça, inclusive sobre o cartão).
  // O grafo aplica a mesma semelhança na tela: fator de escala e translação.
  function espelharCameraMural(aplicar) {
    const atual = lerCameraMural();
    if (!atual) return false;
    const prev = vivo.muralCam;
    vivo.muralCam = atual;
    if (!aplicar || !prev || !(prev.k > 0)) return false;
    const real = atual.k / prev.k;
    if (Math.abs(real - 1) > 1e-4) {
      const den = 1 - real;
      const fx = (atual.x - prev.x * real) / den;
      const fy = (atual.y - prev.y * real) / den;
      const foco = focoNoGrafo(fx, fy);
      const antes = vivo.cam.k || 1;
      const nk = limitarZoom(antes * real);
      const aplicado = nk / antes;
      if (!(aplicado > 0) || !Number.isFinite(foco.x) || !Number.isFinite(foco.y)) return false;
      vivo.cam.x = foco.x - (foco.x - vivo.cam.x) * aplicado;
      vivo.cam.y = foco.y - (foco.y - vivo.cam.y) * aplicado;
      vivo.cam.k = nk;
      atualizarZoomTexto();
      return true;
    }
    const dx = atual.x - prev.x, dy = atual.y - prev.y;
    if (!dx && !dy) return false;
    vivo.cam.x += dx;
    vivo.cam.y += dy;
    return true;
  }

  function agendarEspelho() {
    espelharCameraMural(false);
    requestAnimationFrame(() => {
      if (!vivo.ativo) return;
      if (espelharCameraMural(true)) pedirQuadro();
    });
  }

  let encaminhando = false;

  function protegerCaptura(rede) {
    if (!rede || rede.dataset.grafoCaptura) return;
    rede.dataset.grafoCaptura = '1';
    const orig = rede.setPointerCapture.bind(rede);
    rede.setPointerCapture = function (id) {
      // Gesto nascido no palco: a captura no mural roubaria o ponteiro
      // e o palco deixaria de encaminhar o resto do gesto.
      if (vivo.ativo && vivo.ponteiros.has(id)) return;
      return orig(id);
    };
  }

  function encaminharRede(ev) {
    const rede = document.getElementById('network');
    if (!rede || encaminhando) return;
    encaminhando = true;
    try {
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: ev.clientX,
        clientY: ev.clientY,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
      };
      let evento;
      if (ev.type === 'wheel') {
        evento = new WheelEvent('wheel', {
          ...init,
          deltaX: ev.deltaX,
          deltaY: ev.deltaY,
          deltaZ: ev.deltaZ,
          deltaMode: ev.deltaMode,
        });
      } else {
        evento = new PointerEvent(ev.type, {
          ...init,
          pointerId: ev.pointerId,
          pointerType: ev.pointerType || 'mouse',
          button: ev.button,
          buttons: ev.buttons,
          isPrimary: ev.isPrimary !== false,
        });
      }
      rede.dispatchEvent(evento);
    } catch { /* o mural segue com o gesto que já recebeu */ }
    finally { encaminhando = false; }
  }

  function limparToqueDuplo() {
    vivo.ultimoNo = null;
    vivo.ultimoQuando = 0;
  }

  function ajustarFocoCartoes() {
    const camada = document.getElementById('node-layer');
    if (!camada) return;
    const ligado = vivo.ativo;
    for (const no of camada.querySelectorAll('.network-node')) {
      const esconder = ligado && !no.classList.contains('selected');
      if (esconder) {
        if (!no.hasAttribute('data-grafo-tab')) no.setAttribute('data-grafo-tab', no.getAttribute('tabindex') ?? '0');
        if (no.getAttribute('tabindex') !== '-1') no.setAttribute('tabindex', '-1');
        if (no.getAttribute('aria-hidden') !== 'true') no.setAttribute('aria-hidden', 'true');
        if (!no.hasAttribute('inert')) no.setAttribute('inert', '');
      } else if (no.hasAttribute('data-grafo-tab')) {
        no.setAttribute('tabindex', no.getAttribute('data-grafo-tab') || '0');
        no.removeAttribute('data-grafo-tab');
        no.removeAttribute('aria-hidden');
        no.removeAttribute('inert');
      }
    }
  }

  function desenhar() {
    const t0 = performance.now();
    const canvas = document.getElementById('grafo-canvas');
    if (!canvas || !vivo.cena || !vivo.ativo) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, w >= 900 ? 2 : 3);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    pintarFundo(ctx, w, h, dpr);
    ctx.lineCap = 'round';
    const z = zoomRelativo();
    const lw = Math.max(0.6, Math.min(1.1, 0.72 * Math.min(1.45, Math.max(0.9, z))));
    const sel = vivo.selecionado || vivo.focoId;
    const ordem = ['alta', 'media', 'baixa', 'palta', 'pmedia', 'pbaixa'];
    const baldes = vivo.desenho.baldes;
    if (baldes) {
      for (const nome of ordem) {
        const b = baldes[nome];
        tracar(ctx, b.arestas, b.estilo, sel ? e => e.origem !== sel && e.destino !== sel : null, sel ? 0.35 : 1, w, h, lw);
      }
      if (sel) {
        for (const nome of ordem) {
          const b = baldes[nome];
          tracar(ctx, b.arestas, { cor: '#c43a30', opacidade: 0.95, traco: b.estilo.traco }, e => e.origem === sel || e.destino === sel, 1, w, h, lw);
        }
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#e2d6bc';
    ctx.beginPath();
    const polos = [];
    let ossos = 0;
    for (const n of vivo.desenho.nos) {
      const p = mundoTela(n.x, n.y);
      const r = raioNaTela(n.grau, n.polo, w, z);
      if (p.x < -r || p.y < -r || p.x > w + r || p.y > h + r) continue;
      if (n.polo) { polos.push({ n, x: p.x, y: p.y, r }); continue; }
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, Math.max(r, 0.4), 0, Math.PI * 2);
      ossos += 1;
    }
    if (ossos) {
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#0a0706';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const lwPolo = Math.max(1, 2.56 * (w / 2400) * z);
    for (const p of polos) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(p.r, 0.6), 0, Math.PI * 2);
      ctx.fillStyle = '#7a0a0a';
      ctx.fill();
      ctx.strokeStyle = '#f2e7d2';
      ctx.lineWidth = lwPolo;
      ctx.stroke();
    }
    if (sel && vivo.porId.has(sel)) {
      const n = vivo.porId.get(sel);
      const visivel = vivo.desenho.nos.some(item => item.id === sel);
      if (visivel) {
        const p = mundoTela(n.x, n.y);
        const r = raioNaTela(n.grau, n.polo, w, z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#f2e7d2';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    sincronizarRotulos(escolherRotulos(w, h));
    registrarQuadro(performance.now() - t0);
    atualizarZoomTexto();
  }

  function instalar() {
    if (vivo.instalado) return;
    vivo.instalado = true;
    const palco = document.getElementById('grafo-palco');
    const canvas = document.getElementById('grafo-canvas');
    if (!palco || !canvas) return;
    canvas.setAttribute('aria-hidden', 'true');
    const svg = document.getElementById('grafo-rotulos');
    if (svg) svg.setAttribute('aria-label', 'Rótulos do mapa completo');

    const envolver = (id, fn) => {
      const botao = document.getElementById(id);
      if (!botao || botao.dataset.grafoWrap) return;
      const prev = botao.onclick;
      botao.dataset.grafoWrap = '1';
      botao.onclick = ev => {
        if (vivo.ativo) { fn(ev); return; }
        if (typeof prev === 'function') return prev.call(botao, ev);
      };
    };
    envolver('zoom-in', () => zoomCentro(1.25));
    envolver('zoom-out', () => zoomCentro(0.8));
    envolver('fit', () => enquadrar(true));

    // A roda no palco não passa pelo #network (o cartão, sim). Os dois
    // caminhos atualizam o mural; o grafo só espelha escala e translação.
    palco.addEventListener('wheel', ev => {
      if (!vivo.ativo) return;
      ev.preventDefault();
      ev.stopPropagation();
      encaminharRede(ev);
    }, { passive: false });

    const rede = document.getElementById('network');
    protegerCaptura(rede);
    if (rede) {
      rede.addEventListener('wheel', () => {
        if (!vivo.ativo) return;
        agendarEspelho();
      }, { passive: true });
    }

    palco.addEventListener('pointerdown', ev => {
      if (!vivo.ativo || (ev.button && ev.button !== 0)) return;
      const p = localDe(ev);
      vivo.ponteiros.set(ev.pointerId, p);
      try { palco.setPointerCapture(ev.pointerId); } catch { /* captura é opcional */ }
      encaminharRede(ev);
      if (vivo.ponteiros.size >= 2) {
        vivo.arraste = null;
        vivo.pinca = null;
        return;
      }
      vivo.arraste = { id: ev.pointerId, x: p.x, y: p.y, moved: false, no: noEm(p.x, p.y, canvas.clientWidth) };
    });
    palco.addEventListener('pointermove', ev => {
      if (!vivo.ativo || !vivo.ponteiros.has(ev.pointerId)) return;
      const p = localDe(ev);
      vivo.ponteiros.set(ev.pointerId, p);
      encaminharRede(ev);
      const g = vivo.arraste;
      if (!g || g.id !== ev.pointerId) return;
      const dx = p.x - g.x, dy = p.y - g.y;
      if (dx * dx + dy * dy > 16) {
        g.moved = true;
        palco.classList.add('arrastando');
        limparToqueDuplo();
      }
    });
    const fim = ev => {
      const cancelou = ev.type === 'pointercancel';
      vivo.ponteiros.delete(ev.pointerId);
      if (vivo.ponteiros.size < 2) vivo.pinca = null;
      encaminharRede(ev);
      if (cancelou) limparToqueDuplo();
      const g = vivo.arraste;
      if (!g || g.id !== ev.pointerId) return;
      vivo.arraste = null;
      palco.classList.remove('arrastando');
      if (cancelou || g.moved || !g.no) {
        limparToqueDuplo();
        return;
      }
      toqueNo(g.no.id);
    };
    palco.addEventListener('pointerup', fim);
    palco.addEventListener('pointercancel', fim);
    palco.addEventListener('dblclick', ev => {
      if (!vivo.ativo) return;
      const p = localDe(ev);
      const n = noEm(p.x, p.y, canvas.clientWidth);
      if (!n) return;
      const agora = Date.now();
      if (agora - vivo.ultimoExpandiu < 500) return;
      vivo.ultimoExpandiu = agora;
      expandir(n.id);
    });

    // A linha de base acompanha o mural no pointerdown, antes do arrasto.
    // O pointermove lê o transform no quadro seguinte: o mural só grava a
    // câmera no rAF, e no capture este listener via a câmera do evento anterior.
    // Sem botão não aplica o delta — seleção e enquadrar não podem saltar o grafo.
    document.addEventListener('pointerdown', () => {
      if (!vivo.ativo) return;
      espelharCameraMural(false);
    }, false);
    document.addEventListener('pointermove', ev => {
      if (!vivo.ativo) return;
      // Toque não traz o botão primário em todo navegador. A pinça no cartão
      // precisa espelhar mesmo assim; o mouse sem botão continua só atualizando a base.
      const aplicar = (ev.buttons & 1) === 1 || ev.pointerType === 'touch';
      requestAnimationFrame(() => {
        if (!vivo.ativo) return;
        if (espelharCameraMural(aplicar)) pedirQuadro();
      });
    }, false);

    document.addEventListener('pointerup', ev => {
      if (!vivo.ativo || !vivo.ultimoNo) return;
      if (ev.button && ev.button !== 0) return;
      if (!ev.target.closest || !ev.target.closest('#inspector') || ev.target.closest('#sheet-handle')) return;
      const agora = Date.now();
      if (agora - vivo.ultimoQuando >= 500 || agora - vivo.ultimoExpandiu < 500) return;
      const id = vivo.ultimoNo;
      vivo.ultimoExpandiu = agora;
      vivo.ultimoNo = null;
      expandir(id);
    }, true);

    document.addEventListener('click', ev => {
      if (!vivo.ativo) return;
      const el = ev.target.closest && ev.target.closest('[data-result], [data-entity]');
      if (!el) return;
      const id = el.getAttribute('data-result') || el.getAttribute('data-entity');
      if (id) vivo.centroPendente = id;
    }, true);

    document.addEventListener('keydown', ev => {
      if (!vivo.ativo || ev.key !== 'Home' || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const alvo = ev.target;
      if (!alvo || !alvo.closest) return;
      if (alvo.closest('#inspector')) return;
      if (alvo.matches && alvo.matches('input, textarea, select')) return;
      ev.preventDefault();
      ev.stopPropagation();
      enquadrar(true);
    }, true);

    const camadaCartoes = document.getElementById('node-layer');
    if (camadaCartoes && !vivo.obsCartoes) {
      vivo.obsCartoes = new MutationObserver(() => { if (vivo.ativo) ajustarFocoCartoes(); });
      vivo.obsCartoes.observe(camadaCartoes, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('hashchange', agendarSync);
    const obs = new MutationObserver(agendarSync);
    for (const id of ['map-title', 'visible-count', 'selection-label', 'map-subtitle']) {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { childList: true, characterData: true, subtree: true });
    }
    const vazio = document.getElementById('empty-state');
    if (vazio) obs.observe(vazio, { attributes: true, attributeFilter: ['hidden'] });
    for (const id of ['historical-filter', 'identity-filter', 'draft-filter', 'undated-filter', 'strength-filter', 'decade-start', 'decade-end']) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', agendarSync);
    }
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl) {
      new MutationObserver(() => { if (vivo.ativo) atualizarZoomTexto(); }).observe(zoomEl, { childList: true, characterData: true, subtree: true });
    }
    const caixa = document.getElementById('canvas-wrap');
    if (caixa && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (!vivo.ativo) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (w < 2 || h < 2) return;
        const wx = (w / 2 - vivo.cam.x) / vivo.cam.k;
        const wy = (h / 2 - vivo.cam.y) / vivo.cam.k;
        const z = zoomRelativo();
        if (!calcularEnquadramento()) return;
        vivo.cam.k = limitarZoom(vivo.kFit * z);
        vivo.cam.x = w / 2 - wx * vivo.cam.k;
        vivo.cam.y = h / 2 - wy * vivo.cam.k;
        montarLegenda();
        pedirQuadro();
      }).observe(caixa);
    }
    setInterval(sincronizar, 1000);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { vivo.larguras.clear(); if (vivo.ativo) pedirQuadro(); });
  }

  function montar() {
    if (vivo.montado || typeof document === 'undefined') return;
    if (!document.getElementById('grafo-palco')) return;
    const inicio = Date.now();
    const tentar = () => {
      if (window.mural && typeof window.mural.getState === 'function') {
        vivo.montado = true;
        instalar();
        sincronizar();
        return;
      }
      if (Date.now() - inicio < 30000) setTimeout(tentar, 40);
    };
    tentar();
  }

  function caixasVisiveis() {
    if (typeof document === 'undefined') return [];
    const svg = document.getElementById('grafo-rotulos');
    if (!svg) return [];
    const lista = [];
    for (const el of svg.querySelectorAll('text[data-grafo-no]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      lista.push({
        id: el.getAttribute('data-grafo-no'),
        polo: el.getAttribute('data-polo') === '1',
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
      });
    }
    return lista;
  }

  if (typeof document !== 'undefined') {
    const alvo = typeof window !== 'undefined' ? window : globalThis;
    alvo.__grafo = {
      caixas: caixasVisiveis,
      zoom: zoomRelativo,
      quadro: () => ({ ultimo: vivo.ultimo, media: vivo.media }),
    };
  }

  return {
    grauDe,
    raioDoGrau,
    raioNaTela,
    ehPolo,
    estiloNo,
    estiloLinha,
    nomeCurto,
    normalizarConfianca,
    prepararCena,
    contagemConfianca,
    contagemDesenhada,
    limparMedicao,
    enquadrar: animar => enquadrar(animar !== false),
    zoom: zoomCentro,
    centroEm: id => centroEm(id, { mobile: ehMobile() }),
    pontoNaTela,
    montar,
    get ativo() { return vivo.ativo; },
    get ultimoQuadroMs() { return vivo.ultimo; },
    get mediaQuadroMs() { return vivo.media; },
  };
});
