// Códigos do Poder · landing: troca "no 8º dia" pela data real da primeira cobrança.
// Sem o JS, o texto "no 8º dia" continua valendo (fallback). Regra: 7 dias grátis, cobrança no 8º dia.
(function () {
  var d = new Date();
  d.setDate(d.getDate() + 7);
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var txt = 'em ' + dd + '/' + mm + ' (8º dia)';
  function aplicar() {
    var els = document.querySelectorAll('.data-cobranca');
    for (var i = 0; i < els.length; i++) els[i].textContent = txt;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aplicar);
  else aplicar();
})();
