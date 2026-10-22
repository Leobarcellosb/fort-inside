import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { situacaoDoFormulario } from "@/app/api/formulario-publico/receber-formulario";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import { FormularioImersivo } from "@/components/features/participant/FormularioImersivo";
import type { EtapaImersiva } from "@/components/features/participant/formulario-imersivo/roteiro";
import { imagemDoAmbiente, marcaDoEvento, rotuloDaMarca } from "@/lib/cinematic-map";
import type { Event, QuizStage } from "@/types/database";

/*
 * A PAGINA PUBLICA DO QUESTIONARIO -- /formulario/[eventCode]
 *
 * SEM AUTENTICACAO NENHUMA. A pessoa abre o link que recebeu no WhatsApp,
 * preenche e envia. Nao ha login, nao ha codigo por e-mail, nao ha sessao, e
 * nada nesta pagina cria credencial.
 *
 * A EXPERIENCIA E A IMERSIVA (FormularioImersivo): uma pergunta por tela, no
 * estilo Typeform. A versao em lista (FormularioPublico) continua no repositorio
 * e envia pela mesma rota; o rascunho que ela deixou no aparelho e retomado aqui.
 *
 * ELA NAO SUBSTITUI /join/[eventCode], E NAO MEXE NELE. O fluxo com codigo
 * continua existindo, intacto, para quem precisa VOLTAR e ler o proprio
 * documento depois -- isso exige provar o e-mail, e vai continuar exigindo.
 * O que esta pagina resolve e outra coisa: COLETAR as respostas de preparacao
 * sem atrito, de gente que vai abrir o link uma vez, num celular.
 *
 * A LEITURA E PUBLICA DE VERDADE, nao um privilegio novo: `events_public_read` e
 * `quiz_stages_public_read` (migration 002) ja permitem a `anon` ler o evento e
 * as etapas -- e a mesma leitura que /join faz. Esta pagina nao le participante,
 * nao le resposta e nao le prognostico: ela so mostra as PERGUNTAS. A gravacao
 * nao acontece aqui; vai por /api/formulario-publico.
 */

interface Props {
  params: Promise<{ eventCode: string }>;
}

type LinhaDeEvento = Pick<
  Event,
  | "id"
  | "name"
  | "event_date"
  | "status"
  | "quiz_version"
  | "location_name"
  | "host_name"
  | "form_closes_at"
  | "mode"
>;

type LinhaDeEtapa = Pick<
  QuizStage,
  "id" | "stage_number" | "title" | "ambient_name" | "description" | "questions"
>;

export const viewport: Viewport = {
  themeColor: "#F7F7F6",
};

const COLUNAS_DO_EVENTO =
  "id, name, event_date, status, quiz_version, location_name, host_name, form_closes_at, mode";

async function lerEvento(eventCode: string) {
  const supabase = await createClient();
  const { data } = (await supabase
    .from("events")
    .select(COLUNAS_DO_EVENTO)
    .eq("event_code", eventCode.toUpperCase())
    .maybeSingle()) as { data: LinhaDeEvento | null; error: unknown };
  return { supabase, evento: data };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // O link vai por WhatsApp, onde o que aparece e o titulo e a descricao. Sem
  // isto a previa mostraria o titulo generico do app, e um link sem contexto num
  // grupo de adolescentes parece golpe.
  const { eventCode } = await params;
  const { evento } = await lerEvento(eventCode);
  if (!evento) return { title: "Formulário não encontrado" };
  // A imagem da previa precisa de endereco absoluto, e ele sai do proprio host
  // que serviu a pagina: o link que circula e o marcozero-gp, nao o dominio
  // padrao do projeto na Vercel.
  const host = (await headers()).get("host");
  return {
    metadataBase: host ? new URL(`${host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"}://${host}`) : undefined,
    title: `${evento.name} | Questionário de preparação`,
    description:
      "Algumas perguntas para o encontro ser sobre a sua vida, e não sobre um roteiro genérico. Leva alguns minutos e dá para parar e voltar depois.",
    openGraph: {
      title: `${evento.name} | Questionário de preparação`,
      description:
        "Algumas perguntas antes do encontro. Leva alguns minutos e dá para parar e voltar depois.",
      images: [{ url: "/marco-zero/og-formulario.jpg", width: 1120, height: 630, alt: evento.name }],
    },
    robots: { index: false, follow: false },
  };
}

/** "sábado, 24 de outubro" -- formatado no SERVIDOR, no fuso do evento. */
function formatarData(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "America/Sao_Paulo",
    });
  } catch {
    return null;
  }
}

