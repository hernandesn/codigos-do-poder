#!/usr/bin/env python3
"""Deriva país (ISO 3166-1 alfa-2) de cada ficha. Só leitura dos registros.

Porte de insumos/referencia/derivar-paises.cjs + montagem do JSON público
do mapa-múndi. Não grava em dados-nucleo.json, dados-extensao.json nem
em nenhum registro de pesquisa.

Ordem: R0 campos editoriais (pais_sede / pais_historico / pais_base),
R1 núcleo geográfico ou recorte «Brasil», R2 id fec_C…, R3 nome cita
um único país (nunca tipo pessoa). Senão, sem país.

Regras históricas só quando há pais_sede ou pais_historico. Sem ano
explícito (campo ano ou inicio com 4 dígitos), o rótulo não é inventado.
"""
from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent

TIPOS_LIGADOS = (
    "familia",
    "instituicao",
    "fundacao",
    "banco",
    "holding",
    "empresa",
    "ong",
    "orgao_internacional",
    "organismo_multilateral",
)
CURTOS_OK = {"eua", "usa", "u.s."}
ROTULOS_RU = {"URSS", "Império Russo"}
SEDE_URSS = {
    "RU", "UA", "BY", "GE", "AM", "AZ", "KZ", "KG", "TJ", "TM", "UZ", "MD", "LT", "LV", "EE",
}


def norm(valor) -> str:
    texto = (valor or "").lower()
    texto = unicodedata.normalize("NFD", texto)
    return "".join(c for c in texto if unicodedata.category(c) != "Mn")


def carregar(caminho: Path):
    with caminho.open(encoding="utf-8") as fh:
        return json.load(fh)


def gravar(caminho: Path, obj) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    texto = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    caminho.write_text(texto + "\n", encoding="utf-8")


def ano_explicito(no: dict):
    """Ano só se o campo já for um ano. Não lê período em texto."""
    for chave in ("ano", "inicio"):
        valor = no.get(chave)
        if isinstance(valor, int) and 1000 <= valor <= 2100:
            return valor
        if isinstance(valor, str) and re.fullmatch(r"\d{4}", valor):
            return int(valor)
    return None


def rotulo_por_ano(iso: str, ano: int | None, tipo: str, nome: str):
    if ano is None:
        return None
    if iso == "VA":
        if ano < 1870:
            return "Estados Pontifícios"
        if ano < 1929:
            return "Santa Sé"
        return None
    if iso == "XP":
        if ano <= 1917:
            return "Palestina otomana"
        if 1920 <= ano <= 1948:
            return "Palestina sob Mandato Britânico"
        return None
    if iso in SEDE_URSS and 1922 <= ano <= 1991:
        return "URSS"
    if iso == "RU" and ano < 1917:
        return "Império Russo"
    return None


def montar_padroes(iso: dict, regras: dict):
    skip = {norm(n) for n in regras.get("nomes_ignorados", [])}
    nomes: dict[str, set[str]] = {}

    def add(nome, a2):
        n = norm(nome).strip()
        if not n:
            return
        if len(n) < 4 and n not in CURTOS_OK:
            return
        if n in skip:
            return
        nomes.setdefault(n, set()).add(a2)

    for a2, info in iso.items():
        if not re.fullmatch(r"[A-Z]{2}", a2):
            continue
        # XP e outros códigos históricos só entram por pais_sede (R0), nunca pelo nome.
        if info.get("historico"):
            continue
        for lingua in ("pt", "en"):
            for nome in info.get(lingua) or []:
                add(nome, a2)
    for apelido, a2 in (regras.get("aliases") or {}).items():
        add(apelido, a2)

    compilados = []
    for nome, paises in nomes.items():
        rx = re.compile(r"(?:^|[^a-z0-9])" + re.escape(nome) + r"(?:$|[^a-z0-9])")
        compilados.append((nome, rx, paises))
    return compilados


def citados(texto, padroes) -> set[str]:
    bruto = norm(texto)
    if not bruto:
        return set()
    achados: set[str] = set()
    for nome, rx, paises in padroes:
        if nome not in bruto:
            continue
        if rx.search(bruto):
            achados.update(paises)
    return achados


def sede_de(no: dict):
    bruto = no.get("pais_sede")
    if bruto is None or bruto is False:
        return []
    if isinstance(bruto, str):
        lista = [bruto]
    elif isinstance(bruto, list):
        lista = list(bruto)
    else:
        return []
    return [s for s in lista if isinstance(s, str) and s]


