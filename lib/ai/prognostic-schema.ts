import { z } from "zod";

// Schema em tempo de execucao da saida da IA. Espelha PrognosticContent.
// Fica aqui, e nao dentro de generate-prognostic.ts, para que o orquestrador do
// veto (gerar-com-veto.ts) possa ser testado sem instanciar o SDK da Anthropic.
//
// Pisos de array em 1, nao 3. Structured outputs repassam minItems/maxItems
// ao modelo como dica mas NAO os impoem no servidor ("complex array
// constraints" nao sao suportadas), entao um piso alto aqui nunca produz mais
// itens: so destroi geracoes validas. Um participante que respondeu so as
// escalas e deixou as abertas vazias rendeu 2 areas-chave, e o .min(3)
// descartou a geracao inteira depois de 98 segundos, deixando a pessoa sem
// prognostico nenhum. Entregar um mapa mais curto e melhor que nao entregar.
// O tamanho desejado (3 a 5) e pedido no prompt, que e onde ele funciona.
export const prognosticContentSchema = z.object({
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
    .min(1)
    .max(6),
  plano_30_dias: z
    .array(
      z.object({
        titulo: z.string().min(1),
        objetivos: z.array(z.string().min(1)).min(1).max(5),
        acao: z.string().min(1),
        resultado_esperado: z.string().min(1),
      })
    )
    .min(1)
    .max(6),
  praticas: z
    .array(z.object({ nome: z.string().min(1), descricao: z.string().min(1) }))
    .min(1)
    .max(6),
  frase_ativacao: z.object({
    frase: z.string().min(1),
    contexto: z.string().min(1),
    aplicacao: z.string().min(1),
    pergunta_pratica: z.string().min(1),
  }),
  trilha_recomendada: z.enum([
    "Exploração",
    "Direção",
    "Aproximação",
    "Aceleração",
    "Sessão Privada",
  ]),
  justificativa_trilha: z.string().min(1),
});

// Resposta do pedido de correcao pontual (ver gerar-com-veto.ts): so os campos
// que o veto recusou, cada um com o texto reescrito.
export const correcoesSchema = z.object({
  correcoes: z
    .array(z.object({ campo: z.string().min(1), texto: z.string().min(1) }))
    .min(1)
    .max(40),
});
