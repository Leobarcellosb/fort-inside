import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ipDoCliente,
  verificacoesPorEmail,
  verificacoesPorIp,
} from "@/lib/auth/limite-entrada";
import {
  DADOS_INVALIDOS,
  ERRO_INTERNO,
  EVENTO_NAO_ENCONTRADO,
  NO_STORE,
  buscaEventoAberto,
  emailSchema,
  erro,
  eventoSchema,
  leCorpoJson,
} from "@/lib/auth/entrada";

/*
 * ============================================================================
 * ENTRADA POR CODIGO, PASSO 2: VERIFICAR O CODIGO  (POST /api/entrar/verificar)
 * ============================================================================
 *
 * Unico lugar do app onde um participante ganha sessao. O codigo certo
 * (verifyOtp) e a PROVA de que a pessoa le a caixa de entrada daquele e-mail;
 * so depois dela:
 *   - a sessao e gravada nos cookies (cliente @supabase/ssr, os mesmos que o
 *     navegador, /api/complete-quiz e o RLS ja usam);
 *   - a pessoa e vinculada ao participante DAQUELE evento, ou o participante e
 *     criado.
 *
 * REGRAS
 *   1. Codigo errado, expirado, ja usado, ou de e-mail inexistente: MESMA
 *      recusa (401, texto unico). Nada diz qual deles foi.
 *   2. O corpo NAO decide quem a pessoa e. O e-mail do participante vem da
 *      conta que acabou de ser provada (data.user.email), nunca do campo
 *      "email" do corpo (que so serve para o GoTrue achar o codigo). O nome e
 *      o telefone vem do corpo porque sao rotulos do proprio participante.
 *   3. Para participante que JA existe neste evento, nome/telefone do corpo sao
 *      ignorados (nao se sobrescreve dado de quem ja entrou).
 *   4. Re-vinculo: se existe linha de participante com este e-mail neste evento
 *      mas SEM conta (user_id nulo, ex.: conta apagada), ela e reaproveitada,
 *      porque agora o e-mail foi PROVADO (em /api/join-event isto era proibido
 *      justamente porque la o e-mail so era digitado). Se a linha pertence a
 *      OUTRA conta, nao toca e recusa.
 *   5. Mensagem do GoTrue nunca vai ao cliente; so code/status no log.
 *   6. Corpo malformado => 400. Contencao e validacao antes do trabalho caro.
 *   7. Resposta de sucesso: so ids. Nenhum token no corpo; a sessao viaja
 *      apenas em Set-Cookie.
 *
 * Se o vinculo falhar DEPOIS do codigo aceito (evento lotado, conflito), a
 * sessao e encerrada aqui mesmo: nao deixamos autenticado quem nao entrou.
 * ============================================================================
 */

const bodySchema = z.object({
  email: emailSchema,
  // Aceita "123 456" / "123-456": so digitos contam. O comprimento e
  // configuravel no Supabase (6 a 10), por isso a faixa.
  token: z
    .string()
    .max(32)
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().regex(/^\d{6,10}$/)),
  ...eventoSchema,
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional(),
  course_or_moment: z.string().trim().max(300).optional(),
});

const CODIGO_INVALIDO =
  "Código inválido ou expirado. Confira o código ou peça um novo.";

function recusado() {
  return erro(401, CODIGO_INVALIDO, { codigo: "codigo_invalido" });
}

function limitado(retryAfterS: number) {
  return erro(429, "Muitas tentativas. Aguarde alguns minutos e tente de novo.", {
    codigo: "limite_de_tentativas",
    retryAfterS,
  });
}

type ParticipanteRow = { id: string; user_id: string | null; email: string };

type Vinculo =
  | { ok: true; participantId: string }
  | { ok: false; status: number; mensagem: string; codigo: string };

