// SPLIT1: index sem a base embutida; o mural busca dados-nucleo.json e, em idle, dados-extensao.json.
// Cobre: tetos por parte, versão = conteúdo, união = arquivo único, caminhos locais,
// e no Chromium: sucesso com extensão, erro de rede do núcleo, e núcleo sem extensão
// (painel em carregamento, erro com tentar de novo, busca parcial avisada).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { describe, test, before, after } = require('node:test');
const { dataRef, mergeParts, stableStringify } = require('./dados_site.cjs');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ref = dataRef(html);
const nucleoFile = ref.src ? path.join(root, ref.src.split('?')[0]) : null;
const extFile = ref.extSrc ? path.join(root, ref.extSrc.split('?')[0]) : null;
const nucleoRaw = nucleoFile ? fs.readFileSync(nucleoFile) : null;
const extRaw = extFile ? fs.readFileSync(extFile) : null;
const unionObj = (nucleoRaw && extRaw)
  ? mergeParts(JSON.parse(nucleoRaw.toString('utf8')), JSON.parse(extRaw.toString('utf8')))
  : null;
const unionRaw = unionObj ? Buffer.from(stableStringify(unionObj), 'utf8') : null;

const MAX_INDEX_BYTES = 400_000;
const MAX_INDEX_GZIP_BYTES = 120_000;
const MAX_DATA_BYTES = 2_600_000;
const MAX_DATA_GZIP_BYTES = 520_000;
const gz = buffer => zlib.gzipSync(buffer, { level: 9 }).length;

test('index aponta para núcleo e extensão relativos e não embute a base', () => {
  assert.ok(ref.src, 'data-src ausente');
  assert.ok(ref.extSrc, 'data-ext-src ausente');
  assert.equal(ref.embedded, '');
  assert.match(ref.src, /^dados-nucleo\.json\?v=[0-9a-f]{12}$/);
  assert.match(ref.extSrc, /^dados-extensao\.json\?v=[0-9a-f]{12}$/);
  assert.doesNotMatch(ref.src, /^(?:\/|[a-z]+:)/, 'caminho do núcleo precisa ser relativo');
  assert.doesNotMatch(ref.extSrc, /^(?:\/|[a-z]+:)/, 'caminho da extensão precisa ser relativo');
  assert.ok(fs.existsSync(nucleoFile), 'dados-nucleo.json ausente ao lado do index');
  assert.ok(fs.existsSync(extFile), 'dados-extensao.json ausente ao lado do index');
});

test('versão, sha256 e contagens batem com núcleo, extensão e união', () => {
  const nucleoSha = crypto.createHash('sha256').update(nucleoRaw).digest('hex');
  const extSha = crypto.createHash('sha256').update(extRaw).digest('hex');
  const unionSha = crypto.createHash('sha256').update(unionRaw).digest('hex');
  assert.equal(ref.sha256, nucleoSha);
  assert.equal(ref.src, 'dados-nucleo.json?v=' + nucleoSha.slice(0, 12));
  assert.equal(ref.extSha256, extSha);
  assert.equal(ref.extSrc, 'dados-extensao.json?v=' + extSha.slice(0, 12));
  assert.equal(ref.unionSha256, unionSha);
  const nucleo = JSON.parse(nucleoRaw.toString('utf8'));
  const ext = JSON.parse(extRaw.toString('utf8'));
  assert.equal(ref.counts.nucleo.nos, String(nucleo.nos.length));
  assert.equal(ref.counts.nucleo.conexoes, String(nucleo.conexoes.length));
  assert.equal(ref.counts.nucleo.fontes, String(nucleo.fontes.length));
  assert.equal(ref.counts.nucleo.casos, String(nucleo.casos.length));
  assert.equal(ref.counts.extensao.nos, String((ext.nos || []).length));
  assert.equal(ref.counts.extensao.conexoes, String((ext.conexoes || []).length));
  assert.equal(ref.counts.extensao.fontes, String((ext.fontes || []).length));
  assert.equal(ref.counts.extensao.casos, String((ext.casos || []).length));
});

