import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { erroHttp } from "@/lib/erros/resposta";
import { MINIMO_DO_MOTIVO } from "@/components/features/admin/suspensao-do-documento";
import type { PrognosticStatus } from "@/types/database";

// POST /api/prognostics/[id]/suspender
// TIRA DO AR um documento JÁ ENTREGUE (migration 027). Yuri-only.
//
// POR QUE ISTO É UMA ROTA, e não uma escrita direta da tela
// ---------------------------------------------------------
// O painel de revisão grava direto no banco com a sessão do administrador, e
// para entregar isso basta. Para SUSPENDER não basta, por uma razão só: a
// suspensão é ATO DE OPERADOR, e o livro-razão da 027 registra QUEM. Se a tela
// gravasse `suspenso_por` por conta dela, o autor do ato viria do navegador --
// isto é, qualquer administrador poderia registrar o ato no nome de outro.
//
// Então o autor é lido da SESSÃO, aqui no servidor, e o corpo do pedido NÃO tem
// campo de autor: não existe o que forjar. O motivo vem do corpo (é o que só o
// operador sabe) e o instante vem do banco (`now()`, escrito pelo gatilho).
//
// A divisão de trabalho, declarada: esta rota NÃO é a garantia. A garantia é do
// banco -- a cerca do gatilho `prognostics_suspensao` (só de `delivered`, com
// autor e com motivo de pelo menos 10 caracteres úteis) e o CHECK
// `prognostics_suspensao_tem_autor_e_motivo`. Esta rota existe para que o
// desfecho chegue ao host com nome, e para que o autor não venha do cliente.
//
// OS DESFECHOS, nomeados (lib/erros/codigos.ts):
//   INVALID_REQUEST                400  corpo sem motivo, ou motivo curto demais
//   PROGNOSTIC_NOT_FOUND           404  não existe documento com este id
//   PROGNOSTIC_SUSPENSION_REFUSED  400  CONFERIDO: não está entregue, nada a tirar do ar
//   PROGNOSTIC_WRITE_UNAVAILABLE   503  não deu para gravar (nem recusa, nem ausência)

const bodySchema = z.object({
  // O MESMO piso do banco. Repetido aqui para a recusa chegar como pedido
  // inválido (400 com instrução) em vez de erro de banco, nunca para substituir
  // a trava: o CHECK da 027 continua valendo se esta rota errar.
  motivo: z.string().trim().min(MINIMO_DO_MOTIVO),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;

  // Admin auth -- mesmo padrão de app/api/prognostics/[id]/route.ts.
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
    return erroHttp("INVALID_REQUEST");
  }
  if (!parsed?.success) {
    // Sem `detalhes`: `DetalhesDeErro` é um vocabulário fechado (lib/erros/codigos.ts)
    // e o piso do motivo não é um fato que o host precise receber do servidor --
    // a tela já o impõe antes de enviar, com o texto ao lado do campo.
    return erroHttp("INVALID_REQUEST");
  }

  const admin = createAdminClient();

  // O estado ATUAL, antes de escrever: é o que separa "não existe" de "existe e
  // não está entregue" de "não deu para gravar". Mesma leitura prévia e mesma
  // razão da rota de revisão.
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
  if (atual.status === "suspended") {
    // Já está fora do ar: o ato não acontece de novo e NÃO é erro de servidor.
    // Devolver sucesso aqui seria mentir sobre ter registrado um segundo ato.
    return NextResponse.json({ success: true, ja_estava_fora_do_ar: true });
  }
  if (atual.status !== "delivered") {
    return erroHttp("PROGNOSTIC_SUSPENSION_REFUSED", {
      detalhes: { estado_do_documento: atual.status },
    });
  }

  type SelectMany<T> = { data: T[] | null; error: { message: string; code?: string } | null };
  const { data: gravadas, error } = await (
    admin.from("prognostics") as unknown as {
      update(v: Record<string, unknown>): {
        eq(c: string, v: string): {
          eq(c: string, v: string): {
            select(cols: string): Promise<SelectMany<{ id: string }>>;
          };
        };
      };
    }
  )
    .update({
      status: "suspended",
      suspenso_por: user.id,
      suspenso_por_email: user.email ?? null,
      suspensao_motivo: parsed.data.motivo,
      // `suspenso_em` NÃO é escrito aqui de propósito: o gatilho da 027 o
      // carimba com `now()` do banco e descarta o que a aplicação puser nele.
      // O relógio de quem chamou não entra no livro-razão.
    })
    .eq("id", id)
    // Repete a trava no próprio UPDATE: entre a leitura acima e esta escrita o
    // documento pode ter saído de `delivered`, e aí nenhuma linha casa.
    .eq("status", "delivered")
    .select("id");

  if (error) {
    // `23514` é check_violation: é com ele que a cerca da 027 recusa (não está
    // entregue, sem autor, sem motivo). Recusa verificada do banco é desfecho de
    // produto, não falha de servidor, e o texto cru do banco nunca chega ao host.
    if (error.code === "23514") {
      return erroHttp("PROGNOSTIC_SUSPENSION_REFUSED", {
        causa: error.message,
        detalhes: { estado_do_documento: atual.status },
      });
    }
    return erroHttp("PROGNOSTIC_WRITE_UNAVAILABLE", { causa: error.message });
  }

  if (!gravadas || gravadas.length === 0) {
    // Nada casou: o estado saiu de `delivered` entre a leitura e a escrita.
    return erroHttp("PROGNOSTIC_SUSPENSION_REFUSED", {
      causa: "estado mudou entre a leitura e a escrita",
      detalhes: { estado_do_documento: atual.status },
    });
  }

  return NextResponse.json({ success: true });
}