def estilo(aresta: dict) -> str:
    if aresta.get("confianca") == "baixa" or aresta.get("estado") in ("rascunho", "anunciado"):
        return "p"
    if aresta.get("confianca") == "media":
        return "t"
    return "s"


def nome_publico(a2: str, info: dict, fichas: list) -> str:
    base = (info.get("pt") or [a2])[0]
    rotulos = [f[3] for f in fichas if len(f) > 3 and f[3]]
    unicos = list(dict.fromkeys(rotulos))
    if a2 == "XP" and len(unicos) == 1:
        return unicos[0]
    if a2 == "XP" and not unicos:
        return "Palestina"
    if base == "Rússia" and fichas and all((len(f) > 3 and f[3] in ROTULOS_RU) for f in fichas):
        return unicos[0] if len(unicos) == 1 else "URSS"
    if len(unicos) == 1 and len(rotulos) == len(fichas):
        return unicos[0]
    return base


def derivar(nucleo: dict, extensao: dict, iso: dict, regras: dict):
    nuc = regras.get("nucleos_geograficos") or {}
    nunca = set(regras.get("nucleos_nunca_pais") or [])
    sem_nome = set(regras.get("tipos_sem_regra_por_nome") or [])
    prefixo = regras.get("prefixo_fec") or "fec_C"
    rx_fec = re.compile("^" + re.escape(prefixo) + r"\d+")
    padroes = montar_padroes(iso, regras)
    notas = {n["id"]: n.get("nota") or "" for n in extensao.get("nos") or [] if "id" in n}

    linhas = []
    pendencias = []
    for no in nucleo.get("nos") or []:
        nome = no.get("nome") or ""
        tipo = no.get("tipo") or ""
        nucleo_id = no.get("nucleo") or ""
        nota = notas.get(no["id"], "")
        sede = sede_de(no)
        if sede:
            if not no.get("pais_base"):
                pendencias.append({
                    "id": no["id"],
                    "motivo": "pais_sede sem pais_base — fica sem país",
                    "nome": nome,
                    "nucleo": nucleo_id,
                    "tipo": tipo,
                })
                linhas.append({"id": no["id"], "iso2": None, "regra": None, "revisar": False, "rotulo": None})
                continue
            iso2 = sede[0]
            rotulo = no.get("pais_historico") or None
            if isinstance(rotulo, str):
                rotulo = rotulo.strip() or None
            else:
                rotulo = None
            if not rotulo:
                rotulo = rotulo_por_ano(iso2, ano_explicito(no), tipo, nome)
            linhas.append({
                "id": no["id"],
                "iso2": iso2,
                "regra": "R0-pais_sede",
                "revisar": bool(re.search(r"nome", str(no.get("pais_base")), re.I)),
                "rotulo": rotulo,
            })
            continue

        # oriente, america_latina, america_do_sul, roma e urss nunca viram país sozinhos.
        if nucleo_id in nunca:
            nucleo_geo = None
        else:
            nucleo_geo = nuc.get(nucleo_id)

        nm = citados(nome, padroes)
        nt = citados(nota, padroes)
        iso2 = None
        regra = None
        obs = ""
        if nucleo_geo:
            iso2, regra = nucleo_geo, "R1-nucleo"
        elif no.get("recorte_pesquisa") == "Brasil":
            iso2, regra = "BR", "R1-recorte"
        elif rx_fec.match(str(no.get("id") or "")):
            iso2, regra = "US", "R2-FEC"
        elif len(nm) == 1 and tipo not in sem_nome:
            iso2, regra = next(iter(nm)), "R3-nome"

        sug = None
        if not iso2 and len(nm) == 0 and len(nt) == 1:
            sug = next(iter(nt))
        if iso2 and regra and regra.startswith("R1") and len(nm) == 1 and iso2 not in nm:
            obs = "conflito: nome cita " + next(iter(nm))
        if not iso2:
            if tipo in sem_nome and len(nm) == 1:
                motivo = "pessoa: nome cita " + next(iter(nm)) + " (nacionalidade não inferida)"
            elif len(nm) > 1:
                motivo = "nome cita vários países: " + ",".join(sorted(nm))
            elif len(nt) > 1:
                motivo = "nota cita vários países: " + ",".join(sorted(nt))
            else:
                motivo = "sem indicação de país nos campos"
            item = {
                "id": no["id"],
                "motivo": motivo,
                "nome": nome,
                "nucleo": nucleo_id,
                "tipo": tipo,
            }
            if sug:
                item["sugestao_nota"] = sug
            pendencias.append(item)
        elif obs:
            pendencias.append({
                "id": no["id"],
                "motivo": obs + " (mantido " + iso2 + " pela regra " + regra + ")",
                "nome": nome,
                "nucleo": nucleo_id,
                "tipo": tipo,
            })
        if regra == "R3-nome":
            pendencias.append({
                "id": no["id"],
                "motivo": "atribuído " + iso2 + " só pelo nome — revisar",
                "nome": nome,
                "nucleo": nucleo_id,
                "tipo": tipo,
            })
        linhas.append({
            "id": no["id"],
            "iso2": iso2,
            "regra": regra,
            "revisar": regra == "R3-nome",
            "rotulo": None,
        })

    por_id = {r["id"]: r for r in linhas}
    nos = {n["id"]: n for n in nucleo.get("nos") or []}
    ambos = inter = interno = uma = 0
    for aresta in nucleo.get("conexoes") or []:
        a = (por_id.get(aresta.get("origem")) or {}).get("iso2")
        b = (por_id.get(aresta.get("destino")) or {}).get("iso2")
        if a and b:
            ambos += 1
            if a == b:
                interno += 1
            else:
                inter += 1
        elif a or b:
            uma += 1
    conexoes = nucleo.get("conexoes") or []
    contagem: dict[str, int] = {}
    por_regra: dict[str, int] = {}
    for linha in linhas:
        chave = linha["regra"] or "sem-pais"
        por_regra[chave] = por_regra.get(chave, 0) + 1
        if linha["iso2"]:
            contagem[linha["iso2"]] = contagem.get(linha["iso2"], 0) + 1
    sem_por_nuc: dict[str, int] = {}
    vistos = set()
    for item in pendencias:
        if item["id"] in vistos:
            continue
        if (por_id.get(item["id"]) or {}).get("iso2"):
            continue
        vistos.add(item["id"])
        nuc_id = item.get("nucleo")
        sem_por_nuc[nuc_id] = sem_por_nuc.get(nuc_id, 0) + 1
    top = sorted(contagem.items(), key=lambda par: (-par[1], par[0]))
    cobertura = {
        "com_pais": sum(1 for r in linhas if r["iso2"]),
        "conexoes": len(conexoes),
        "conexoes_ambas_pontas": ambos,
        "conexoes_internacionais": inter,
        "conexoes_mesmo_pais": interno,
        "conexoes_sem_pais": len(conexoes) - ambos - uma,
        "conexoes_uma_ponta": uma,
        "entidades": len(nucleo.get("nos") or []),
        "paises": len(top),
        "pendencias": len(pendencias),
        "por_regra": por_regra,
        "sem_pais": sum(1 for r in linhas if not r["iso2"]),
        "sem_pais_por_nucleo": sorted(sem_por_nuc.items(), key=lambda par: (-par[1], str(par[0]))),
        "top_paises": top,
        "versao": nucleo.get("versao"),
    }

    paises: dict[str, dict] = {}

    def obter(a2: str) -> dict:
        if a2 not in paises:
            info = iso.get(a2) or {}
            paises[a2] = {
                "casos": [],
                "fichas": [],
                "hist": bool(info.get("historico")),
                "internas": 0,
                "ligacoes": {},
                "ligadas": {},
                "nome": (info.get("pt") or [a2])[0],
                "num": info.get("num"),
            }
        return paises[a2]

    for linha in linhas:
        if not linha["iso2"]:
            continue
        no = nos.get(linha["id"]) or {}
        ficha = [linha["id"], no.get("nome") or "", no.get("tipo") or ""]
        if linha.get("rotulo"):
            ficha.append(linha["rotulo"])
        obter(linha["iso2"])["fichas"].append(ficha)

    for aresta in conexoes:
        a = (por_id.get(aresta.get("origem")) or {}).get("iso2")
        b = (por_id.get(aresta.get("destino")) or {}).get("iso2")
        marca = estilo(aresta)
        if a and b and a != b:
            for origem, destino, id_o, id_d in (
                (a, b, aresta.get("origem"), aresta.get("destino")),
                (b, a, aresta.get("destino"), aresta.get("origem")),
            ):
                lig = obter(origem)["ligacoes"].setdefault(destino, {"ex": [], "p": 0, "s": 0, "t": 0})
                lig[marca] += 1
                if len(lig["ex"]) < 4:
                    lig["ex"].append([
                        (nos.get(id_o) or {}).get("nome") or "",
                        aresta.get("tipo") or "",
                        (nos.get(id_d) or {}).get("nome") or "",
                        marca,
                    ])
        elif a and b:
            obter(a)["internas"] += 1
        elif a or b:
            pais = a or b
            outro = aresta.get("destino") if a else aresta.get("origem")
            no = nos.get(outro) or {}
            if no.get("tipo") in TIPOS_LIGADOS:
                bolsa = obter(pais)["ligadas"]
                atual = bolsa.get(outro)
                if atual is None:
                    bolsa[outro] = [outro, no.get("nome") or "", no.get("tipo") or "", 1]
                else:
                    atual[3] += 1

    for caso in nucleo.get("casos") or []:
        presentes = []
        vistos_pais = set()
        for id_ent in caso.get("entidades_mural") or []:
            a2 = (por_id.get(id_ent) or {}).get("iso2")
            if a2 and a2 not in vistos_pais:
                vistos_pais.add(a2)
                presentes.append(a2)
        for a2 in presentes:
            obter(a2)["casos"].append([
                caso.get("id") or "",
                caso.get("titulo") or "",
                caso.get("periodo") or "",
            ])

    publico = {}
    for a2 in sorted(paises):
        bloco = paises[a2]
        info = iso.get(a2) or {}
        fichas = sorted(bloco["fichas"], key=lambda f: (norm(f[1]), f[0]))
        ligadas = sorted(bloco["ligadas"].values(), key=lambda item: (-item[3], item[0]))[:12]
        casos = sorted(bloco["casos"], key=lambda c: c[0])
        ligacoes = {}
        for destino in sorted(bloco["ligacoes"]):
            lig = bloco["ligacoes"][destino]
            ligacoes[destino] = {"ex": lig["ex"], "p": lig["p"], "s": lig["s"], "t": lig["t"]}
        publico[a2] = {
            "casos": casos,
            "fichas": fichas,
            "hist": bool(info.get("historico")) or a2 == "XP",
            "internas": bloco["internas"],
            "ligacoes": ligacoes,
            "ligadas": ligadas,
            "nome": nome_publico(a2, info, fichas),
            "num": info.get("num"),
        }
    return {"paises": publico}, cobertura, pendencias