function Recado({
  quizVersion,
  titulo,
  subtitulo,
  texto,
}: {
  quizVersion: number;
  titulo: string;
  subtitulo: string;
  texto: string;
}) {
  return (
    <main className="min-h-screen bg-background" {...marcaDoEvento(quizVersion)}>
      <CinematicHero
        imageSrc={imagemDoAmbiente("join", quizVersion)}
        imageAlt={titulo}
        eyebrow={rotuloDaMarca(quizVersion)}
        title={titulo}
        subtitle={subtitulo}
      />
      <section className="px-6 py-16 max-w-md mx-auto">
        <p className="text-sm text-muted-foreground leading-relaxed text-center">{texto}</p>
      </section>
    </main>
  );
}

export default async function FormularioPage({ params }: Props) {
  const { eventCode } = await params;
  const { supabase, evento } = await lerEvento(eventCode);

  // Codigo que nao existe: 404. Nao se diz "este evento nao existe mas aquele
  // sim" -- a pagina nao e um oraculo de quais codigos valem.
  if (!evento) notFound();

  // A MESMA regra do servidor (receber-formulario.ts), sem tolerancia: a pagina
  // so deixa de oferecer o que o servidor ja recusaria.
  const situacao = situacaoDoFormulario(evento, new Date());

  if (situacao === "evento_encerrado") {
    return (
      <Recado
        quizVersion={evento.quiz_version}
        titulo="Imersão encerrada"
        subtitulo={evento.name}
        texto="Esta imersão já foi concluída, então o questionário não recebe mais respostas. Se você acha que isso está errado, fale com a equipe do evento."
      />
    );
  }

  if (situacao === "prazo_indeterminado") {
    return (
      <Recado
        quizVersion={evento.quiz_version}
        titulo="Questionário indisponível"
        subtitulo={evento.name}
        texto="O questionário está indisponível no momento. Fale com a equipe do evento."
      />
    );
  }
  if (situacao === "prazo_encerrado") {
    return (
      <Recado
        quizVersion={evento.quiz_version}
        titulo="Prazo encerrado"
        subtitulo={evento.name}
        texto="O prazo para responder o questionário terminou. Se você ainda precisa responder, fale com a equipe do evento."
      />
    );
  }

  const { data: etapas } = (await supabase
    .from("quiz_stages")
    .select("id, stage_number, title, ambient_name, description, questions")
    .eq("quiz_version", evento.quiz_version)) as {
    data: LinhaDeEtapa[] | null;
    error: unknown;
  };

  const ordenadas = [...(etapas ?? [])].sort(
    (a, b) => (a.stage_number ?? a.id) - (b.stage_number ?? b.id),
  );

  // MESMO criterio do servidor (receber-formulario.ts) e do gatilho da migration
  // 028: os numeros das etapas tem de ser 1..N. Se nao forem, a pagina NAO
  // mostra um formulario pela metade -- ela diz que o questionario nao esta
  // disponivel. Mostrar 3 de 5 etapas colheria resposta incompleta que nunca
  // viraria documento.
  const numeros = ordenadas.map((e) => e.stage_number);
  const utilizavel =
    ordenadas.length > 0 &&
    numeros.every((n) => typeof n === "number") &&
    (numeros as number[]).every((n, i) => n === i + 1) &&
    ordenadas.every((e) => Array.isArray(e.questions) && e.questions.length > 0);

  if (!utilizavel) {
    return (
      <Recado
        quizVersion={evento.quiz_version}
        titulo="Questionário indisponível"
        subtitulo={evento.name}
        texto="O questionário deste evento não está disponível para resposta agora. Isso não é problema com os seus dados nem com o seu link. Avise a equipe do evento."
      />
    );
  }

  const paraOFormulario: EtapaImersiva[] = ordenadas.map((e) => ({
    id: e.id,
    numero: e.stage_number as number,
    titulo: e.title,
    // Sem travessao no que o participante le (pedido do dono: travessao tem
    // "cara de IA"). O texto guardado no banco nao muda; so a exibicao troca
    // "1 — Discordo" por "1: Discordo".
    descricao: e.description ? e.description.replace(/\s*[—–]\s*/g, ": ") : e.description,
    questions: e.questions,
  }));

  return (
    <main className="min-h-screen bg-background" {...marcaDoEvento(evento.quiz_version)}>
      <FormularioImersivo
        eventCode={eventCode.toUpperCase()}
        eventName={evento.name}
        dataDoEvento={formatarData(evento.event_date)}
        etapas={paraOFormulario}
      />
    </main>
  );
}
