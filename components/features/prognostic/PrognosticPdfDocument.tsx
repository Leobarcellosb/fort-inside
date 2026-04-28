import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { PrognosticContent } from "@/types/database";

// Editorial deck-style layout: cover + section per page, dramatic typography hierarchy.
// All-Helvetica (zero remote fetch). Gold #C9A961 accent on white paper.
const GOLD = "#C9A961";
const DARK = "#1A1A1A";
const MID = "#5A5A5A";
const HAIRLINE = "#E0E0E0";
const ALTERNATE_ROW = "#F8F8F8";

const styles = StyleSheet.create({
  // PAGES
  page: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 60,
    paddingBottom: 80,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
  },
  coverPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 80,
    paddingBottom: 60,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  closingPage: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 60,
    paddingBottom: 60,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
    flexDirection: "column",
    justifyContent: "space-between",
  },

  // COVER
  coverContent: {
    flex: 1,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "flex-start",
  },
  coverEyebrow: {
    fontSize: 9,
    letterSpacing: 3,
    color: DARK,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  coverSubtitle: {
    fontSize: 14,
    color: MID,
    marginBottom: 30,
  },
  pageTitle: {
    fontSize: 64,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    lineHeight: 1.05,
    marginBottom: 30,
  },
  coverFooter: {
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
  },

  // SECTION HEADLINES
  sectionHeadline: {
    fontSize: 36,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionHeadlineSmall: {
    fontSize: 11,
    letterSpacing: 2.5,
    color: GOLD,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },
  sectionGap: { height: 30 },

  // SUBSECTION
  subsectionHeading: {
    fontSize: 18,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
  },

  // BODY
  body: { fontSize: 13, color: DARK, lineHeight: 1.7 },
  bodySpaced: { fontSize: 13, color: DARK, lineHeight: 1.7, marginBottom: 12 },

  // TRAIL BADGES
  trailBadge: {
    borderWidth: 1,
    borderColor: GOLD,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignSelf: "flex-start",
    marginTop: 0,
    marginBottom: 40,
  },
  trailText: {
    fontSize: 9,
    color: GOLD,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  trailBadgeBig: {
    borderWidth: 1.5,
    borderColor: GOLD,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 24,
    alignSelf: "flex-start",
    marginTop: 16,
    marginBottom: 24,
  },
  trailTextBig: {
    fontSize: 13,
    color: GOLD,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
  },

  // ÁREAS-CHAVE
  areaBlock: { marginBottom: 28 },

  // PLANO 30 DIAS — TABLE
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 2,
    borderBottomColor: GOLD,
    paddingBottom: 8,
  },
  tableHeaderCellLeft: {
    fontSize: 11,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    width: "35%",
    paddingHorizontal: 10,
  },
  tableHeaderCellRight: {
    fontSize: 11,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    width: "65%",
    paddingHorizontal: 10,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
  },
  tableRowAlt: { backgroundColor: ALTERNATE_ROW },
  tableCellLeft: {
    fontSize: 13,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    width: "35%",
    paddingHorizontal: 10,
    lineHeight: 1.5,
  },
  tableCellRight: {
    fontSize: 13,
    color: DARK,
    width: "65%",
    paddingHorizontal: 10,
    lineHeight: 1.6,
  },

  // PILARES
  pilarBlock: {
    marginBottom: 22,
    borderLeftWidth: 2,
    borderLeftColor: GOLD,
    paddingLeft: 14,
  },
  praticaName: {
    fontSize: 16,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  praticaDescription: {
    fontSize: 13,
    color: DARK,
    lineHeight: 1.6,
  },

  // FRASE DE ATIVAÇÃO
  quoteBox: {
    paddingVertical: 40,
    paddingHorizontal: 30,
    borderTopWidth: 1.5,
    borderTopColor: GOLD,
    borderBottomWidth: 1.5,
    borderBottomColor: GOLD,
    marginVertical: 20,
  },
  fraseQuoteMark: {
    fontSize: 72,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    lineHeight: 0.8,
    marginBottom: -10,
    textAlign: "center",
  },
  fraseQuote: {
    fontSize: 28,
    color: GOLD,
    fontStyle: "italic",
    lineHeight: 1.4,
    textAlign: "center",
  },

  // CLOSING
  closingTop: { paddingTop: 20 },
  closingMessage: {
    fontSize: 14,
    color: DARK,
    fontStyle: "italic",
    lineHeight: 1.6,
    textAlign: "center",
    marginTop: 40,
  },
  closingCenter: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
  },
  closingThanks: {
    fontSize: 56,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 16,
  },
  closingSignature: { fontSize: 14, color: MID },
  closingFooterBrand: {
    fontSize: 9,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
  },

  // YURI NOTE (closing page)
  yuriNoteBox: {
    borderLeftWidth: 2,
    borderLeftColor: GOLD,
    paddingLeft: 14,
    marginBottom: 24,
  },
  yuriNoteLabel: {
    fontSize: 8,
    letterSpacing: 2,
    color: GOLD,
    textTransform: "uppercase",
    marginBottom: 5,
  },
  yuriNoteText: {
    fontSize: 13,
    color: DARK,
    lineHeight: 1.65,
    fontStyle: "italic",
  },

  // FOOTER (pages 2-7)
  footer: {
    position: "absolute",
    bottom: 40,
    left: 56,
    right: 56,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    paddingTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerText: { fontSize: 9, color: MID },
  footerBrand: { fontSize: 9, color: DARK, fontFamily: "Helvetica-Bold" },
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
        {analiseParagraphs.map((p, i) => (
          <Text key={i} style={styles.bodySpaced}>{p}</Text>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>

      {/* PAGE 3 — ÁREAS-CHAVE */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Áreas-Chave</Text>
        <View style={styles.sectionGap} />
        {content.areas_chave.map((area, i) => (
          <View key={i} style={styles.areaBlock}>
            <Text style={styles.subsectionHeading}>{area.nome}</Text>
            <Text style={styles.body}>{area.direcionamento}</Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
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
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>

      {/* PAGE 5 — PILARES */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Pilares</Text>
        <View style={styles.sectionGap} />
        {content.praticas.map((p, i) => (
          <View key={i} style={styles.pilarBlock}>
            <Text style={styles.praticaName}>{p.nome}</Text>
            <Text style={styles.praticaDescription}>{p.descricao}</Text>
          </View>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>

      {/* PAGE 6 — FRASE DE ATIVAÇÃO */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadlineSmall}>Frase de ativação</Text>
        <View style={styles.sectionGap} />
        <View style={styles.quoteBox}>
          <Text style={styles.fraseQuoteMark}>&ldquo;</Text>
          <Text style={styles.fraseQuote}>{content.frase_ativacao.frase}</Text>
        </View>
        <View style={{ height: 20 }} />
        {contextoParagraphs.map((p, i) => (
          <Text key={i} style={styles.bodySpaced}>{p}</Text>
        ))}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>

      {/* PAGE 7 — POR QUE ESTA TRILHA */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionHeadline}>Por que esta trilha</Text>
        <View style={styles.trailBadgeBig}>
          <Text style={styles.trailTextBig}>{content.trilha_recomendada}</Text>
        </View>
        <View style={styles.sectionGap} />
        <Text style={styles.body}>{content.justificativa_trilha}</Text>
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
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
        <View>
          <Text style={styles.closingFooterBrand}>Fort Inside</Text>
        </View>
      </Page>
    </Document>
  );
}
