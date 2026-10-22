import type { PrognosticContent } from "@/types/database";

// Documento que passa pelo veto. Usado por *.test.ts.
export function prognosticoLimpo(): PrognosticContent {
  return {
    analise_geral:
      "Nas situações respondidas, as escolhas ficaram espalhadas e não apontam uma preferência clara. Isso não diz nada sobre falta de traço marcante.\n\nA decisão adiada sobre a presidência da associação organiza o resto. **Adiar protege um papel que já pesa.** Intenção sem data vira ruído.",
    areas_chave: [
      {
        nome: "Decisão adiada",
        diagnostico: "A presidência aparece como a pendência central. **O adiamento tem custo** e a energia dele sai de outro lugar.",
        risco: "O risco é gastar mais um semestre sustentando um papel que já não cabe.",
        movimento: "Marcar uma data para decidir e comunicar a decisão a duas pessoas.",
      },
      {
        nome: "Energia e sono",
        diagnostico: "Você aponta o sono como o ponto que mais pede atenção agora. **Sem descanso, nenhuma decisão fica nítida.**",
        risco: "O risco é decidir cansada e depois rever tudo.",
        movimento: "Fixar três treinos semanais e um horário de dormir.",
      },
    ],
    plano_30_dias: [
      {
        titulo: "Fechar a decisão da presidência",
        objetivos: ["Listar critérios", "Conversar com duas pessoas", "Registrar a decisão"],
        acao: "Escreva em uma página o que a presidência pede e o que devolve. Marque as duas conversas para a semana dois.",
        resultado_esperado: "Uma decisão registrada, com data para ser comunicada.",
      },
    ],
    praticas: [
      {
        nome: "Registrar",
        descricao: "Anotar ao fim do dia **uma decisão tomada** e uma adiada. A lista curta mostra o que se repete.",
      },
    ],
    frase_ativacao: {
      frase: "Decisão adiada continua custando, só não aparece na conta.",
      contexto: "O adiamento descrito pede um prazo, não mais reflexão.",
      aplicacao: "Escolha a pendência mais antiga e dê a ela uma data nas próximas duas semanas.",
      pergunta_pratica: "Qual decisão eu ainda trato como se não tivesse prazo?",
    },
    trilha_recomendada: "Direção",
    justificativa_trilha:
      "O que as respostas abertas mostram é uma pendência concreta e pouco ambiente para decidi-la. A trilha de Direção trabalha a capacidade de transformar intenção em critério.\n\nSem critério, qualquer escolha vira desgaste.",
  };
}
