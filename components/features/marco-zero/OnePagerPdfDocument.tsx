import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { EIXOS, ELEMENTOS } from "../../../lib/scoring/marco-zero";
import { ROTULOS_ELEMENTOS_PADRAO } from "../../../lib/scoring/briefing-marco-zero";
import { ROTULOS_EIXOS_MARCO_ZERO } from "./catalogo-dimensoes";
import { TEXTOS_MOLDURA, verificarModelo } from "./one-pager-modelo";
import type {
  BlocoElementos,
  OnePagerModelo,
} from "./one-pager-modelo";

// One-pager individual do Marco Zero. A4 retrato, UMA pagina.
//
// A identidade visual da Geracao Preparada ainda nao foi recebida: as cores
// abaixo sao fichas provisorias, neutras, trocaveis num unico lugar. Nao ha
// logotipo (o do projeto e da Yuri Fortes, e o Marco Zero tem identidade propria).
//
// Principios de desenho:
//  - O dado nunca e desenhado com mais precisao do que tem. As escolhas
//    situacionais sao 6 pontos soltos (um ponto = uma escolha), nao barras nem
//    percentuais. Nao ha grafico do Likert: o briefing nao o expoe e as somas
//    brutas nao autorizam ranking sem margem.
//  - Elemento nao respondido aparece vazio e escrito "sem resposta": nunca e
//    um ponto no zero.
//  - Eixos e elementos aparecem sempre na mesma ordem fixa, nunca ordenados
//    por valor.
//  - Corpo >= 9,5 pt; nada e reduzido para caber: se nao couber, corta-se.

export const PALETA = {
  tinta: "#1E2329",
  suave: "#59616A",
  apagado: "#8A929B",
  fio: "#D9DCE0",
  ponto: "#C3C8CE",
  papel: "#F5F4F0",
  acento: "#1F4E5F",
  acentoSuave: "#DDE9ED",
} as const;

const COL_ESQ = 236;
const FOLGA = 20;

