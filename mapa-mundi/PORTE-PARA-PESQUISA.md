# Porte para o repositório de pesquisa

O `index.html` deste repositório é gerado. A próxima geração apaga o gancho se `pesquisa/scripts/site.template` não tiver a mesma linha.

## Linha a acrescentar

No `site.template` do repositório privado `hernandesn/investigacao-poder`, imediatamente antes de `</body>`:

```html
<script src="mapa-mundi/carregar.js" defer></script>
```

Nada mais no template: sem estilo inline, sem script inline, sem mudança de CSP. O `'self'` já cobre `mapa-mundi/carregar.js`, a folha `mapa-mundi.css`, `mapa-mundi.js`, `vendor/` e `dados-mundo.json`.

O gerador precisa copiar a pasta `mapa-mundi/` (script, folha, JSON público, `vendor/` com as licenças) para a saída do site. Não embutir `dados-mundo.json` no `index.html`.

## Quando existir `pais_sede`

`mapa-mundi/derivar_paises.py` deve ir para `pesquisa/scripts/`. Ele só lê `dados-nucleo.json` e `dados-extensao.json`. Com `--base` apontando para a base privada, lê `pais_sede`, `pais_historico` e `pais_base` na memória e não grava de volta no registro.

Ordem que o script já aplica: R0 (sede editorial; sem `pais_base`, a ficha fica sem país), R1 (núcleo geográfico ou recorte Brasil), R2 (`fec_C…` → US), R3 (o nome cita um único país, nunca `tipo: pessoa`). `oriente`, `america_latina`, `america_do_sul`, `roma` e `urss` não viram país sozinhos. XP, URSS e Santa Sé só recebem rótulo histórico quando `pais_sede` / `pais_historico` (ou um ano já explícito no campo `ano` ou `inicio`) existem. O JSON público não leva `regra`, `pais_base`, «revisar» nem contagem de cobertura. Os nomes saem como no registro.
