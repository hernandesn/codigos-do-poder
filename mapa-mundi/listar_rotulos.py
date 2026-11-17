#!/usr/bin/env python3
"""Lista, em ordem estável, os valores de tipo e de papel gravados em dados-mundo.json.

São os campos que o painel mostra: tipo da ficha, tipo da família ou instituição
ligada e tipo da ligação (o papel em cada exemplo). Não altera o JSON.
"""
import json
import sys
from pathlib import Path


def chaves(dados: dict) -> list[str]:
    achado: set[str] = set()
    for pais in dados.get("paises", {}).values():
        for ficha in pais.get("fichas") or []:
            if len(ficha) > 2 and ficha[2]:
                achado.add(ficha[2])
        for ligada in pais.get("ligadas") or []:
            if len(ligada) > 2 and ligada[2]:
                achado.add(ligada[2])
        for ligacao in (pais.get("ligacoes") or {}).values():
            for exemplo in ligacao.get("ex") or []:
                if len(exemplo) > 1 and exemplo[1]:
                    achado.add(exemplo[1])
    return sorted(achado)


def main() -> None:
    raiz = Path(__file__).resolve().parent
    dados = json.loads((raiz / "dados-mundo.json").read_text(encoding="utf-8"))
    lista = chaves(dados)
    json.dump(lista, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
