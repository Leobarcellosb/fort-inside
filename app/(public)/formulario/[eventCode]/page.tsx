import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CinematicHero } from "@/components/features/participant/CinematicHero";
import {
  FormularioPublico,
  type EtapaDoFormulario,
} from "@/components/features/participant/FormularioPublico";
import { imagemDoAmbiente, marcaDoEvento, rotuloDaMarca } from "@/lib/cinematic-map";
import type { Event, QuizStage } from "@/types/database";

/*
 * A PAGINA PUBLICA DO QUESTIONARIO -- /formulario/[eventCode]
 *
 * SEM AUTENTICACAO NENHUMA. A pessoa abre o link que recebeu no WhatsApp,
 * preenche e envia. Nao ha login, nao ha codigo por e-mail, nao ha sessao, e
 * nada nesta pagina cria credencial.
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
  "id" | "name" | "event_date" | "status" | "quiz_version" | "location_name" | "host_name"
>;

type LinhaDeEtapa = Pick<
  QuizStage,
  "id" | "stage_number" | "title" | "ambient_name" | "description" | "questions"
>;

const COLUNAS_DO_EVENTO =
  "id, name, event_date, status, quiz_version, location_name, host_name";

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
  return {
    title: `${evento.name} — Questionário de preparação`,
    description:
      "Algumas perguntas para o encontro ser sobre a sua vida, e não sobre um roteiro genérico. Leva alguns minutos e dá para parar e voltar depois.",
    openGraph: {
      title: `${evento.name} — Questionário de preparação`,
      description:
        "Algumas perguntas antes do encontro. Leva alguns minutos e dá para parar e voltar depois.",
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

  if (evento.status === "completed") {
    return (
      <Recado
        quizVersion={evento.quiz_version}
        titulo="Imersão encerrada"
        subtitulo={evento.name}
        texto="Esta imersão já foi concluída, então o questionário não recebe mais respostas. Se você acha que isso está errado, fale com a equipe do evento."
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

  const paraOFormulario: EtapaDoFormulario[] = ordenadas.map((e) => ({
    id: e.id,
    numero: e.stage_number as number,
    titulo: e.title,
    ambiente: e.ambient_name,
    descricao: e.description,
    questions: e.questions,
  }));

  const data = formatarData(evento.event_date);

  return (
    <main className="min-h-screen bg-background" {...marcaDoEvento(evento.quiz_version)}>
      <CinematicHero
        variant="compact"
        imageSrc={imagemDoAmbiente("join", evento.quiz_version)}
        imageAlt="Preparação para a imersão"
        eyebrow={rotuloDaMarca(evento.quiz_version)}
        title="Antes do encontro"
        subtitle={
          data
            ? `${evento.name} · ${data}${evento.location_name ? ` · ${evento.location_name}` : ""}`
            : evento.name
        }
      />
      <FormularioPublico
        eventCode={eventCode.toUpperCase()}
        eventName={evento.name}
        dataDoEvento={data}
        etapas={paraOFormulario}
      />
    </main>
  );
}
