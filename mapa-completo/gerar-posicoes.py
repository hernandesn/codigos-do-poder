#!/usr/bin/env python3
"""Gera mapa-completo/posicoes.json com o mesmo layout de força da referência.

Espelha insumos/ref/layout2.py: os nós e as ligações entram na ordem do
arquivo (sem ordenar), o componente principal usa spring_layout com semente 3
e 300 iterações, e o maior componente restante (KochPAC) vai para a direita.
Não escreve em dados/, database/ nem nos JSON da base.
"""
import json
import math
import pathlib

import networkx as nx
import numpy as np

RAIZ = pathlib.Path(__file__).resolve().parents[1]
ENTRADA = RAIZ / 'dados-nucleo.json'
SAIDA = pathlib.Path(__file__).resolve().parent / 'posicoes.json'


def layout(dados):
    grafo = nx.Graph()
    for no in dados['nos']:
        grafo.add_node(no['id'])
    for aresta in dados['conexoes']:
        grafo.add_edge(aresta['origem'], aresta['destino'])
    componentes = sorted(nx.connected_components(grafo), key=len, reverse=True)
    principal = grafo.subgraph(componentes[0])
    bruto = nx.spring_layout(
        principal,
        k=1.6 / math.sqrt(len(principal)),
        iterations=300,
        seed=3,
    )
    pontos = np.array(list(bruto.values()))
    centro = pontos.mean(0)
    raio = np.percentile(np.linalg.norm(pontos - centro, axis=1), 99)
    pos = {
        chave: [
            round(float((valor[0] - centro[0]) / raio * 1.3 - 0.25), 5),
            round(float((valor[1] - centro[1]) / raio), 5),
        ]
        for chave, valor in bruto.items()
    }
    resto = componentes[1:]
    quantidade = len(resto)
    for indice, conjunto in enumerate(resto):
        sub = grafo.subgraph(conjunto)
        if len(conjunto) > 1:
            local = nx.spring_layout(sub, seed=1)
        else:
            local = {next(iter(conjunto)): np.array([0.0, 0.0])}
        nuvem = np.array(list(local.values()))
        nuvem = nuvem - nuvem.mean(0)
        maior = np.abs(nuvem).max() or 1
        tamanho = 0.03 + 0.012 * math.sqrt(len(conjunto))
        angulo = 2 * math.pi * (indice + 0.5) / quantidade + 0.35
        distancia = 1.22 + 0.10 * (indice % 2)
        cx, cy = distancia * math.cos(angulo) * 1.35, distancia * math.sin(angulo)
        if indice == 0:
            tamanho, cx, cy = 0.42, 1.45, -0.05
        for chave, valor in zip(local.keys(), nuvem):
            pos[chave] = [
                round(float(cx + valor[0] / maior * tamanho), 5),
                round(float(cy + valor[1] / maior * tamanho), 5),
            ]
    return pos


def main():
    dados = json.loads(ENTRADA.read_text(encoding='utf-8'))
    pos = layout(dados)
    faltam = [no['id'] for no in dados['nos'] if no['id'] not in pos]
    if faltam:
        raise SystemExit(f'sem posição: {faltam[:8]}')
    documento = {
        'gerado_por': 'mapa-completo/gerar-posicoes.py',
        'algoritmo': 'networkx.spring_layout',
        'networkx': nx.__version__,
        'numpy': np.__version__,
        'seed_principal': 3,
        'iteracoes_principal': 300,
        'seed_satelite': 1,
        'nos': len(pos),
        'pos': pos,
    }
    SAIDA.write_text(json.dumps(documento, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'escrito {SAIDA} nos={len(pos)}')
    for chave in ('kochpac', 'ipes', 'rf', 'papacy'):
        print(chave, pos.get(chave))


if __name__ == '__main__':
    main()
