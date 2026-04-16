import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import type { PrognosticContent } from "@/types/database";

// Register fonts — using standard PDF fonts as fallback (no external fetch at render time)
Font.register({
  family: "serif",
  src: "https://fonts.gstatic.com/s/fraunces/v31/6NUu8FyLNQOQZAnv9ZwNjucMHVn85Ni7emAe9lKqZTnDiDNR.woff2",
});

const styles = StyleSheet.create({
  page: {
    backgroundColor: "#0A0A0A",
    color: "#F5F1EA",
    paddingTop: 60,
    paddingBottom: 60,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
  },
  header: {
    marginBottom: 40,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
    paddingBottom: 24,
  },
  eyebrow: {
    fontSize: 7,
    letterSpacing: 2,
    color: "#6B6557",
    textTransform: "uppercase",
    marginBottom: 10,
  },
  title: {
    fontSize: 28,
    color: "#F5F1EA",
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 10,
    color: "#A39D91",
    marginBottom: 4,
  },
  trailBadge: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#C9A961",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
    alignSelf: "flex-start",
  },
  trailText: {
    fontSize: 8,
    color: "#C9A961",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  section: {
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 7,
    letterSpacing: 2,
    color: "#6B6557",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  sectionText: {
    fontSize: 11,
    color: "#F5F1EA",
    lineHeight: 1.7,
  },
  highlightBox: {
    backgroundColor: "#141414",
    borderWidth: 1,
    borderColor: "#2A2A2A",
    borderRadius: 4,
    padding: 16,
    marginBottom: 24,
  },
  yuriNoteBox: {
    borderLeftWidth: 2,
    borderLeftColor: "#C9A961",
    paddingLeft: 16,
    marginBottom: 24,
  },
  yuriNoteLabel: {
    fontSize: 7,
    letterSpacing: 2,
    color: "#8A7540",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  yuriNoteText: {
    fontSize: 12,
    color: "#F5F1EA",
    lineHeight: 1.7,
    fontStyle: "italic",
  },
  footer: {
    position: "absolute",
    bottom: 40,
    left: 56,
    right: 56,
    borderTopWidth: 1,
    borderTopColor: "#2A2A2A",
    paddingTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerText: {
    fontSize: 8,
    color: "#6B6557",
  },
  footerBrand: {
    fontSize: 8,
    color: "#A39D91",
    fontFamily: "Helvetica-Bold",
  },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: "#2A2A2A",
    marginBottom: 24,
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

const SECTIONS: Array<{ key: keyof PrognosticContent; label: string; highlight?: boolean }> = [
  { key: "momento_atual", label: "Seu momento" },
  { key: "forca_central", label: "Sua força" },
  { key: "gargalo_sensivel", label: "Seu gargalo" },
  { key: "risco_permanecer", label: "O risco de ficar" },
  { key: "construir_agora", label: "O que construir agora", highlight: true },
  { key: "proximo_passo", label: "Seu próximo passo", highlight: true },
];

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

        {/* Content sections */}
        {SECTIONS.map(({ key, label, highlight }) => {
          const text = content[key] as string;
          return highlight ? (
            <View key={key} style={styles.highlightBox}>
              <Text style={styles.sectionLabel}>{label}</Text>
              <Text style={styles.sectionText}>{text}</Text>
            </View>
          ) : (
            <View key={key} style={styles.section}>
              <Text style={styles.sectionLabel}>{label}</Text>
              <Text style={styles.sectionText}>{text}</Text>
            </View>
          );
        })}

        <View style={styles.divider} />

        {/* Trail justification */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Por que esta trilha</Text>
          <Text style={styles.sectionText}>{content.justificativa_trilha}</Text>
        </View>

        {/* Yuri's note */}
        {yuriNote ? (
          <View style={styles.yuriNoteBox}>
            <Text style={styles.yuriNoteLabel}>Observação de {hostName}</Text>
            <Text style={styles.yuriNoteText}>&ldquo;{yuriNote}&rdquo;</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Prognóstico Inicial de Direção por {hostName}</Text>
          <Text style={styles.footerBrand}>Fort Inside</Text>
        </View>
      </Page>
    </Document>
  );
}
