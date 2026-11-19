// Links antigos do app na raiz vão para /mapa/, com a mesma query e o mesmo hash.
// decidir() roda no carregamento, no hashchange e no popstate. O popstate cobre
// volta e avanço que mudam a query sem mudar o hash. Hash vazio ('') ou '#' fica
// na raiz. Hash cujo id existe na landing também fica: o navegador rola até a seção.
// A lista sai de index.html (scripts/gerar-ancoras-landing.mjs). O script roda no
// <head>, antes do body. Âncora da landing não ganha a classe que esconde o body.
// Query do app redireciona mesmo com âncora. O destino é sempre o caminho '/mapa/'
// nesta origem. Se hashchange e popstate dispararem juntos, a segunda chamada não
// troca de página de novo.
(function () {
  var redirecionando = false;
  // ANCORAS-LANDING:inicio
  var ancoras = ["hero-t","base","base-t","exemplos","ex-t","perc-t","como","como-t","planos","pl-t","faq","faq-t","comecar","fin-t"];
  // ANCORAS-LANDING:fim
  function decidir() {
    if (redirecionando) return;
    var hash = location.hash || '';
    var search = location.search || '';
    var params;
    try { params = new URLSearchParams(search); }
    catch (e) { params = new URLSearchParams(); }
    var appQuery = params.get('editor') === '1' || params.get('debug') === '1' || params.has('access_token');
    var id = '';
    if (hash.length > 1) {
      try { id = decodeURIComponent(hash.slice(1)); }
      catch (e2) { id = hash.slice(1); }
    }
    var hashVazio = hash === '' || hash === '#';
    var ancoraDaLanding = !hashVazio && ancoras.indexOf(id) !== -1;
    if (!appQuery && (hashVazio || ancoraDaLanding)) return;
    redirecionando = true;
    document.documentElement.classList.add('redir-app');
    location.replace('/mapa/' + search + hash);
  }
  decidir();
  addEventListener('hashchange', decidir);
  addEventListener('popstate', decidir);
})();