const s = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    color: PALETA.tinta,
    fontFamily: "Helvetica",
    paddingTop: 30,
    paddingBottom: 24,
    paddingHorizontal: 40,
    flexDirection: "column",
  },
  conteudo: { flexGrow: 1 },

  selo: {
    fontSize: 7.5,
    color: "#8A4B14",
    backgroundColor: "#FBEEDC",
    paddingVertical: 2,
    paddingHorizontal: 6,
    alignSelf: "flex-start",
    marginBottom: 6,
    borderRadius: 2,
  },
  // cabecalho
  cabecalho: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingBottom: 10,
    borderBottomWidth: 1.5,
    borderBottomColor: PALETA.tinta,
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 2.5,
    textTransform: "uppercase",
    color: PALETA.acento,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
  },
  titulo: { fontSize: 22, fontFamily: "Helvetica-Bold", lineHeight: 1.1 },
  nome: { fontSize: 13, fontFamily: "Helvetica-Bold", textAlign: "right" },
  eventoLinha: { fontSize: 9, color: PALETA.suave, textAlign: "right", marginTop: 3 },
  abertura: {
    fontSize: 10,
    lineHeight: 1.4,
    color: PALETA.suave,
    marginTop: 10,
    marginBottom: 10,
  },

  // grade esquerda (figura) / direita (palavras)
  linha: {
    flexDirection: "row",
    paddingVertical: 9,
    borderTopWidth: 0.75,
    borderTopColor: PALETA.fio,
  },
  esq: { width: COL_ESQ, marginRight: FOLGA },
  dir: { width: 515 - COL_ESQ - FOLGA },
  kicker: {
    fontSize: 8,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: PALETA.suave,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  manchete: { fontSize: 14, fontFamily: "Helvetica-Bold", color: PALETA.acento, lineHeight: 1.2 },
  mancheteNeutra: { fontSize: 12, fontFamily: "Helvetica-Bold", color: PALETA.suave, lineHeight: 1.25 },
  corpo: { fontSize: 9.5, lineHeight: 1.37, color: PALETA.tinta },
  corpoEspaco: { marginTop: 5 },
  intro: { fontSize: 8.5, lineHeight: 1.38, color: PALETA.suave, marginBottom: 6 },
  legendaDestaque: { fontSize: 7.5, color: PALETA.suave, marginBottom: 2 },
  negrito: { fontFamily: "Helvetica-Bold" },

  // pontos situacionais
  eixoLinha: { flexDirection: "row", alignItems: "center", height: 16 },
  eixoRotulo: { width: 142, fontSize: 8.5, color: PALETA.suave },
  eixoRotuloDestaque: { fontFamily: "Helvetica-Bold", color: PALETA.tinta },
  pontos: { flexDirection: "row" },
  ponto: { width: 9, height: 9, borderRadius: 5, marginRight: 4 },
  legenda: { fontSize: 8, color: PALETA.apagado, marginTop: 5, lineHeight: 1.3 },

  // cruzamento
  cartao: {
    backgroundColor: PALETA.acentoSuave,
    borderRadius: 3,
    padding: 11,
    flexDirection: "row",
    marginVertical: 3,
  },
  chips: { flexDirection: "row", marginBottom: 7 },
  chip: {
    backgroundColor: "#FFFFFF",
    borderRadius: 2,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginRight: 8,
    borderWidth: 0.75,
    borderColor: PALETA.fio,
  },
  chipLegenda: { fontSize: 7.5, color: PALETA.suave, marginBottom: 1 },
  chipRotulo: { fontSize: 10, fontFamily: "Helvetica-Bold", color: PALETA.acento },

  // elementos
  elLinha: { flexDirection: "row", alignItems: "center", height: 15 },
  elRotulo: { width: 112, fontSize: 8.5, color: PALETA.suave },
  trilho: { width: 100, height: 12, justifyContent: "center", marginRight: 8 },
  trilhoFio: { height: 1, backgroundColor: PALETA.ponto },
  trilhoMarca: { position: "absolute", top: 3, width: 1, height: 6, backgroundColor: PALETA.ponto },
  trilhoPonto: {
    position: "absolute",
    top: 1.5,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: PALETA.acento,
  },
  elNota: { fontSize: 9, fontFamily: "Helvetica-Bold", width: 16 },
  elSemResposta: { fontSize: 8, color: PALETA.apagado, fontStyle: "italic" },
  rotuloMini: {
    fontSize: 7.5,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: PALETA.apagado,
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },

  // para refletir
  levar: {
    backgroundColor: PALETA.papel,
    borderRadius: 3,
    padding: 10,
    marginTop: 4,
  },
  pergunta: { flexDirection: "row", marginBottom: 3 },
  cruzTexto: { marginBottom: 7 },

  // dimensoes
  dimGrade: { flexDirection: "row", flexWrap: "wrap", marginTop: 7 },
  dimItem: { width: "50%", paddingRight: 14, marginBottom: 3 },
  dimRotulo: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: PALETA.tinta },
  dimDef: { fontSize: 8, lineHeight: 1.35, color: PALETA.suave },
  perguntaNum: { width: 14, fontSize: 9.5, fontFamily: "Helvetica-Bold", color: PALETA.acento },
  perguntaTexto: { flex: 1, fontSize: 9.5, lineHeight: 1.37, color: PALETA.tinta },
  fechamento: { fontSize: 9, color: PALETA.suave, fontStyle: "italic", marginTop: 3 },

  // rodape
  rodape: {
    borderTopWidth: 0.75,
    borderTopColor: PALETA.fio,
    paddingTop: 7,
    marginTop: 8,
  },
  rodapeTexto: { fontSize: 8, lineHeight: 1.4, color: PALETA.suave },
});

// Nomes citados entre aspas no texto aprovado viram negrito, sem alterar uma
// letra do texto.
const ROTULOS_CITAVEIS: readonly string[] = [
  ...EIXOS.map((e) => ROTULOS_EIXOS_MARCO_ZERO[e]),
  ...ELEMENTOS.map((el) => ROTULOS_ELEMENTOS_PADRAO[el]),
];

