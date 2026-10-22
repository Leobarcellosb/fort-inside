#!/usr/bin/env bash
# Aplica UMA mutacao ao CLONE descartavel (nunca ao checkout). $1 = diretorio do clone ; $2 = nome.
set -euo pipefail
D="$1"; M="${2:-}"
[ -z "$M" ] && exit 0
python3 - "$D" "$M" <<'PY'
import re, sys
d, m = sys.argv[1], sys.argv[2]
def arq(r): return f"{d}/{r}"
def troca(r, a, b, n=1, regex=False):
    s = open(arq(r)).read()
    if regex:
        s, k = re.subn(a, b, s, flags=re.S)
    else:
        k = s.count(a); s = s.replace(a, b)
    assert k >= n, f"{m}: padrao nao encontrado em {r} ({k}x)"
    open(arq(r), "w").write(s)
ROTAS = ("app/api/jobs/enfileirar/route.ts", "app/api/batch-process/route.ts", "app/api/jobs/status/route.ts")
if m == "auth403":
    for r in ROTAS: troca(r, "return respostaDeRecusa(admin);", 'return erroHttp("ADMIN_FORBIDDEN");')
    print("[mutacao] auth403: toda recusa de admin volta a ser 403 (o defeito original), nas 3 rotas")
elif m == "migration":
    troca("lib/erros/falha-de-fila.ts", 'return indicaEsquemaAusente(erro) ? "QUEUE_SCHEMA_MISSING" : "QUEUE_UNAVAILABLE";', 'return "QUEUE_SCHEMA_MISSING";')
    print("[mutacao] migration: qualquer falha da fila vira QUEUE_SCHEMA_MISSING (o defeito original)")
elif m == "status500":
    troca("app/api/jobs/status/route.ts", r"return erroHttp\(codigoDeFalhaDeFila\(.*?\}\);|return erroHttp\(codigoDeFalhaDeFila\(error\), \{ causa: error \}\);", 'return NextResponse.json({ error: "Erro" }, { status: 500 });', 2, True)
    print("[mutacao] status500: erro de leitura em /status volta a ser 500 'Erro' sem codigo (o defeito original)")
elif m == "semmodo":
    s = open(arq("lib/erros/preparar-processamento.ts")).read()
    assert "verificarEventoParaProcessar" in s and "portao.modo" in s
    s = s.replace("verificarEventoParaProcessar", "verificarEtapasDoEvento").replace("portao.modo", '("live" as "live" | "async")')
    open(arq("lib/erros/preparar-processamento.ts"), "w").write(s)
    print("[mutacao] semmodo: o portao volta a ignorar o modo (assincrono recusa para sempre)")
elif m == "abertalibera":
    troca("lib/quiz/etapas-do-evento.ts", "if (agora.getTime() < fecha + TOLERANCIA_DE_ENVIO_MS) {", "if (agora.getTime() < fecha + TOLERANCIA_DE_ENVIO_MS && Date.now() < 0) {")
    print("[mutacao] abertalibera: coleta ABERTA passa a liberar")
elif m == "modoadivinha":
    troca("lib/quiz/etapas-do-evento.ts", 'if (evento.mode !== "live") {', "if (false) {")
    print("[mutacao] modoadivinha: modo ausente/desconhecido tratado como live")
elif m == "relogionode":
    # O defeito que o CTO mandou eliminar: a hora de referencia vira o relogio do Node.
    troca("lib/quiz/etapas-do-evento.ts", "const ref = opcoes.agora ? { agora: opcoes.agora } : await lerRelogioDoBanco(supabase);", "const ref = { agora: opcoes.agora ?? new Date() } as { agora: Date } | { falha: FalhaDoPortao };")
    print("[mutacao] relogionode: a hora de referencia volta a ser o relogio do Node")
elif m == "semvalidacao" or m == "semquiescencia":
    # Mutacoes de SQL: so valem para a prova de banco (rodar-banco.sh), nao para o clone.
    print(f"[mutacao] {m}: aplica-se ao banco (rodar-banco.sh), nao ao clone")
else:
    sys.exit(f"mutacao desconhecida: {m}")
PY
