import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { joinEventSchema } from "@/lib/schemas";
import { z } from "zod";

/*
 * ============================================================================
 * POR QUE ESTA ROTA NÃO AUTENTICA MAIS NINGUÉM -- LEIA ANTES DE "CONSERTAR"
 * ============================================================================
 *
 * A versão anterior desta rota fazia o que parecia conveniente: o participante
 * digitava só o e-mail, a rota gerava uma senha, redefinia a senha da conta (se
 * já existisse) e DEVOLVIA a senha no corpo da resposta para o navegador fazer
 * signInWithPassword.
 *
 * Isso é uma tomada de conta. O QR do evento é público e carrega event_id e
 * event_code. Logo: QR público + e-mail de qualquer participante = a rota
 * redefine a senha daquela conta, entrega a senha nova e a pessoa errada entra
 * na conta, lendo respostas do quiz e o prognóstico. A única trava era recusar
 * role=admin, o que ainda vazava (403 só para admin) quais e-mails são de
 * administrador.
 *
 * A conveniência de "entrar apenas com e-mail" foi QUEBRADA DE PROPÓSITO, por
 * decisão do responsável técnico. Digitar um e-mail NÃO prova que a pessoa é
 * dona dele, e esta rota não tem como provar. A prova será um código de uso
 * único enviado ao e-mail (OTP do Supabase Auth), que cobre a entrada no
 * pré-evento e o retorno em outro dispositivo. Enquanto o envio de e-mail não
 * estiver configurado, a entrada FALHA DE FORMA SEGURA (503).
 *
 * Regras que esta rota NÃO pode voltar a violar, mesmo que alguém reclame que
 * "ficou ruim de entrar":
 *   1. Nunca redefinir senha de conta existente (updateUserById com password).
 *   2. Nunca devolver senha, token de sessão ou link de acesso no corpo, nem
 *      criar cookie de sessão. Nada nesta resposta serve de credencial.
 *   3. Nunca autenticar uma identidade, nova ou existente, só porque alguém
 *      informou um e-mail. Autenticar um e-mail inédito sem prová-lo também é
 *      falha: quem digita o e-mail de outra pessoa antes dela ficaria com uma
 *      sessão aberta na conta que ela mesma usará depois (conta pré-sequestrada).
 *   4. Nunca responder de forma diferente para admin, participante comum ou
 *      e-mail inédito (mesmo status, mesmo texto): senão o formulário público
 *      vira oráculo de "este e-mail existe / é administrador".
 *
 * Para reativar a entrada: implemente a verificação por código (signInWithOtp +
 * verifyOtp) em outra rota/fluxo e troque a resposta de INDISPONIVEL por um
 * "enviamos um código para o seu e-mail". NÃO devolva a senha de volta.
 * ============================================================================
 */

const bodySchema = joinEventSchema.extend({
  event_id: z.string().uuid(),
  event_code: z.string(),
});

// Resposta ÚNICA para qualquer e-mail que passe pela validação (novo, comum ou
// administrador). Mesmo status, mesmo corpo: ver regra 4 acima. Não pode citar
// "conta existente" nem "conta nova", e não pode culpar a pessoa.
const ENTRADA_INDISPONIVEL = {
  error:
    "Ainda não conseguimos liberar a sua entrada. Agora o acesso é confirmado por um código de uso único enviado ao seu e-mail, e esse envio ainda não está disponível. Não é problema com os seus dados. Avise a equipe do evento e, assim que o envio estiver ativo, entre de novo com o mesmo e-mail.",
  codigo: "entrada_por_codigo_indisponivel",
} as const;

function entradaIndisponivel() {
  return NextResponse.json(ENTRADA_INDISPONIVEL, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

function erroInterno() {
  return NextResponse.json(
    { error: "Não foi possível concluir agora. Tente novamente em instantes." },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  // Corpo malformado (JSON quebrado, vazio, tipo errado) é erro do cliente: 400,
  // nunca 500. A mensagem não ecoa nada do que foi enviado.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  const { full_name, phone, course_or_moment, event_id } = parsed.data;
  // O GoTrue guarda e-mail em minúsculas; usar a mesma forma aqui mantém
  // participants.email consistente com auth.users.email.
  const email = parsed.data.email.trim().toLowerCase();
  const supabase = createAdminClient();

  // Validação barata antes do trabalho caro (criar usuário envolve hash de senha).
  const { data: event } = await supabase
    .from("events")
    .select("id, max_participants, status")
    .eq("id", event_id)
    .single() as { data: { id: string; max_participants: number; status: string } | null; error: unknown };

  if (!event) {
    return NextResponse.json({ error: "Evento não encontrado" }, { status: 404 });
  }

  // Senha aleatória, descartada: existe só porque a conta precisa de um segredo
  // que ninguém conhece. Nunca é devolvida, logada nem usada para login.
  const senhaDescartavel = randomBytes(24).toString("base64url");

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password: senhaDescartavel,
    email_confirm: true,
    user_metadata: { full_name },
  });

  // --------------------------------------------------------------------------
  // CAMINHO 1: e-mail JÁ EXISTE no Auth (participante, admin, qualquer conta).
  // Não toca em nada: nem senha, nem participante, nem metadados. Não consulta
  // a conta (não lê app_metadata), então admin e comum percorrem exatamente o
  // mesmo código e recebem exatamente a mesma resposta. O retorno é pelo código
  // de uso único (ver comentário no topo).
  // --------------------------------------------------------------------------
  if (createError) {
    const jaExiste =
      createError.code === "email_exists" ||
      createError.code === "user_already_exists" ||
      /already been registered/i.test(createError.message);

    if (jaExiste) return entradaIndisponivel();

    // Qualquer outra falha do GoTrue: loga só o código (a mensagem do GoTrue
    // pode conter o e-mail) e NÃO devolve a mensagem ao cliente.
    console.error("[join-event] falha ao criar usuário", {
      code: createError.code,
      status: createError.status,
    });
    return erroInterno();
  }

  // --------------------------------------------------------------------------
  // CAMINHO 2: e-mail NOVO. Cria a conta (com a senha descartável) e a linha de
  // participante vinculada, para que o retorno por código encontre tudo pronto.
  // NÃO abre sessão: ver regra 3 no topo. Resposta idêntica à do caminho 1.
  // --------------------------------------------------------------------------
  const userId = created.user.id;

  const { error: pErr } = await (supabase.from("participants") as unknown as {
    insert(v: Record<string, unknown>): Promise<{ error: { code?: string } | null }>;
  }).insert({
    event_id,
    user_id: userId,
    full_name,
    email,
    phone: phone ?? null,
    course_or_moment: course_or_moment ?? null,
  });

  if (pErr) {
    // Sem a linha de participante a conta recém-criada ficaria órfã. Desfaz.
    // (23505 = já havia participante com este e-mail neste evento sem conta no
    // Auth, ex.: conta apagada. NÃO re-vincula: isso entregaria os dados antigos
    // a quem só digitou o e-mail.)
    await supabase.auth.admin.deleteUser(userId).catch(() => undefined);
    console.error("[join-event] falha ao registrar participante", { code: pErr.code });
    if (pErr.code === "23505") return entradaIndisponivel();
    return erroInterno();
  }

  return entradaIndisponivel();
}
