import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { erroHttp } from "@/lib/erros/resposta";
import type { PrognosticContent, PrognosticStatus } from "@/types/database";

// PATCH /api/prognostics/[id]
// Yuri-only: salva texto editado em `edited_content`, marca status='reviewed',
// nulifica pdf_url para forçar regeneração com texto novo no momento da entrega.
//
// SALVAR AQUI É O ATO DE APROVAÇÃO (migration 025): o `reviewed_at` novo que
// esta rota grava é o que faz o banco selar a impressão digital do texto deste
// instante. Enquanto esse selo não cobrir o texto, a entrega é recusada pelo
// banco. Uma correção salva por aqui, mesmo de uma vírgula, reaprova no mesmo
// ato; uma correção feita por qualquer outro caminho não reaprova nada.
//
// OS DESFECHOS, nomeados (lib/erros/codigos.ts). Antes esta rota devolvia o
// texto cru do banco com status 500 -- erro de produto vestido de falha de
// servidor -- quando o gatilho da migration 015 recusava a regressão de estado
// sobre documento já entregue:
//   PROGNOSTIC_NOT_FOUND          404  não existe documento com este id
//   PROGNOSTIC_STATE_REGRESSION   400  CONFERIDO: já entregue, não volta
//   PROGNOSTIC_WRITE_UNAVAILABLE  503  não deu para gravar (nem recusa, nem ausência)

const TRAILS = [
  "Exploração",
  "Direção",
  "Aproximação",
  "Aceleração",
  "Sessão Privada",
] as const;

// Schema flexível: arrays com tamanho mínimo 1 (admin pode estar reorganizando
// blocos durante edição), strings com min(1) pra evitar entregar campo vazio.
const contentSchema = z.object({
  analise_geral: z.string().min(1),
  areas_chave: z
    .array(
      z.object({
        nome: z.string().min(1),
        diagnostico: z.string().min(1),
        risco: z.string().min(1),
        movimento: z.string().min(1),
      })
    )
    .min(1),
  plano_30_dias: z
    .array(
      z.object({
        titulo: z.string().min(1),
        objetivos: z.array(z.string().min(1)).min(1),
        acao: z.string().min(1),
        resultado_esperado: z.string().min(1),
      })
    )
    .min(1),
  praticas: z
    .array(z.object({ nome: z.string().min(1), descricao: z.string().min(1) }))
    .min(1),
  frase_ativacao: z.object({
    frase: z.string().min(1),
    contexto: z.string().min(1),
    aplicacao: z.string().min(1),
    pergunta_pratica: z.string().min(1),
  }),
  trilha_recomendada: z.enum(TRAILS),
  justificativa_trilha: z.string().min(1),
});

// Estados em que salvar uma revisão ainda é legítimo. `delivered` fica FORA: o
// documento entregue não volta (migration 015), e tentar é desfecho de produto
// com código próprio, não erro de servidor.
//
// `suspended` ENTRA, com a migration 027, e é o caminho da RETIFICAÇÃO. Não é
// uma regressão disfarçada: `suspended -> reviewed` é para a FRENTE no desenho
// da 027 (o documento já saiu de `delivered` por um ato de operador registrado,
// e está fora do ar), e é o único caminho de volta ao ar -- de `suspended` o
// banco só aceita `in_review` ou `reviewed`, nunca `delivered` direto, porque
// reentregar sem nova revisão devolveria ao ar o mesmo texto errado.
//
// Salvar aqui sobre um documento suspenso é o ATO DE APROVAÇÃO do texto novo
// (migration 025, inalterada): `reviewed_at` novo faz o banco selar a impressão
// digital deste instante, e só então a entrega é liberada. A versão anterior NÃO
// é reaberta -- ela continua em `prognostic_delivery_history` (026), com a data
// em que o participante a leu.
const ESTADOS_REVISAVEIS = [
  "pending",
  "generating",
  "generated",
  "in_review",
  "reviewed",
  "suspended",
] as const;

const bodySchema = z.object({
  content: contentSchema,
  yuri_note: z.string().nullable().optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;

  // Admin auth — same pattern as /api/admin/events/[eventId]
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  if (!parsed?.success) {
    return NextResponse.json(
      { error: "Conteúdo inválido", detail: parsed?.error.flatten() },
      { status: 400 }
    );
  }

  const { content, yuri_note } = parsed.data;

  // Use admin client to bypass RLS for the write — auth already checked above.
  const admin = createAdminClient();

  // O estado ATUAL, antes de escrever: é o que separa "não existe" de
  // "existe e já foi entregue" de "não deu para gravar". Sem esta leitura, as
  // três condições chegavam ao host como o mesmo 500 com texto de banco.
  const { data: atual, error: lErr } = (await admin
    .from("prognostics")
    .select("status")
    .eq("id", id)
    .maybeSingle()) as {
    data: { status: PrognosticStatus } | null;
    error: { message: string } | null;
  };

  if (lErr) {
    return erroHttp("PROGNOSTIC_WRITE_UNAVAILABLE", { causa: lErr.message });
  }
  if (!atual) {
    return erroHttp("PROGNOSTIC_NOT_FOUND");
  }
  if (!(ESTADOS_REVISAVEIS as readonly string[]).includes(atual.status)) {
    // CONFERIDO e NÃO PERMITIDO. Documento entregue não volta para revisão: o
    // texto que o participante recebeu não é alterado por baixo dele.
    return erroHttp("PROGNOSTIC_STATE_REGRESSION", {
      detalhes: { estado_do_documento: atual.status },
    });
  }

  type SelectMany<T> = { data: T[] | null; error: { message: string; code?: string } | null };
  const { data: gravadas, error } = await (
    admin.from("prognostics") as unknown as {
      update(v: Record<string, unknown>): {
        eq(c: string, v: string): {
          in(c: string, v: readonly string[]): {
            select(cols: string): Promise<SelectMany<{ id: string }>>;
          };
        };
      };
    }
  )
    .update({
      edited_content: content as PrognosticContent,
      yuri_note: yuri_note ?? null,
      trail_recommendation: content.trilha_recomendada,
      status: "reviewed",
      // O instante que SELA o conteúdo (migration 025). Sempre novo: salvar a
      // revisão é aprovar o texto como ele está agora.
      reviewed_at: new Date().toISOString(),
      pdf_url: null,
    })
    .eq("id", id)
    // Repete a trava no próprio UPDATE: entre a leitura acima e esta escrita o
    // documento pode ter sido entregue por outra pessoa, e aí nenhuma linha casa.
    .in("status", ESTADOS_REVISAVEIS)
    .select("id");

  if (error) {
    // `23514` é check_violation: é com ele que o gatilho da 015 recusa regressão
    // de estado. Recusa verificada do banco é desfecho de produto, não falha de
    // servidor -- e o texto cru do banco nunca chega ao host.
    if (error.code === "23514") {
      return erroHttp("PROGNOSTIC_STATE_REGRESSION", {
        causa: error.message,
        detalhes: { estado_do_documento: atual.status },
      });
    }
    return erroHttp("PROGNOSTIC_WRITE_UNAVAILABLE", { causa: error.message });
  }

  if (!gravadas || gravadas.length === 0) {
    // Nada casou: o estado avançou entre a leitura e a escrita.
    return erroHttp("PROGNOSTIC_STATE_REGRESSION", {
      causa: "estado avancou entre a leitura e a escrita",
      detalhes: { estado_do_documento: atual.status },
    });
  }

  return NextResponse.json({ success: true });
}