function TextoComRotulos({ texto }: { texto: string }) {
  const alternativas = ROTULOS_CITAVEIS.map((r) => `“${r}”`);
  const partes: ReactNode[] = [];
  let resto = texto;
  let chave = 0;
  while (resto.length > 0) {
    let proximo: { i: number; alvo: string } | null = null;
    for (const alvo of alternativas) {
      const i = resto.indexOf(alvo);
      if (i !== -1 && (proximo === null || i < proximo.i)) proximo = { i, alvo };
    }
    if (proximo === null) {
      partes.push(resto);
      break;
    }
    if (proximo.i > 0) partes.push(resto.slice(0, proximo.i));
    partes.push(
      <Text key={chave++} style={s.negrito}>
        {proximo.alvo}
      </Text>,
    );
    resto = resto.slice(proximo.i + proximo.alvo.length);
  }
  return <Text style={s.corpo}>{partes}</Text>;
}

function Paragrafos({ itens }: { itens: readonly string[] }) {
  return (
    <View>
      {itens.map((p, i) => (
        <View key={i} style={i > 0 ? s.corpoEspaco : undefined}>
          <TextoComRotulos texto={p} />
        </View>
      ))}
    </View>
  );
}

function Autodescricao({ m }: { m: OnePagerModelo }) {
  const a = m.autodescricao;
  return (
    <View style={s.linha} wrap={false}>
      <View style={s.esq}>
        <Text style={s.kicker}>{a.titulo}</Text>
        {a.destaque ? (
          <View>
            <Text style={s.legendaDestaque}>{a.legendaDestaque}</Text>
            <Text style={s.manchete}>{a.destaque.rotulo}</Text>
          </View>
        ) : (
          <Text style={s.mancheteNeutra}>{a.manchete}</Text>
        )}
      </View>
      <View style={s.dir}>
        <Text style={s.intro}>{a.intro}</Text>
        {a.texto ? <Paragrafos itens={[a.texto]} /> : null}
      </View>
    </View>
  );
}

function Situacional({ m }: { m: OnePagerModelo }) {
  const sit = m.situacional;
  return (
    <View style={s.linha} wrap={false}>
      <View style={s.esq}>
        <Text style={s.kicker}>{sit.titulo}</Text>
        {sit.pontos ? (
          <View>
            {sit.pontos.eixos.map((e) => (
              <View key={e.rotulo} style={s.eixoLinha}>
                <Text style={[s.eixoRotulo, e.destacado ? s.eixoRotuloDestaque : {}]}>
                  {e.rotulo}
                </Text>
                <View style={s.pontos}>
                  {Array.from({ length: sit.pontos!.total }, (_, i) => (
                    <View
                      key={i}
                      style={[
                        s.ponto,
                        i < e.contagem
                          ? { backgroundColor: e.destacado ? PALETA.acento : PALETA.suave }
                          : { borderWidth: 0.75, borderColor: PALETA.ponto },
                      ]}
                    />
                  ))}
                </View>
              </View>
            ))}
            <Text style={s.legenda}>{sit.pontos.legenda}</Text>
          </View>
        ) : null}
      </View>
      <View style={s.dir}>
        <Text style={s.intro}>{sit.intro}</Text>
        <Paragrafos itens={sit.paragrafos} />
      </View>
    </View>
  );
}

function ParaRefletir({ m }: { m: OnePagerModelo }) {
  const c = m.cruzamento;
  const r = m.paraRefletir;
  return (
    <View style={s.levar} wrap={false}>
      <Text style={[s.kicker, { color: PALETA.acento }]}>{r.titulo}</Text>
      {c ? (
        <View>
          <View style={s.chips}>
            {c.tipo === "contraste" ? (
              <>
                <View style={s.chip}>
                  <Text style={s.chipLegenda}>{TEXTOS_MOLDURA.tituloAutodescricao}</Text>
                  <Text style={s.chipRotulo}>{c.rotuloAutodescricao}</Text>
                </View>
                <View style={s.chip}>
                  <Text style={s.chipLegenda}>{TEXTOS_MOLDURA.tituloSituacional}</Text>
                  <Text style={s.chipRotulo}>{c.rotuloEscolhas}</Text>
                </View>
              </>
            ) : (
              <View style={s.chip}>
                <Text style={s.chipLegenda}>{TEXTOS_MOLDURA.legendaDuasLeituras}</Text>
                <Text style={s.chipRotulo}>{c.rotuloAutodescricao}</Text>
              </View>
            )}
          </View>
          <View style={s.cruzTexto}>
            <Paragrafos itens={c.paragrafos} />
          </View>
        </View>
      ) : null}
      {r.perguntas.map((p, i) => (
        <View key={i} style={s.pergunta}>
          <Text style={s.perguntaNum}>{i + 1}.</Text>
          <Text style={s.perguntaTexto}>{p}</Text>
        </View>
      ))}
      <Text style={s.fechamento}>{r.fechamento}</Text>
    </View>
  );
}

