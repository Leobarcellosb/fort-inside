import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { PrognosticContent } from "@/types/database";

// White-paper editorial layout. Helvetica is bundled with @react-pdf/renderer
// (zero remote-fetch risk). Gold accent #C9A961 first try; if visually faint
// on print, swap to #9C7A2E in the constant below.
const GOLD = "#C9A961";
const DARK = "#1A1A1A";
const MID = "#5A5A5A";
const HAIRLINE = "#E0E0E0";

const styles = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    color: DARK,
    paddingTop: 60,
    paddingBottom: 70,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
  },
  // Header
  header: {
    marginBottom: 36,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: HAIRLINE,
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 2,
    color: GOLD,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  title: {
    fontSize: 33,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 12,
    color: MID,
    marginBottom: 3,
  },
  trailBadge: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: GOLD,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    alignSelf: "flex-start",
  },
  trailText: {
    fontSize: 9,
    color: GOLD,
    letterSpacing: 1,
    textTransform: "uppercase",
  },

  // Section heading
  sectionHeading: {
    fontSize: 11,
    letterSpacing: 2.5,
    color: GOLD,
    textTransform: "uppercase",
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  sectionRule: {
    borderBottomWidth: 1,
    borderBottomColor: GOLD,
    width: 40,
    marginBottom: 14,
  },
  sectionWrapper: {
    marginBottom: 28,
  },

  // Body text
  body: { fontSize: 13, color: DARK, lineHeight: 1.65 },
  bodySpaced: { fontSize: 13, color: DARK, lineHeight: 1.65, marginBottom: 10 },

  // Áreas-chave
  itemBlock: { marginBottom: 16 },
  itemHeading: {
    fontSize: 15,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  itemBody: { fontSize: 13, color: DARK, lineHeight: 1.65 },

  // Plano numbered
  planoRow: { flexDirection: "row", marginBottom: 14 },
  planoNumber: {
    fontSize: 26,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    width: 36,
    marginRight: 8,
  },
  planoContent: { flex: 1 },
  planoComportamento: {
    fontSize: 14,
    color: DARK,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  planoMicroacao: { fontSize: 13, color: DARK, lineHeight: 1.55 },

  // Pilares grid (2 cols)
  praticasGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -6,
  },
  praticaCell: {
    width: "50%",
    paddingHorizontal: 6,
    marginBottom: 14,
  },
  praticaInner: {
    borderLeftWidth: 1.5,
    borderLeftColor: GOLD,
    paddingLeft: 10,
  },
  praticaNome: {
    fontSize: 13,
    color: GOLD,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  praticaDescricao: { fontSize: 12, color: DARK, lineHeight: 1.5 },

  // Frase ativação
  fraseBox: {
    borderTopWidth: 1,
    borderTopColor: GOLD,
    borderBottomWidth: 1,
    borderBottomColor: GOLD,
    paddingVertical: 18,
    paddingHorizontal: 12,
    marginVertical: 16,
  },
  fraseText: {
    fontSize: 17,
    color: DARK,
    fontStyle: "italic",
    lineHeight: 1.5,
    textAlign: "center",
  },

  // Yuri note
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

  // Footer
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

  const analiseParagraphs = content.analise_geral.split(/\n\n+/).filter(Boolean);
  const contextoParagraphs = content.frase_ativacao.contexto.split(/\n\n+/).filter(Boolean);

  return (
    <Document
      title={`Mapa da Próxima Construção — ${participantName}`}
      author={hostName}
      subject="Fort Inside — Prognóstico Inicial de Direção"
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Mapa da Sua Próxima Construção</Text>
          <Text style={styles.title}>{participantName}</Text>
          <Text style={styles.subtitle}>{eventName}</Text>
          {formattedDate ? <Text style={styles.subtitle}>{formattedDate}</Text> : null}
          <View style={styles.trailBadge}>
            <Text style={styles.trailText}>{content.trilha_recomendada}</Text>
          </View>
        </View>

        {/* 1. Análise */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Análise</Text>
          <View style={styles.sectionRule} />
          {analiseParagraphs.map((p, i) => (
            <Text key={i} style={styles.bodySpaced}>
              {p}
            </Text>
          ))}
        </View>

        {/* 2. Áreas-chave */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Áreas-chave</Text>
          <View style={styles.sectionRule} />
          {content.areas_chave.map((area, i) => (
            <View key={i} style={styles.itemBlock}>
              <Text style={styles.itemHeading}>{area.nome}</Text>
              <Text style={styles.itemBody}>{area.direcionamento}</Text>
            </View>
          ))}
        </View>

        {/* 3. Plano 30 dias */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Plano de 30 dias</Text>
          <View style={styles.sectionRule} />
          {content.plano_30_dias.map((step, i) => (
            <View key={i} style={styles.planoRow}>
              <Text style={styles.planoNumber}>{String(i + 1).padStart(2, "0")}</Text>
              <View style={styles.planoContent}>
                <Text style={styles.planoComportamento}>{step.comportamento}</Text>
                <Text style={styles.planoMicroacao}>{step.microacao}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* 4. Pilares */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Pilares</Text>
          <View style={styles.sectionRule} />
          <View style={styles.praticasGrid}>
            {content.praticas.map((p, i) => (
              <View key={i} style={styles.praticaCell}>
                <View style={styles.praticaInner}>
                  <Text style={styles.praticaNome}>{p.nome}</Text>
                  <Text style={styles.praticaDescricao}>{p.descricao}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* 5. Frase de ativação */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Frase de ativação</Text>
          <View style={styles.sectionRule} />
          <View style={styles.fraseBox}>
            <Text style={styles.fraseText}>
              &ldquo;{content.frase_ativacao.frase}&rdquo;
            </Text>
          </View>
          {contextoParagraphs.map((p, i) => (
            <Text key={i} style={styles.bodySpaced}>
              {p}
            </Text>
          ))}
        </View>

        {/* 6. Por que esta trilha */}
        <View style={styles.sectionWrapper}>
          <Text style={styles.sectionHeading}>Por que esta trilha</Text>
          <View style={styles.sectionRule} />
          <Text style={styles.body}>{content.justificativa_trilha}</Text>
        </View>

        {/* 7. Yuri note */}
        {yuriNote ? (
          <View style={styles.yuriNoteBox}>
            <Text style={styles.yuriNoteLabel}>Observação de {hostName}</Text>
            <Text style={styles.yuriNoteText}>&ldquo;{yuriNote}&rdquo;</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Prognóstico Inicial de Direção por {hostName}
          </Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>
    </Document>
  );
}