def main() -> None:
    ap = argparse.ArgumentParser(description="Deriva mapa-mundi/dados-mundo.json")
    ap.add_argument("--nucleo", type=Path, default=RAIZ / "dados-nucleo.json")
    ap.add_argument("--extensao", type=Path, default=RAIZ / "dados-extensao.json")
    ap.add_argument("--iso", type=Path, default=AQUI / "paises-iso.json")
    ap.add_argument("--regras", type=Path, default=AQUI / "regras-derivacao.json")
    ap.add_argument("--base", type=Path, default=None, help="Base privada opcional, só leitura")
    ap.add_argument("--saida", type=Path, default=AQUI / "dados-mundo.json")
    ap.add_argument("--interno", type=Path, default=AQUI / "interno")
    args = ap.parse_args()

    nucleo = carregar(args.nucleo)
    extensao = carregar(args.extensao)
    if args.base:
        base = carregar(args.base)
        extras = {n["id"]: n for n in base.get("nos") or [] if "id" in n}
        for no in nucleo.get("nos") or []:
            fonte = extras.get(no.get("id")) or {}
            for campo in ("pais_sede", "pais_historico", "pais_base"):
                if campo in fonte and campo not in no:
                    no[campo] = fonte[campo]
    iso = carregar(args.iso)
    regras = carregar(args.regras)
    publico, cobertura, pendencias = derivar(nucleo, extensao, iso, regras)
    gravar(args.saida, publico)
    gravar(args.interno / "cobertura.json", cobertura)
    gravar(args.interno / "pendencias-pais.json", pendencias)
    print(json.dumps({
        "com_pais": cobertura["com_pais"],
        "entidades": cobertura["entidades"],
        "internacionais": cobertura["conexoes_internacionais"],
        "paises": cobertura["paises"],
        "pendencias": cobertura["pendencias"],
        "por_regra": cobertura["por_regra"],
        "saida": str(args.saida),
        "sem_pais": cobertura["sem_pais"],
    }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