function Dimensoes({ m }: { m: OnePagerModelo }) {
  return (
    <View style={{ marginTop: 8 }} wrap={false}>
      <Text style={[s.kicker, { marginBottom: 0 }]}>{m.dimensoes.titulo}</Text>
      <View style={s.dimGrade}>
        {m.dimensoes.itens.map((d) => (
          <View key={d.rotulo} style={s.dimItem}>
            <Text style={s.dimRotulo}>{d.rotulo}</Text>
            <Text style={s.dimDef}>{d.definicao}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Elementos({ e }: { e: BlocoElementos }) {
  return (
    <View style={s.linha} wrap={false}>
      <View style={s.esq}>
        <Text style={s.kicker}>{e.titulo}</Text>
        {e.notas ? (
          <View>
            {e.notas.map((n) => (
              <View key={n.rotulo} style={s.elLinha}>
                <Text style={s.elRotulo}>{n.rotulo}</Text>
                {n.nota === null ? (
                  <Text style={s.elSemResposta}>{e.semResposta}</Text>
                ) : (
                  <>
                    <View style={s.trilho}>
                      <View style={s.trilhoFio} />
                      {[0, 5, 10].map((t) => (
                        <View key={t} style={[s.trilhoMarca, { left: t * 10 }]} />
                      ))}
                      <View style={[s.trilhoPonto, { left: n.nota * 10 - 4.5 }]} />
                    </View>
                    <Text style={s.elNota}>{n.nota}</Text>
                  </>
                )}
              </View>
            ))}
            <Text style={s.legenda}>{e.legenda}</Text>
          </View>
        ) : null}
      </View>
      <View style={s.dir}>
        {e.textoAviso ? <TextoComRotulos texto={e.textoAviso} /> : null}
        {e.maior ? (
          <View>
            <Text style={s.rotuloMini}>{TEXTOS_MOLDURA.rotuloMaior}</Text>
            <TextoComRotulos texto={e.maior.texto} />
          </View>
        ) : null}
        {e.menor ? (
          <View style={{ marginTop: e.maior ? 7 : 0 }}>
            <Text style={s.rotuloMini}>{TEXTOS_MOLDURA.rotuloMenor}</Text>
            <TextoComRotulos texto={e.menor.texto} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function OnePagerPdfDocument({ modelo }: { modelo: OnePagerModelo }) {
  const m = modelo;
  // Ultima barreira: um modelo montado a mao (sem passar pelo construtor) com
  // texto recusado pela validacao de saida nao chega a virar documento.
  verificarModelo(m);
  return (
    <Document
      title={`Marco Zero - ${m.cabecalho.nome}`}
      author="Marco Zero"
      subject={`catalogo-dimensoes ${m.catalogoVersao} (${m.catalogoEstado})`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.conteudo}>
          {m.cabecalho.selo ? <Text style={s.selo}>{m.cabecalho.selo}</Text> : null}
          <View style={s.cabecalho}>
            <View>
              <Text style={s.eyebrow}>{m.cabecalho.eyebrow}</Text>
              <Text style={s.titulo}>{m.cabecalho.titulo}</Text>
            </View>
            <View>
              <Text style={s.nome}>{m.cabecalho.nome}</Text>
              {m.cabecalho.linhaEvento ? (
                <Text style={s.eventoLinha}>{m.cabecalho.linhaEvento}</Text>
              ) : null}
            </View>
          </View>
          <Text style={s.abertura}>{m.abertura}</Text>

          <Autodescricao m={m} />
          <Situacional m={m} />
          <Elementos e={m.elementos} />
          <ParaRefletir m={m} />
          <Dimensoes m={m} />
        </View>

        <View style={s.rodape}>
          <Text style={s.rodapeTexto}>{m.notaDeLeitura}</Text>
        </View>
      </Page>
    </Document>
  );
}
