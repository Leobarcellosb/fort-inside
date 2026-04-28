import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { PrognosticContent } from "@/types/database";
import type { ReactNode } from "react";

// Editorial deck-style layout — A4 PORTRAIT.
// Yuri Fortes brandbook: white paper + charcoal #232323 accents.
// Bold inline rendering via **markdown** parsing.
const CHARCOAL = "#232323";
const DARK = "#232323";
const MID = "#525252";
const HAIRLINE = "#E0E0E0";

// Logo loaded via absolute URL — react-pdf renders server-side and needs a
// reachable URL. NEXT_PUBLIC_APP_URL is set in Vercel; fallback to prod URL.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://fort-inside.vercel.app";
const LOGO_URL = `${APP_URL}/logo-yuri.png`;

const styles = StyleSheet.create({
  // PAGES — A4 portrait
  page: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 60,
    paddingHorizontal: 60,
    fontFamily: "Helvetica",
  },
  coverPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 50,
    paddingHorizontal: 60,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  closingPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 50,
    paddingHorizontal: 60,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },

  // COVER LOGO (top)
  coverLogoBlock: { alignItems: "center", marginBottom: 30 },
  coverLogo: { width: 80, height: 80 },

  // COVER content
  coverContent: {
    flex: 1,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "flex-start",
  },
  coverEyebrow: {
    fontSize: 11,
    letterSpacing: 3,
    color: DARK,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  coverSubtitle: { fontSize: 17, color: MID, marginBottom: 30 },
  pageTitle: {
    fontSize: 60,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    lineHeight: 1.05,
    marginBottom: 0,
  },
  coverFooter: {
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
  },

  // SECTION HEADLINES
  sectionHeadline: {
    fontSize: 36,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionHeadlineSmall: {
    fontSize: 12,
    letterSpacing: 2.5,
    color: CHARCOAL,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionGap: { height: 24 },

  // SUBSECTION
  subsectionHeading: {
    fontSize: 18,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },

  // BODY
  body: { fontSize: 13, color: DARK, lineHeight: 1.7 },
  bodySpaced: { fontSize: 13, color: DARK, lineHeight: 1.7, marginBottom: 12 },
  bodyMid: { fontSize: 13, color: DARK, lineHeight: 1.55, marginTop: 6 },

  labelTiny: {
    fontSize: 9,
    letterSpacing: 1.5,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom: 4,
    marginTop: 8,
  },

  // TRAIL BADGES
  trailBadge: {
    borderWidth: 1,
    borderColor: CHARCOAL,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignSelf: "flex-start",
    marginTop: 0,
    marginBottom: 40,
  },
  trailText: {
    fontSize: 11,
    color: CHARCOAL,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  trailBadgeBig: {
    borderWidth: 1.5,
    borderColor: CHARCOAL,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 24,
    alignSelf: "flex-start",
    marginTop: 16,
    marginBottom: 24,
  },
  trailTextBig: {
    fontSize: 13,
    color: CHARCOAL,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
  },

  // ÁREAS-CHAVE — vertical stacked blocks (full width)
  areaBlock: { marginBottom: 28 },
  riscoText: {
    fontSize: 13,
    color: DARK,
    fontStyle: "italic",
    lineHeight: 1.55,
    marginTop: 6,
  },
  movimentoText: {
    fontSize: 13,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    lineHeight: 1.55,
    marginTop: 6,
  },

  // PLANO 30 DIAS — vertical cards
  planoCard: {
    borderWidth: 1,
    borderColor: CHARCOAL,
    padding: 18,
    marginBottom: 16,
  },
  planoTitle: {
    fontSize: 16,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 10,
  },
  planoBullet: {
    flexDirection: "row",
    marginBottom: 4,
  },
  planoBulletDot: {
    fontSize: 13,
    color: CHARCOAL,
    width: 12,
  },
  planoBulletText: {
    fontSize: 12,
    color: DARK,
    lineHeight: 1.5,
    flex: 1,
  },

  // PILARES — vertical stacked blocks (full width, charcoal left rule)
  pilarBlock: {
    marginBottom: 22,
    borderLeftWidth: 2,
    borderLeftColor: CHARCOAL,
    paddingLeft: 14,
  },
  praticaName: {
    fontSize: 16,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  praticaDescription: {
    fontSize: 12,
    color: DARK,
    lineHeight: 1.6,
  },

  // FRASE DE ATIVAÇÃO
  fraseCenterContainer: {
    flex: 1,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
  },
  quoteBox: {
    paddingVertical: 30,
    paddingHorizontal: 24,
    borderTopWidth: 1.5,
    borderTopColor: CHARCOAL,
    borderBottomWidth: 1.5,
    borderBottomColor: CHARCOAL,
    marginVertical: 16,
    width: "100%",
  },
  fraseQuoteMark: {
    fontSize: 70,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    lineHeight: 0.8,
    marginBottom: -8,
    textAlign: "center",
  },
  fraseQuote: {
    fontSize: 24,
    color: CHARCOAL,
    fontStyle: "italic",
    lineHeight: 1.4,
    textAlign: "center",
  },
  fraseBlock: {
    marginTop: 18,
    width: "100%",
  },
  perguntaBox: {
    marginTop: 16,
    padding: 14,
    borderLeftWidth: 2,
    borderLeftColor: CHARCOAL,
    backgroundColor: "#F5F4F0",
  },
  perguntaLabel: {
    fontSize: 9,
    letterSpacing: 2,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  perguntaText: {
    fontSize: 14,
    color: CHARCOAL,
    fontStyle: "italic",
    lineHeight: 1.5,
  },

  // CLOSING
  closingTop: { paddingTop: 10 },
  closingMessage: {
    fontSize: 15,
    color: DARK,
    fontStyle: "italic",
    lineHeight: 1.6,
    textAlign: "center",
    marginTop: 30,
  },
  closingCenter: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 30,
  },
  closingThanks: {
    fontSize: 56,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 16,
  },
  closingSignature: { fontSize: 15, color: MID },
  closingFooterLogoBlock: { alignItems: "center" },
  closingFooterLogo: { width: 32, height: 32 },

  // YURI NOTE (closing page)
  yuriNoteBox: {
    borderLeftWidth: 2,
    borderLeftColor: CHARCOAL,
    paddingLeft: 14,
    marginBottom: 24,
    width: "100%",
  },
  yuriNoteLabel: {
    fontSize: 9,
    letterSpacing: 2,
    color: CHARCOAL,
    textTransform: "uppercase",
    marginBottom: 5,
  },
  yuriNoteText: {
    fontSize: 13,
    color: DARK,
    lineHeight: 1.65,
    fontStyle: "italic",
  },

  // FOOTER (pages 2+)
  footer: {
    position: "absolute",
    bottom: 30,
    left: 60,
    right: 60,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    paddingTop: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerText: { fontSize: 10, color: MID },
  footerLogo: { width: 24, height: 24 },
});

// Bold inline parser — splits "**texto**" into Helvetica-Bold runs.
// react-pdf renders <Text> children as inline runs when nested.
// Style is typed loosely (`any`) because react-pdf's Text union with SVGTextProps
// makes the strict StyleSheet type incompatible at the JSX boundary.
function renderBold(
  text: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseStyle?: any
): ReactNode[] {
  if (!text) return [];
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) => {
    if (part === "") return null;
    if (i % 2 === 1) {
      const merged = baseStyle
        ? [baseStyle, { fontFamily: "Helvetica-Bold" }]
        : { fontFamily: "Helvetica-Bold" };
      return (
        <Text key={i} style={merged}>
          {part}
        </Text>
      );
    }
    return (
      <Text key={i} style={baseStyle}>
        {part}
      </Text>
    );
  });
}

interface Props {
  participantName: string;
  eventName: string;
  eventDate: string;
  hostName: string;
  content: PrognosticContent;
  yuriNote: string | null;
}

export function PrognosticPdfDocument({
  participantName,
  eventName,
  eventDate,
  hostName,
  content,
  yuriNote,
}: Props) {
  const formattedDate = eventDate
    ? new Date(eventDate).toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  const firstName = participantName.trim().split(" ")[0];
  const analiseParagraphs = content.analise_geral.split(/\n\n+/).filter(Boolean);
  const contextoParagraphs = content.frase_ativacao.contexto
    .split(/\n\n+/)
    .filter(Boolean);
  const aplicacaoParagraphs = content.frase_ativacao.aplicacao
    .split(/\n\n+/)
    .filter(Boolean);
  const justificativaParagraphs = content.justificativa_trilha
    .split(/\n\n+/)
    .filter(Boolean);

  return (
    <Document
      title={`Mapa da Próxima Construção — ${participantName}`}
      author={hostName}
      subject="Fort Inside — Prognóstico Inicial de Direção"
    >
      {/* PAGE 1 — COVER */}
      <Page size="A4" orientation="portrait" style={styles.coverPage}>
        <View style={styles.coverLogoBlock}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.coverLogo} />
        </View>
        <View style={styles.coverContent}>
          <Text style={styles.coverEyebrow}>Mapa da Sua Próxima Construção</Text>
          <Text style={styles.coverSubtitle}>
            {eventName}
            {formattedDate ? ` · ${formattedDate}` : ""}
          </Text>
          <View style={styles.trailBadge}>
            <Text style={styles.trailText}>{content.trilha_recomendada}</Text>
          </View>
          <Text style={styles.pageTitle}>{firstName}</Text>
        </View>
        <View style={styles.coverFooter}>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
        </View>
      </Page>

      {/* PAGE 2 — ANÁLISE */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadline}>Análise</Text>
        <View style={styles.sectionGap} />
        {analiseParagraphs.map((p, i) => (
          <View key={i} style={{ marginBottom: 12 }} wrap={false}>
            <Text style={styles.body}>{renderBold(p, styles.body)}</Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 3 — ÁREAS-CHAVE (vertical stacked) */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadline}>Áreas-Chave</Text>
        <View style={styles.sectionGap} />
        {content.areas_chave.map((area, i) => (
          <View key={i} style={styles.areaBlock} wrap={false}>
            <Text style={styles.subsectionHeading}>{area.nome}</Text>
            <Text style={styles.body}>
              {renderBold(area.diagnostico, styles.body)}
            </Text>
            <Text style={styles.riscoText}>
              <Text style={{ fontFamily: "Helvetica-Bold", fontStyle: "normal" }}>
                Risco:{" "}
              </Text>
              {area.risco}
            </Text>
            <Text style={styles.movimentoText}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Movimento: </Text>
              {area.movimento}
            </Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 4 — PLANO 30 DIAS (cards verticais) */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadline}>Plano de 30 dias</Text>
        <View style={styles.sectionGap} />
        {content.plano_30_dias.map((step, i) => (
          <View key={i} style={styles.planoCard} wrap={false}>
            <Text style={styles.planoTitle}>{step.titulo}</Text>

            <Text style={styles.labelTiny}>Objetivos</Text>
            {step.objetivos.map((obj, j) => (
              <View key={j} style={styles.planoBullet}>
                <Text style={styles.planoBulletDot}>•</Text>
                <Text style={styles.planoBulletText}>{obj}</Text>
              </View>
            ))}

            <Text style={styles.labelTiny}>Ação</Text>
            <Text style={styles.body}>{renderBold(step.acao, styles.body)}</Text>

            <Text style={styles.labelTiny}>Resultado esperado</Text>
            <Text style={styles.body}>
              {renderBold(step.resultado_esperado, styles.body)}
            </Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 5 — PILARES (vertical stacked) */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadline}>Pilares</Text>
        <View style={styles.sectionGap} />
        {content.praticas.map((p, i) => (
          <View key={i} style={styles.pilarBlock} wrap={false}>
            <Text style={styles.praticaName}>{p.nome}</Text>
            <Text style={styles.praticaDescription}>
              {renderBold(p.descricao, styles.praticaDescription)}
            </Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 6 — FRASE DE ATIVAÇÃO */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadlineSmall}>Frase de ativação</Text>

        <View wrap={false}>
          <View style={styles.quoteBox}>
            <Text style={styles.fraseQuoteMark}>&ldquo;</Text>
            <Text style={styles.fraseQuote}>{content.frase_ativacao.frase}</Text>
          </View>
        </View>

        <View style={styles.fraseBlock}>
          <Text style={styles.labelTiny}>Contexto</Text>
          {contextoParagraphs.map((p, i) => (
            <Text key={i} style={styles.bodySpaced}>
              {renderBold(p, styles.bodySpaced)}
            </Text>
          ))}

          <Text style={styles.labelTiny}>Como aplicar</Text>
          {aplicacaoParagraphs.map((p, i) => (
            <Text key={i} style={styles.bodySpaced}>
              {renderBold(p, styles.bodySpaced)}
            </Text>
          ))}
        </View>

        <View style={styles.perguntaBox} wrap={false}>
          <Text style={styles.perguntaLabel}>Pergunte-se</Text>
          <Text style={styles.perguntaText}>
            {content.frase_ativacao.pergunta_pratica}
          </Text>
        </View>

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 7 — POR QUE ESTA TRILHA */}
      <Page size="A4" orientation="portrait" style={styles.page}>
        <Text style={styles.sectionHeadline}>Por que esta trilha</Text>
        <View style={styles.trailBadgeBig}>
          <Text style={styles.trailTextBig}>{content.trilha_recomendada}</Text>
        </View>
        <View style={styles.sectionGap} />
        {justificativaParagraphs.map((p, i) => (
          <View key={i} style={{ marginBottom: 12 }} wrap={false}>
            <Text style={styles.body}>{renderBold(p, styles.body)}</Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 8 — FECHAMENTO */}
      <Page size="A4" orientation="portrait" style={styles.closingPage}>
        <View style={styles.closingTop}>
          {yuriNote ? (
            <View style={styles.yuriNoteBox}>
              <Text style={styles.yuriNoteLabel}>Observação de {hostName}</Text>
              <Text style={styles.yuriNoteText}>&ldquo;{yuriNote}&rdquo;</Text>
            </View>
          ) : null}
          <Text style={styles.closingMessage}>
            Esta jornada é apenas o começo. Pratique com consistência.
          </Text>
        </View>
        <View style={styles.closingCenter}>
          <Text style={styles.closingThanks}>Obrigado!</Text>
          <Text style={styles.closingSignature}>{hostName}</Text>
        </View>
        <View style={styles.closingFooterLogoBlock}>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.closingFooterLogo} />
        </View>
      </Page>
    </Document>
  );
}
