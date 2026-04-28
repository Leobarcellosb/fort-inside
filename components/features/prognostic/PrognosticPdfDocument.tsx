import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { PrognosticContent } from "@/types/database";

// Editorial deck-style layout — A4 LANDSCAPE (slide format).
// Yuri Fortes brandbook: white paper + charcoal #232323 accents.
// Logo embed via remote URL (deploy URL or env var).
const CHARCOAL = "#232323";
const DARK = "#232323";
const MID = "#525252";
const HAIRLINE = "#E0E0E0";
const ALTERNATE_ROW = "#F5F4F0";

// Logo loaded via absolute URL — react-pdf renders server-side and needs a
// reachable URL. NEXT_PUBLIC_APP_URL is set in Vercel; fallback to prod URL.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://fort-inside.vercel.app";
const LOGO_URL = `${APP_URL}/logo-yuri.png`;

const styles = StyleSheet.create({
  // PAGES — landscape A4 ≈ 792 × 595 pt
  page: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 60,
    paddingHorizontal: 80,
    fontFamily: "Helvetica",
  },
  coverPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 50,
    paddingHorizontal: 80,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  closingPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 50,
    paddingBottom: 50,
    paddingHorizontal: 80,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },

  // COVER LOGO (top)
  coverLogoBlock: {
    alignItems: "center",
    marginBottom: 30,
  },
  coverLogo: {
    width: 80,
    height: 80,
  },

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
  coverSubtitle: {
    fontSize: 17,
    color: MID,
    marginBottom: 30,
  },
  pageTitle: {
    fontSize: 76,
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
    fontSize: 42,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionHeadlineSmall: {
    fontSize: 13,
    letterSpacing: 2.5,
    color: CHARCOAL,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionGap: { height: 30 },

  // SUBSECTION
  subsectionHeading: {
    fontSize: 21,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },

  // BODY
  body: { fontSize: 15, color: DARK, lineHeight: 1.7 },
  bodySpaced: { fontSize: 15, color: DARK, lineHeight: 1.7, marginBottom: 12 },

  contentColumn: {
    maxWidth: 600,
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
    fontSize: 15,
    color: CHARCOAL,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
  },

  // ÁREAS-CHAVE — 3 columns
  areasRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 30,
  },
  areaColumn: {
    width: "31%",
  },

  // PLANO 30 DIAS — TABLE
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 2,
    borderBottomColor: CHARCOAL,
    paddingBottom: 8,
  },
  tableHeaderCellLeft: {
    fontSize: 13,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    width: "30%",
    paddingHorizontal: 12,
  },
  tableHeaderCellRight: {
    fontSize: 13,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    width: "70%",
    paddingHorizontal: 12,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 18,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
  },
  tableRowAlt: { backgroundColor: ALTERNATE_ROW },
  tableCellLeft: {
    fontSize: 15,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    width: "30%",
    paddingHorizontal: 12,
    lineHeight: 1.5,
  },
  tableCellRight: {
    fontSize: 15,
    color: DARK,
    width: "70%",
    paddingHorizontal: 12,
    lineHeight: 1.6,
  },

  // PILARES — 4 columns
  pilaresRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 30,
  },
  pilarColumn: {
    width: "23%",
    borderLeftWidth: 2,
    borderLeftColor: CHARCOAL,
    paddingLeft: 12,
  },
  praticaName: {
    fontSize: 19,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  praticaDescription: {
    fontSize: 15,
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
    paddingVertical: 35,
    paddingHorizontal: 30,
    borderTopWidth: 1.5,
    borderTopColor: CHARCOAL,
    borderBottomWidth: 1.5,
    borderBottomColor: CHARCOAL,
    marginVertical: 20,
    maxWidth: 600,
    alignSelf: "center",
  },
  fraseQuoteMark: {
    fontSize: 85,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    lineHeight: 0.8,
    marginBottom: -10,
    textAlign: "center",
  },
  fraseQuote: {
    fontSize: 33,
    color: CHARCOAL,
    fontStyle: "italic",
    lineHeight: 1.4,
    textAlign: "center",
  },
  fraseContextoContainer: {
    maxWidth: 500,
    alignSelf: "center",
    marginTop: 24,
  },

  // CLOSING
  closingTop: { paddingTop: 10 },
  closingMessage: {
    fontSize: 17,
    color: DARK,
    fontStyle: "italic",
    lineHeight: 1.6,
    textAlign: "center",
    marginTop: 30,
    maxWidth: 600,
    alignSelf: "center",
  },
  closingCenter: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 30,
  },
  closingThanks: {
    fontSize: 66,
    color: CHARCOAL,
    fontFamily: "Helvetica-Bold",
    marginBottom: 16,
  },
  closingSignature: { fontSize: 17, color: MID },
  closingFooterLogoBlock: {
    alignItems: "center",
  },
  closingFooterLogo: {
    width: 32,
    height: 32,
  },

  // YURI NOTE (closing page)
  yuriNoteBox: {
    borderLeftWidth: 2,
    borderLeftColor: CHARCOAL,
    paddingLeft: 14,
    marginBottom: 24,
    maxWidth: 600,
    alignSelf: "center",
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
    fontSize: 15,
    color: DARK,
    lineHeight: 1.65,
    fontStyle: "italic",
  },

  // FOOTER (pages 2-7)
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
  footerText: { fontSize: 11, color: MID },
  footerLogo: {
    width: 24,
    height: 24,
  },
});

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
  const contextoParagraphs = content.frase_ativacao.contexto.split(/\n\n+/).filter(Boolean);

  return (
    <Document
      title={`Mapa da Próxima Construção — ${participantName}`}
      author={hostName}
      subject="Fort Inside — Prognóstico Inicial de Direção"
    >
      {/* PAGE 1 — COVER */}
      <Page size="A4" style={styles.coverPage}>
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
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Análise</Text>
        <View style={styles.sectionGap} />
        <View style={styles.contentColumn}>
          {analiseParagraphs.map((p, i) => (
            <Text key={i} style={styles.bodySpaced}>{p}</Text>
          ))}
        </View>
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 3 — ÁREAS-CHAVE */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Áreas-Chave</Text>
        <View style={styles.areasRow}>
          {content.areas_chave.map((area, i) => (
            <View key={i} style={styles.areaColumn}>
              <Text style={styles.subsectionHeading}>{area.nome}</Text>
              <Text style={styles.body}>{area.direcionamento}</Text>
            </View>
          ))}
        </View>
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 4 — PLANO 30 DIAS */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Plano de 30 dias</Text>
        <View style={styles.sectionGap} />
        <View style={styles.tableHeader}>
          <Text style={styles.tableHeaderCellLeft}>Comportamento</Text>
          <Text style={styles.tableHeaderCellRight}>Microação</Text>
        </View>
        {content.plano_30_dias.map((step, i) => (
          <View
            key={i}
            style={i % 2 === 0 ? [styles.tableRow, styles.tableRowAlt] : styles.tableRow}
          >
            <Text style={styles.tableCellLeft}>{step.comportamento}</Text>
            <Text style={styles.tableCellRight}>{step.microacao}</Text>
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

      {/* PAGE 5 — PILARES */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Pilares</Text>
        <View style={styles.pilaresRow}>
          {content.praticas.map((p, i) => (
            <View key={i} style={styles.pilarColumn}>
              <Text style={styles.praticaName}>{p.nome}</Text>
              <Text style={styles.praticaDescription}>{p.descricao}</Text>
            </View>
          ))}
        </View>
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 6 — FRASE DE ATIVAÇÃO */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadlineSmall}>Frase de ativação</Text>
        <View style={styles.fraseCenterContainer}>
          <View style={styles.quoteBox}>
            <Text style={styles.fraseQuoteMark}>&ldquo;</Text>
            <Text style={styles.fraseQuote}>{content.frase_ativacao.frase}</Text>
          </View>
          <View style={styles.fraseContextoContainer}>
            {contextoParagraphs.map((p, i) => (
              <Text key={i} style={styles.bodySpaced}>{p}</Text>
            ))}
          </View>
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
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Por que esta trilha</Text>
        <View style={styles.trailBadgeBig}>
          <Text style={styles.trailTextBig}>{content.trilha_recomendada}</Text>
        </View>
        <View style={styles.sectionGap} />
        <View style={styles.contentColumn}>
          <Text style={styles.body}>{content.justificativa_trilha}</Text>
        </View>
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <Image src={LOGO_URL} style={styles.footerLogo} />
        </View>
      </Page>

      {/* PAGE 8 — FECHAMENTO */}
      <Page size="A4" style={styles.closingPage}>
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
