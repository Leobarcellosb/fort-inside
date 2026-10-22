#!/usr/bin/env bash
# ensaio-cobertura-vs-scoring.sh -- ENSAIO REPETIVEL: as duas definicoes de
# "resposta completa" deste sistema sao a mesma coisa?
#
#   BANCO   public.marco_zero_respostas_validas (migration 020): todas as etapas
#           da quiz_version do evento respondidas, todas com `answers` objeto NAO
#           vazio, e participants.completed_at preenchido.
#   SCORING lib/scoring/achatar-respostas.ts + lib/scoring/marco-zero.ts, lido por
#           situacaoDe(): os 24 itens Likert (1..5) e as 6 situacionais (A..D)
#           presentes e DENTRO do dominio -- a leitura de dimensoes completa.
#
# O ensaio constroi um Postgres DESCARTAVEL pelas MESMAS migrations de
# supabase/migrations/, popula massa SINTETICA com os cenarios nomeados, e compara
# os dois vereditos PARTICIPANTE POR PARTICIPANTE -- nao duas contagens agregadas,
# porque dois defeitos em direcoes opostas se cancelam num total e sobrevivem.
#
# Uso:   bash scripts/ensaio-cobertura-vs-scoring.sh
#        ENSAIO_MANTER=1 bash scripts/ensaio-cobertura-vs-scoring.sh   (nao destroi o alvo)
#
# Exit:  0 = o ensaio rodou e a medicao esta na saida (divergencia NAO e falha:
#            e o fato que o ensaio existe para descobrir)
#        2 = BLOCKED: nao deu para construir o alvo, semear ou comparar
#
# NUNCA aponta para producao: o alvo e criado por este script, num container
# proprio, com nome unico, e destruido no fim. Nenhum banco existente e tocado --
# nem para ler. Containers de outros processos nao sao removidos: a destruicao e
# pelo NOME EXATO que este script criou.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALVO_SH="$RAIZ/scripts/drift/reference-db.sh"
SEMENTE_SQL="$RAIZ/scripts/ensaio/semear-cobertura.sql"
EXTRACAO_SQL="$RAIZ/scripts/ensaio/extrair-cobertura.sql"
CONFIG_VITEST="$RAIZ/scripts/ensaio/vitest.ensaio.config.mts"

# Nome unico deste ensaio. O prefixo fort-drift- e o que reference-db.sh aceita
# destruir; o resto identifica ESTE processo, para nunca colidir com outro agente.
NOME="fort-drift-ensaio-cobertura-$$-$RANDOM"
CONTAINER=""
TRABALHO=""

die() { echo "ensaio: BLOCKED -- $*" >&2; exit 2; }

limpa() {
  if [ -n "$CONTAINER" ]; then
    if [ -n "${ENSAIO_MANTER:-}" ]; then
      echo "ensaio: ENSAIO_MANTER=1 -- o alvo segue de pe: $CONTAINER" >&2
      echo "ensaio: destrua a mao com: bash scripts/drift/reference-db.sh down $CONTAINER" >&2
    else
      echo "ensaio: destruindo o alvo descartavel ($CONTAINER)" >&2
      # Pelo nome EXATO que este script criou. Nunca por prefixo, nunca em massa.
      bash "$ALVO_SH" down "$CONTAINER" >/dev/null 2>&1 \
        || echo "ensaio: AVISO -- nao removi $CONTAINER; remova a mao: docker rm -f $CONTAINER" >&2
    fi
    CONTAINER=""
  fi
  [ -n "$TRABALHO" ] && rm -rf "$TRABALHO"
  TRABALHO=""
}
trap limpa EXIT INT TERM

for f in "$ALVO_SH" "$SEMENTE_SQL" "$EXTRACAO_SQL" "$CONFIG_VITEST"; do
  [ -f "$f" ] || die "falta $f"
done
command -v docker >/dev/null 2>&1 || die "docker nao encontrado"
command -v psql   >/dev/null 2>&1 || die "psql nao encontrado"
command -v npx    >/dev/null 2>&1 || die "npx nao encontrado"

TRABALHO="$(mktemp -d "${TMPDIR:-/tmp}/ensaio-cobertura.XXXXXX")" || die "mktemp falhou"
EXPORT_JSON="$TRABALHO/export.json"

echo "== 1/4 alvo descartavel, construido pelas MESMAS migrations de supabase/migrations/ =="
LINHA="$(bash "$ALVO_SH" up --name "$NOME" 2>"$TRABALHO/alvo.err")" \
  || die "nao consegui construir o alvo: $(tail -3 "$TRABALHO/alvo.err" | tr '\n' ' ')"
CONTAINER="$(printf '%s' "$LINHA" | cut -f1)"
URL="$(printf '%s' "$LINHA" | cut -f2)"
[ -n "$CONTAINER" ] && [ -n "$URL" ] || die "o construtor nao devolveu container e url"
[ "$CONTAINER" = "$NOME" ] || die "o container criado ($CONTAINER) nao e o nome que pedi ($NOME); recuso seguir"

# Cinto de seguranca: o alvo TEM de ser local. Produção nunca e tocada, mas a
# verificacao e explicita e nao depende de ninguem lembrar.
case "$URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) die "o alvo nao e local ($URL): recuso semear" ;;
esac
echo "   container: $CONTAINER"

echo "== 2/4 massa sintetica (os cenarios nomeados) =="
psql -X -q -v ON_ERROR_STOP=1 -f "$SEMENTE_SQL" "$URL" >/dev/null 2>"$TRABALHO/semente.err" \
  || die "a semeadura falhou: $(tail -3 "$TRABALHO/semente.err" | tr '\n' ' ')"

echo "== 3/4 leitura do veredito do banco, participante por participante =="
psql -X -q -v ON_ERROR_STOP=1 -f "$EXTRACAO_SQL" "$URL" >"$EXPORT_JSON" 2>"$TRABALHO/extracao.err" \
  || die "a extracao falhou: $(tail -3 "$TRABALHO/extracao.err" | tr '\n' ' ')"
[ -s "$EXPORT_JSON" ] || die "a extracao saiu vazia"

echo "== 4/4 comparacao com o veredito do scoring =="
ENSAIO_EXPORT="$EXPORT_JSON" \
  npx vitest run --root "$RAIZ" --config "$CONFIG_VITEST"
RC=$?

# Copia a medicao para fora do diretorio temporario, para quem quiser reler.
if [ -n "${ENSAIO_SAIDA:-}" ]; then
  cp "$EXPORT_JSON" "$ENSAIO_SAIDA" && echo "ensaio: dados crus em $ENSAIO_SAIDA"
fi

[ "$RC" -eq 0 ] || die "o comparador reprovou o PROPRIO ensaio (cenario ausente ou export malformado), nao a divergencia"
exit 0