async function vinculaParticipante(args: {
  userId: string;
  email: string;
  eventId: string;
  maxParticipants: number;
  fullName: string;
  phone?: string;
  courseOrMoment?: string;
}): Promise<Vinculo> {
  const admin = createAdminClient();
  const { userId, email, eventId } = args;

  // Todas as linhas do evento (limite pequeno: max_participants <= 20). Comparar
  // e-mail em JS evita ILIKE, onde "_" e "%" do endereco viram curinga.
  async function lista(): Promise<ParticipanteRow[] | null> {
    const { data, error } = (await admin
      .from("participants")
      .select("id, user_id, email")
      .eq("event_id", eventId)) as unknown as {
      data: ParticipanteRow[] | null;
      error: { code?: string } | null;
    };
    if (error || !data) {
      console.error("[entrar/verificar] falha ao ler participantes", { code: error?.code });
      return null;
    }
    return data;
  }

  function procura(rows: ParticipanteRow[]) {
    const dele = rows.find((r) => r.user_id === userId);
    if (dele) return { tipo: "dele" as const, row: dele };
    const doEmail = rows.find((r) => r.email.trim().toLowerCase() === email);
    if (doEmail) return { tipo: "do_email" as const, row: doEmail };
    return { tipo: "nenhum" as const };
  }

  const falhaInterna: Vinculo = {
    ok: false,
    status: 500,
    mensagem: ERRO_INTERNO,
    codigo: "erro_interno",
  };

  let rows = await lista();
  if (!rows) return falhaInterna;
  let achado = procura(rows);

  if (achado.tipo === "dele") return { ok: true, participantId: achado.row.id };

  if (achado.tipo === "do_email") {
    if (achado.row.user_id !== null) {
      // O e-mail provado bate com uma linha que pertence a OUTRA conta. Nao
      // reatribui: seria entregar dados de uma conta a outra.
      console.error("[entrar/verificar] linha de participante pertence a outra conta");
      return {
        ok: false,
        status: 409,
        mensagem:
          "Não foi possível vincular a sua entrada a este evento. Avise a equipe do evento.",
        codigo: "conflito_de_participante",
      };
    }
    // Linha sem conta + e-mail provado: reaproveita. Condicional (.is null)
    // para duas requisicoes simultaneas nao disputarem a mesma linha.
    const { data: atualizada, error } = (await (admin.from("participants") as unknown as {
      update(v: Record<string, unknown>): {
        eq(c: string, v: string): {
          is(c: string, v: null): { select(cols: string): Promise<{ data: { id: string }[] | null; error: { code?: string } | null }> };
        };
      };
    })
      .update({ user_id: userId })
      .eq("id", achado.row.id)
      .is("user_id", null)
      .select("id")) ;
    if (error || !atualizada || atualizada.length === 0) {
      console.error("[entrar/verificar] falha ao re-vincular participante", { code: error?.code });
      return falhaInterna;
    }
    return { ok: true, participantId: achado.row.id };
  }

  // Nenhum: participante novo. Capacidade so vale para quem ainda nao entrou.
  if (rows.length >= args.maxParticipants) {
    return {
      ok: false,
      status: 409,
      mensagem: "Vagas esgotadas para este evento.",
      codigo: "vagas_esgotadas",
    };
  }

  const { data: criado, error: insErr } = (await (admin.from("participants") as unknown as {
    insert(v: Record<string, unknown>): {
      select(cols: string): { single(): Promise<{ data: { id: string } | null; error: { code?: string } | null }> };
    };
  })
    .insert({
      event_id: eventId,
      user_id: userId,
      full_name: args.fullName,
      email,
      phone: args.phone || null,
      course_or_moment: args.courseOrMoment || null,
    })
    .select("id")
    .single());

  if (insErr || !criado) {
    if (insErr?.code === "23505") {
      // Corrida: outra requisicao (ou aba) inseriu entre a leitura e a escrita.
      rows = await lista();
      if (!rows) return falhaInterna;
      achado = procura(rows);
      if (achado.tipo === "dele") return { ok: true, participantId: achado.row.id };
    }
    console.error("[entrar/verificar] falha ao criar participante", { code: insErr?.code });
    return falhaInterna;
  }
  return { ok: true, participantId: criado.id };
}

export async function POST(req: NextRequest) {
  // 1. Corpo e validacao.
  const body = await leCorpoJson(req);
  if (body === null) return erro(400, DADOS_INVALIDOS);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return erro(400, DADOS_INVALIDOS);
  const { email, token, event_id, event_code, full_name, phone, course_or_moment } = parsed.data;

  // 2. Contencao de palpites ANTES de qualquer rede. Cada tentativa conta,
  //    certa ou errada (so zeramos o e-mail apos sucesso).
  const ip = ipDoCliente(req.headers);
  const porIp = verificacoesPorIp.tenta(ip);
  if (!porIp.ok) return limitado(porIp.retryAfterS);
  const porEmail = verificacoesPorEmail.tenta(email);
  if (!porEmail.ok) return limitado(porEmail.retryAfterS);

  // 3. Evento valido ANTES de gastar o codigo (que e de uso unico).
  const evento = await buscaEventoAberto(event_id, event_code);
  if (!evento) return erro(404, EVENTO_NAO_ENCONTRADO);

  // 4. A prova: codigo correto => sessao nos cookies. Cliente SSR: e ele que
  //    grava o Set-Cookie (cookies do next/headers).
  const sessao = await createClient();
  const { data, error: otpError } = await sessao.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (otpError || !data.user || !data.session) {
    if (otpError) {
      console.error("[entrar/verificar] codigo recusado", {
        code: otpError.code,
        status: otpError.status,
      });
      if (otpError.status === 429) return limitado(60);
      if (typeof otpError.status === "number" && otpError.status >= 500) {
        return erro(503, "Não conseguimos verificar o código agora. Tente de novo em instantes.", {
          codigo: "verificacao_indisponivel",
        });
      }
    }
    // Errado, expirado, ja usado, e-mail inexistente: tudo igual (regra 1).
    return recusado();
  }

  // Cinto e suspensorio: a conta que o GoTrue autenticou tem que ser a do e-mail
  // informado. Se nao for, nao deixamos sessao aberta.
  const emailProvado = data.user.email?.trim().toLowerCase();
  if (emailProvado !== email) {
    console.error("[entrar/verificar] e-mail da sessao diverge do informado");
    await sessao.auth.signOut({ scope: "local" }).catch(() => undefined);
    return recusado();
  }

  // Provou o e-mail: nao precisamos mais conter palpites deste e-mail.
  verificacoesPorEmail.zera(email);

  // 5. Vinculo ao participante do evento (e-mail e user_id vem da conta provada).
  const vinculo = await vinculaParticipante({
    userId: data.user.id,
    email: emailProvado,
    eventId: evento.id,
    maxParticipants: evento.max_participants,
    fullName: full_name,
    phone,
    courseOrMoment: course_or_moment,
  });

  if (!vinculo.ok) {
    await sessao.auth.signOut({ scope: "local" }).catch(() => undefined);
    return erro(vinculo.status, vinculo.mensagem, { codigo: vinculo.codigo });
  }

  // 6. Sucesso. So ids no corpo; a sessao ja foi nos cookies.
  return NextResponse.json(
    { ok: true, participant_id: vinculo.participantId, event_id: evento.id },
    { status: 200, headers: NO_STORE }
  );
}