test('tetos de tamanho: index e cada parte, bruto e gzip', () => {
  const index = Buffer.from(html, 'utf8');
  assert.ok(index.length <= MAX_INDEX_BYTES, `index ${index.length} > ${MAX_INDEX_BYTES}`);
  assert.ok(gz(index) <= MAX_INDEX_GZIP_BYTES, `index gzip ${gz(index)} > ${MAX_INDEX_GZIP_BYTES}`);
  for (const [name, raw] of [['dados-nucleo.json', nucleoRaw], ['dados-extensao.json', extRaw]]) {
    assert.ok(raw.length <= MAX_DATA_BYTES, `${name} ${raw.length} > ${MAX_DATA_BYTES}`);
    assert.ok(gz(raw) <= MAX_DATA_GZIP_BYTES, `${name} gzip ${gz(raw)} > ${MAX_DATA_GZIP_BYTES}`);
  }
});

test('nenhum caminho local no index nem nas partes', () => {
  for (const [name, raw] of [['index.html', html], ['dados-nucleo.json', nucleoRaw.toString('utf8')], ['dados-extensao.json', extRaw.toString('utf8')]]) {
    const text = raw.replace(/https?:\/\/[^\s"'<>\\]+/g, '');
    for (const mark of ['/Users/', '/workspace/', '/home/']) {
      assert.equal(text.indexOf(mark), -1, `${mark} em ${name}`);
    }
  }
});

test('união de núcleo e extensão passa no validateBase do mural', () => {
  const data = unionObj;
  assert.deepEqual(Object.keys(data).sort(), ['casos', 'conexoes', 'fontes', 'nos', 'titulo', 'versao']);
  const script = html.match(/<script>\s*(\(function mural\(\) \{[\s\S]*?)<\/script>/)[1];
  const cut = script.indexOf("  const network=$('network');");
  assert.ok(cut > 0);
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false, style: { removeProperty() {} }, dataset: {}, querySelectorAll: () => [], classList: { add() {}, remove() {} } }); return elements.get(id); };
  element('research-data').textContent = stableStringify(data);
  element('research-views').textContent = '[]';
  const context = vm.createContext({ document: { getElementById: element }, localStorage: { getItem: () => null }, URL, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(script.slice(0, cut) + '  globalThis.api={validateBase,counts:()=>[nodes.size,edges.size,sources.size],load:()=>{work=fresh();rebuild();}};\n})();', context);
  context.api.validateBase(vm.runInContext('JSON.parse(' + JSON.stringify(stableStringify(data)) + ')', context));
  context.api.load();
  assert.deepEqual(Array.from(context.api.counts()), [data.nos.length, data.conexoes.length, data.fontes.length]);
});

const BUILD3_TOP = new Set(['casos', 'conexoes', 'fontes', 'nos', 'titulo', 'versao']);
const BUILD3_NO = new Set(['id', 'nome', 'nota', 'nucleo', 'tipo', 'rascunho', 'recorte_pesquisa', 'edicao_local']);
const BUILD3_CONEXAO = new Set([
  'id', 'origem', 'destino', 'tipo', 'estado', 'intensidade', 'confianca',
  'periodo', 'inicio', 'fim', 'afirmacao', 'limite', 'fontes',
  'localizadores_fontes', 'recorte_pesquisa', 'rascunho', 'caso_id',
]);
const BUILD3_FONTE = new Set([
  'id', 'titulo', 'url', 'tipo', 'editor', 'localizador', 'acesso', 'recorte_pesquisa',
]);
const PRIVATE_EXPOSURE = new Set([
  'pendencias', 'revisao_pm', 'notas_internas', 'nota_interna', 'notas internas',
  'base_ref_arquivo', 'arquivo_local', 'caminho_local', 'local_path',
  'password', 'senha', 'secret', 'token', 'api_key', 'apikey',
]);

function walkKeys(obj, visit) {
  if (Array.isArray(obj)) obj.forEach(item => walkKeys(item, visit));
  else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      visit(key, obj);
      walkKeys(value, visit);
    }
  }
}

test('união só usa chaves da base enxuta da BUILD3 (nós, conexões, fontes, casos)', () => {
  const data = unionObj;
  assert.deepEqual(new Set(Object.keys(data)), BUILD3_TOP);
  for (const node of data.nos) {
    for (const key of Object.keys(node)) assert.ok(BUILD3_NO.has(key), `nó ${node.id}: ${key}`);
  }
  for (const edge of data.conexoes) {
    for (const key of Object.keys(edge)) assert.ok(BUILD3_CONEXAO.has(key), `conexão ${edge.id}: ${key}`);
    assert.ok(!('nota' in edge), `nota de conexão em ${edge.id}`);
  }
  for (const source of data.fontes) {
    for (const key of Object.keys(source)) assert.ok(BUILD3_FONTE.has(key), `fonte ${source.id}: ${key}`);
  }
  for (const caso of data.casos) {
    assert.ok(!('recorte' in caso), `caso ${caso.id} com recorte`);
  }
  const baseFile = path.join(root, '..', 'pesquisa', 'dados', 'base-investigativa.json');
  assert.ok(fs.existsSync(baseFile), 'base da pesquisa ausente: ' + baseFile);
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  // HOTFIX-TEXT1 (c), PUB-PROPOSTA-INTERNA: fonte do tipo proposta_interna fica na base, fora do público.
  const publicos = k => (k === 'fontes' ? base[k].filter(f => f.tipo !== 'proposta_interna') : base[k]);
  for (const k of ['nos', 'conexoes', 'fontes', 'casos']) {
    assert.ok(Array.isArray(base[k]) && base[k].length > 0, 'base sem ' + k);
    assert.equal(data[k].length, publicos(k).length, 'contagem de ' + k + ' difere da base');
  }
  assert.ok(!data.fontes.some(f => f.tipo === 'proposta_interna'), 'fonte proposta_interna no público');
});

test('união não expõe campos privados nem caminhos locais fora de URL', () => {
  const data = unionObj;
  const privateHits = [];
  walkKeys(data, (key, obj) => {
    if (PRIVATE_EXPOSURE.has(key) || PRIVATE_EXPOSURE.has(key.toLowerCase())) {
      privateHits.push(`${obj.id || '?'} .${key}`);
    }
  });
  assert.deepEqual(privateHits, [], `campos privados: ${privateHits.slice(0, 10)}`);

  const pathHits = [];
  const urlRe = /https?:\/\/[^\s"'<>\\]*/gi;
  const visit = (value, path) => {
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${item && item.id ? item.id : i}]`));
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    } else if (typeof value === 'string') {
      const stripped = value.replace(urlRe, '');
      for (const mark of ['/Users/', '/workspace/', '/home/']) {
        if (stripped.includes(mark)) pathHits.push(`${path}: ${mark}`);
      }
    }
  };
  visit(data, '$');
  assert.deepEqual(pathHits, [], `caminho local fora de URL: ${pathHits.slice(0, 10)}`);
});

describe('carregamento de núcleo e extensão no Chromium', { timeout: 180000 }, () => {
  const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  let server, browser, origin;
  const hits = [];

  before(async () => {
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        hits.push(url.pathname + url.search);
        const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
        const body = await fs.promises.readFile(file);
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function open(routes = {}, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], nucleoAttempts = [], extAttempts = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'globalThis.ATLAS_PUBLIC_CONFIG={supabaseUrl:"https://fixture.supabase.co",supabaseAnonKey:"public-test-placeholder"};' });
      if (url.pathname === '/dados-nucleo.json') {
        nucleoAttempts.push(url.search);
        if (routes.nucleo) return routes.nucleo(route, nucleoAttempts.length);
      }
      if (url.pathname === '/dados-extensao.json') {
        extAttempts.push(url.search);
        if (routes.ext) return routes.ext(route, extAttempts.length);
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/');
    return { page, context, errors, nucleoAttempts, extAttempts };
  }
  const mapReady = page => page.waitForFunction(() => !!window.mural && document.querySelectorAll('#node-layer .network-node').length > 0, null, { timeout: 30000 });
  const extReady = page => page.waitForFunction(() => window.mural?.getState().extensionStatus === 'ready', null, { timeout: 30000 });
  const statusOf = page => page.evaluate(() => { const s = document.getElementById('data-status'); return { hidden: s.hidden, state: s.dataset.state, text: s.innerText, retry: !document.getElementById('data-retry').hidden }; });

  test('sucesso: núcleo monta o mapa, a extensão chega em idle e o inspetor mostra afirmação com limite', async () => {
    const { page, context, errors, nucleoAttempts, extAttempts } = await open();
    await mapReady(page);
    assert.deepEqual(nucleoAttempts, ['?v=' + ref.sha256.slice(0, 12)]);
    assert.equal((await statusOf(page)).hidden, true);
    assert.equal(await page.evaluate(() => window.mural.getState().extensionStatus !== 'ready' ? window.mural.getState().extensionStatus : 'ready-or-pending'), await page.evaluate(() => window.mural.getState().extensionStatus));
    await extReady(page);
    assert.ok(extAttempts.length >= 1);
    assert.match(extAttempts[0], /^\?v=/);
    await page.evaluate(() => { location.hash = 'e=maua'; });
    await page.waitForFunction(() => window.mural.getState().selected?.id === 'maua' && window.mural.getState().inspectorOpen);
    // painel de entidade: nota já pode aparecer; abra uma ligação
    await page.locator('#inspector [data-relation]').first().click();
    await page.waitForFunction(() => window.mural.getState().selected?.kind === 'edge');
    const body = await page.locator('#inspector-content').innerText();
    assert.equal(await page.locator('#ext-status').count(), 0);
    assert.match(body, /FONTES E DOCUMENTOS|Fonte|http/);
    assert.doesNotMatch(body, /Carregando documentação complementar/);
    await page.fill('#search', 'trusts');
    await page.waitForFunction(() => !document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-result').length > 0);
    const ids = await page.$$eval('#search-results [data-result]', els => els.map(e => e.dataset.result));
    assert.ok(ids.includes('rockefeller'), 'busca na nota deveria achar rockefeller');
    assert.equal(await page.locator('#search-ext-note').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('erro de rede no núcleo: mostra erro com "Tentar de novo", e a nova tentativa carrega o mapa', async () => {
    const { page, context, errors, nucleoAttempts } = await open({ nucleo: (route, attempt) => attempt === 1 ? route.abort('failed') : route.continue() });
    await page.waitForFunction(() => document.getElementById('data-status').dataset.state === 'error');
    const status = await statusOf(page);
    assert.equal(status.hidden, false);
    assert.equal(status.retry, true);
    assert.match(status.text, /Não foi possível carregar os dados do mapa/);
    assert.equal(await page.evaluate(() => !!window.mural), false);
    await page.click('#data-retry');
    await mapReady(page);
    assert.equal((await statusOf(page)).hidden, true);
    assert.equal(nucleoAttempts.length, 2);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('HTTP 404 no núcleo vira estado de erro, sem exceção na página', async () => {
    const { page, context, errors } = await open({ nucleo: route => route.fulfill({ status: 404, body: 'not found' }) });
    await page.waitForFunction(() => document.getElementById('data-status').dataset.state === 'error');
    assert.equal((await statusOf(page)).retry, true);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('JSON inválido no núcleo vira estado de erro', async () => {
    for (const body of ['{"nos":[', '[]', '{"nos":[],"conexoes":[]}']) {
      const { page, context, errors } = await open({ nucleo: route => route.fulfill({ contentType: 'application/json', body }) });
      await page.waitForFunction(() => document.getElementById('data-status').dataset.state === 'error');
      assert.equal(await page.evaluate(() => !!window.mural), false, body);
      assert.equal(await page.evaluate(() => document.getElementById('research-data').textContent), '', body);
      assert.deepEqual(errors, [], body);
      await context.close();
    }
  });

  test('núcleo sem extensão: painel em carregamento, depois erro com tentar de novo, busca parcial avisada', async () => {
    let extMode = 'hold'; // hold | fail | pass
    const waiters = [];
    const releaseExt = () => { for (const fn of waiters.splice(0)) fn(); };
    const { page, context, errors } = await open({
      ext: (route) => new Promise((resolve, reject) => {
        const go = () => {
          try {
            if (extMode === 'fail') resolve(route.abort('failed'));
            else if (extMode === 'pass') resolve(route.continue());
            else waiters.push(go);
          } catch (error) { reject(error); }
        };
        go();
      }),
    });
    await mapReady(page);
    await page.waitForFunction(() => ['pending', 'loading', 'error'].includes(window.mural.getState().extensionStatus));
    // Abre uma ligação conhecida pelo id de uma conexão do núcleo (via entidade maua)
    await page.evaluate(() => { location.hash = 'e=maua'; });
    await page.waitForFunction(() => window.mural.getState().selected?.id === 'maua' && window.mural.getState().inspectorOpen);
    await page.locator('#inspector [data-relation]').first().click();
    await page.waitForFunction(() => window.mural.getState().selected?.kind === 'edge');
    const loading = await page.locator('#ext-status').innerText();
    assert.match(loading, /Carregando documentação complementar/);
    const loadingHtml = await page.locator('#inspector-content').innerHTML();
    assert.doesNotMatch(loadingHtml, /FONTES E DOCUMENTOS/);
    assert.doesNotMatch(loadingHtml, /context-note/);
    // A afirmação não pode aparecer sem o limite.
    const edgeId = await page.evaluate(() => window.mural.getState().selected.id);
    const afirmacao = unionObj.conexoes.find(e => e.id === edgeId)?.afirmacao;
    if (afirmacao) assert.equal(loadingHtml.includes(afirmacao), false, 'afirmacao visível antes da extensão');

    await page.fill('#search', 'trusts');
    await page.waitForFunction(() => !document.getElementById('search-results').hidden);
    assert.equal(await page.locator('#search-ext-note').getAttribute('data-state'), 'loading');
    assert.match(await page.locator('#search-ext-note').innerText(), /Buscando também nas notas/);
    assert.equal(await page.locator('#search-results [data-result="rockefeller"]').count(), 0);

    // Falha da extensão: erro claro e tentar de novo, mapa permanece.
    extMode = 'fail';
    releaseExt();
    await page.waitForFunction(() => window.mural.getState().extensionStatus === 'error');
    assert.equal(await page.locator('#ext-status').getAttribute('data-state'), 'error');
    assert.match(await page.locator('#ext-status').innerText(), /Não foi possível carregar a documentação complementar/);
    assert.equal(await page.locator('#ext-retry').count(), 1);
    assert.ok(await page.evaluate(() => !!window.mural && document.querySelectorAll('#node-layer .network-node').length > 0));
    await page.fill('#search', 'trusts');
    await page.waitForFunction(() => document.getElementById('search-ext-note')?.dataset.state === 'error');
    assert.match(await page.locator('#search-ext-note').innerText(), /indisponível/);

    // Nova tentativa entrega a extensão; a busca é refeita e a nota aparece.
    extMode = 'pass';
    await page.click('#ext-retry');
    await extReady(page);
    await page.waitForFunction(() => document.getElementById('search-results') && !document.getElementById('search-ext-note') && document.querySelector('#search-results [data-result="rockefeller"]'));
    const insp = await page.locator('#inspector-content').innerText();
    assert.equal(await page.locator('#ext-status').count(), 0);
    assert.match(insp, /FONTES E DOCUMENTOS|Fonte/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('versão divergente do núcleo (cache velho): repete uma vez sem cache e usa a resposta nova', async () => {
    const stale = JSON.stringify({ ...JSON.parse(nucleoRaw), titulo: 'versão em cache' });
    const { page, context, errors, nucleoAttempts } = await open({
      nucleo: (route, attempt) => attempt === 1 ? route.fulfill({ contentType: 'application/json', body: stale }) : route.continue(),
    });
    await mapReady(page);
    assert.equal(nucleoAttempts.length, 2);
    assert.match(nucleoAttempts[1], /^\?v=[0-9a-f]{12}&r=\d+$/);
    assert.equal(await page.evaluate(() => JSON.parse(document.getElementById('research-data').textContent).titulo), JSON.parse(nucleoRaw).titulo);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
