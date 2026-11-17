# Porte para o repositório de pesquisa

O `index.html` deste repositório é gerado. A próxima geração apaga o gancho se `pesquisa/scripts/site.template` não tiver a mesma linha.

## Linha a acrescentar

No `site.template` do repositório privado `hernandesn/investigacao-poder`, imediatamente antes de `</body>`:

```html
<script src="mapa-mundi/carregar.js" defer></script>
```

Nada mais no template: sem estilo inline, sem script inline, sem mudança de CSP. O `'self'` já cobre `mapa-mundi/carregar.js`, a folha `mapa-mundi.css`, `mapa-mundi.js`, `vendor/` e `dados-mundo.json`.

## Favicon

No `site.template`, trocar `<link rel="icon" href="data:,">` por este bloco (arquivos na raiz do site publicado). A CSP atual não tem `manifest-src`; `default-src 'self'` já cobre o manifesto. Se um dia a política ganhar `manifest-src`, incluir `'self'`.

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0a0706">
```

O gerador precisa copiar a pasta `mapa-mundi/` (script, folha, JSON público, `vendor/` com as licenças) para a saída do site. Não embutir `dados-mundo.json` no `index.html`.

## Quando existir `pais_sede`

`mapa-mundi/derivar_paises.py` deve ir para `pesquisa/scripts/`. Ele só lê `dados-nucleo.json` e `dados-extensao.json`. Com `--base` apontando para a base privada, lê `pais_sede`, `pais_historico` e `pais_base` na memória e não grava de volta no registro.

Ordem que o script já aplica: R0 (sede editorial; sem `pais_base`, a ficha fica sem país), R1 (núcleo geográfico ou recorte Brasil), R2 (`fec_C…` → US), R3 (o nome cita um único país, nunca `tipo: pessoa`). `oriente`, `america_latina`, `america_do_sul`, `roma` e `urss` não viram país sozinhos. XP, URSS e Santa Sé só recebem rótulo histórico quando `pais_sede` / `pais_historico` (ou um ano já explícito no campo `ano` ou `inicio`) existem. O JSON público não leva `regra`, `pais_base`, «revisar» nem contagem de cobertura. Os nomes saem como no registro.
