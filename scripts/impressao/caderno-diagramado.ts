// CADERNO DE CONDUCAO, DIAGRAMADO PARA IMPRIMIR.
//
// So muda a FORMA. O conteudo vem de `cadernoDeConducao()`, o mesmo que o app
// usa, e o hash dele sai impresso na capa. Este arquivo nao escreve nenhum texto
// do Caderno: escreve rotulos de navegacao ("Sumario", "Momento", "pagina") e
// arruma o que ja existe.
//
// Antes de gravar, confere que TODO texto do Caderno aparece no HTML final. Se
// faltar um, lanca e nao grava nada.
//
// Rodar (gera HTML e PDF em docs/impressao/):
//   npx tsx scripts/impressao/caderno-diagramado.ts

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cadernoDeConducao,
  TEXTOS_CADERNO,
  type ItemDoCaderno,
  type MarcaDeItem,
} from "../../lib/marco-zero/caderno-de-conducao";

const RAIZ = join(__dirname, "..", "..");
const SAIDA_HTML = join(RAIZ, "docs/impressao/caderno-de-conducao-v2.html");
const SAIDA_PDF = join(RAIZ, "docs/impressao/caderno-de-conducao-v2.pdf");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const { caderno: c, conteudoSha256: hash } = cadernoDeConducao();

function e(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fonte(arquivo: string): string {
  return readFileSync(join(__dirname, "fontes", arquivo)).toString("base64");
}

const dois = (n: number) => String(n).padStart(2, "0");

const CLASSE: Record<MarcaDeItem, string> = { OFICIAL: "oficial", "OPERAÇÃO": "operacao", FALTA: "falta" };

const RELOGIO = `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.2V8l2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

function marca(m: MarcaDeItem): string {
  return `<span class="tag ${CLASSE[m]}">${e(m)}</span>`;
}

function item(i: ItemDoCaderno): string {
  const extras: string[] = [];
  if (i.deQuem) extras.push(`<p class="dequem"><b>De quem:</b> ${e(i.deQuem)}</p>`);
  if (i.porQue) extras.push(`<p class="porque"><b>Por que falta:</b> ${e(i.porQue)}</p>`);
  return `<article class="item ${CLASSE[i.marca]}">
  <div class="trilho">${marca(i.marca)}</div>
  <div class="conteudo">
    <h4>${e(i.rotulo)}</h4>
    <p class="corpo">${e(i.corpo)}</p>
    ${extras.join("\n    ")}
    ${i.fonte ? `<p class="fonte"><span>Fonte</span> ${e(i.fonte)}</p>` : ""}
  </div>
</article>`;
}

const capa = `<section class="capa">
  <div class="capa-topo">
    <span class="capa-marca">Geração Preparada</span>
    <span class="capa-restrito">${e(c.cabecalho.restricao)}</span>
  </div>
  <div class="capa-meio">
    <p class="capa-sobre">Marco Zero</p>
    <h1>${e(c.cabecalho.titulo)}</h1>
    <div class="capa-fio"></div>
    <p class="capa-evento">${e(c.cabecalho.linhaEvento)}</p>
  </div>
  <div class="capa-numeros">
    <div><strong>${c.momentos.length}</strong><span>momentos</span></div>
    <div><strong>${c.contagem.oficial}</strong><span>oficial</span></div>
    <div><strong>${c.contagem.operacao}</strong><span>operação</span></div>
    <div><strong>${c.contagem.lacuna}</strong><span>falta</span></div>
  </div>
  <p class="capa-versao">Versão ${e(c.cabecalho.versao)} · conteúdo ${e(hash)}</p>
</section>`;

const comoLer = `<section class="pagina abertura">
  <p class="sobretitulo">Antes de tudo</p>
  <p class="lead">${e(c.abertura)}</p>
  <h2 class="secao">${e(TEXTOS_CADERNO.tituloComoLer)}</h2>
  <div class="legenda">
    ${c.comoLer
      .map((l, n) => {
        const m: MarcaDeItem = (["OFICIAL", "OPERAÇÃO", "FALTA"] as const)[n];
        const total = [c.contagem.oficial, c.contagem.operacao, c.contagem.lacuna][n];
        return `<div class="legenda-item ${CLASSE[m]}"><div class="legenda-num">${total}</div>${marca(m)}<p>${e(l)}</p></div>`;
      })
      .join("\n    ")}
  </div>
  <p class="nota">Neste Caderno: ${c.contagem.oficial} itens [OFICIAL], ${c.contagem.operacao} itens [OPERAÇÃO], ${c.contagem.lacuna} itens [FALTA].</p>
  <h2 class="secao">${e(TEXTOS_CADERNO.tituloRegra)}</h2>
  <p class="regra">${e(c.regraDeRedacao)}</p>
</section>`;

const sumario = `<section class="pagina sumario">
  <p class="sobretitulo">Sumário</p>
  <h2 class="titulo-grande">O dia em ${c.momentos.length} momentos</h2>
  <ol class="linha-do-tempo">
    ${c.momentos
      .map(
        (m) => `<li>
      <span class="lt-num">${dois(m.numero)}</span>
      <span class="lt-titulo">${e(m.titulo)}</span>
      <span class="lt-quando">${m.quando ? e(m.quando) : ""}</span>
      <span class="lt-cont">${m.contagem.lacuna > 0 ? `<span class="tag falta mini">${m.contagem.lacuna} FALTA</span>` : ""}</span>
    </li>`,
      )
      .join("\n    ")}
    <li class="lt-extra">
      <span class="lt-num">!</span>
      <span class="lt-titulo">${e(TEXTOS_CADERNO.tituloLacunas)}</span>
      <span class="lt-quando"></span>
      <span class="lt-cont"><span class="tag falta mini">${c.lacunas.length} FALTA</span></span>
    </li>
  </ol>
</section>`;

const momentos = c.momentos
  .map(
    (m) => `<section class="momento">
  <header class="momento-cab">
    <div class="momento-num">${dois(m.numero)}</div>
    <div class="momento-tit">
      <p class="sobretitulo">Momento ${m.numero} de ${c.momentos.length}</p>
      <h2>${e(m.titulo)}</h2>
      ${m.quando ? `<p class="quando">${RELOGIO}<span>${e(m.quando)}</span></p>` : ""}
      <p class="contagem">
        ${m.contagem.oficial ? `<span class="tag oficial mini">${m.contagem.oficial} OFICIAL</span>` : ""}
        ${m.contagem.operacao ? `<span class="tag operacao mini">${m.contagem.operacao} OPERAÇÃO</span>` : ""}
        ${m.contagem.lacuna ? `<span class="tag falta mini">${m.contagem.lacuna} FALTA</span>` : ""}
      </p>
    </div>
  </header>
  ${m.itens.map(item).join("\n  ")}
</section>`,
  )
  .join("\n");

const lacunas = `<section class="pagina lacunas">
  <p class="sobretitulo">Checklist</p>
  <h2 class="titulo-grande">${e(TEXTOS_CADERNO.tituloLacunas)}</h2>
  <ol class="checklist">
    ${c.lacunas
      .map(
        (l, n) => `<li>
      <span class="caixa"></span>
      <div>
        <p class="ck-ref"><span class="ck-n">${dois(n + 1)}</span> Momento ${l.momentoNumero} · ${e(l.momentoTitulo)}</p>
        <h4>${e(l.rotulo)}</h4>
        <p class="corpo">${e(l.falta)}</p>
        <p class="dequem"><b>De quem:</b> ${e(l.deQuem)}</p>
        <p class="fonte"><span>Conferido em</span> ${e(l.conferidoEm.join(" ; "))}</p>
      </div>
    </li>`,
      )
      .join("\n    ")}
  </ol>
</section>`;

const fim = `<section class="pagina fim">
  <h2 class="secao">${e(TEXTOS_CADERNO.tituloLimites)}</h2>
  <p class="regra">${e(c.limites)}</p>
  <h2 class="secao">Fontes</h2>
  <ul class="fontes">${c.fontes.map((f) => `<li>${e(f)}</li>`).join("")}</ul>
  <p class="capa-versao escuro">Versão ${e(c.cabecalho.versao)} · conteúdo ${e(hash)}</p>
</section>`;

const css = `
@font-face { font-family: "Manrope"; src: url(data:font/woff2;base64,${fonte("manrope-latin-wght-normal.woff2")}) format("woff2"); font-weight: 200 800; }
@font-face { font-family: "Mulish"; src: url(data:font/woff2;base64,${fonte("mulish-latin-wght-normal.woff2")}) format("woff2"); font-weight: 200 1000; font-style: normal; }
@font-face { font-family: "Mulish"; src: url(data:font/woff2;base64,${fonte("mulish-latin-wght-italic.woff2")}) format("woff2"); font-weight: 200 1000; font-style: italic; }
:root {
  --tinta: #1b1a17; --carvao: #232323; --noite: #0D0C0A; --ouro: #D9C291; --ouro-escuro: #8a7340;
  --areia: #CBCAC4; --papel: #F7F7F6; --cinza: #6b6a64; --linha: #e3e2dd;
  color-scheme: light;
}
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html { background: #fff; }
body { margin: 0; color: var(--tinta); font: 400 9.4pt/1.52 "Mulish", system-ui, sans-serif; }
h1, h2, h3, h4 { font-family: "Manrope", system-ui, sans-serif; margin: 0; }
p { margin: 0; }
b { font-weight: 800; }

@page { size: A4; margin: 17mm 16mm 18mm 16mm;
  @top-left { content: "MARCO ZERO · CADERNO DE CONDUÇÃO"; font: 700 6.5pt "Manrope", sans-serif; letter-spacing: .18em; color: #8f8e88; }
  @top-right { content: "USO INTERNO"; font: 800 6.5pt "Manrope", sans-serif; letter-spacing: .18em; color: #8f8e88; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 700 7.5pt "Manrope", sans-serif; color: #8f8e88; }
  @bottom-left { content: "Geração Preparada · 24.10.2026"; font: 600 6.5pt "Mulish", sans-serif; letter-spacing: .06em; color: #a5a49e; }
}
@page capa { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-right { content: none; } @bottom-left { content: none; } }

/* CAPA */
.capa { page: capa; height: 297mm; width: 210mm; background: var(--noite); color: #fff; padding: 18mm 18mm 16mm;
  display: flex; flex-direction: column; position: relative; overflow: hidden; break-after: page; }
.capa::before { content: ""; position: absolute; right: -34mm; top: 34mm; width: 132mm; height: 178mm; border-radius: 50%;
  border: 9mm solid rgba(217,194,145,.10); }
.capa::after { content: ""; position: absolute; right: -10mm; top: 58mm; width: 84mm; height: 130mm; border-radius: 50%;
  border: .5mm solid rgba(217,194,145,.35); }
.capa-topo { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; position: relative; z-index: 1; }
.capa-marca { font: 800 9pt "Manrope", sans-serif; letter-spacing: .28em; text-transform: uppercase; color: var(--ouro); }
.capa-restrito { font: 700 6.6pt/1.5 "Manrope", sans-serif; letter-spacing: .16em; text-align: right; max-width: 70mm; color: rgba(255,255,255,.55); }
.capa-meio { margin-top: auto; position: relative; z-index: 1; }
.capa-sobre { font: 800 13pt "Manrope", sans-serif; letter-spacing: .5em; text-transform: uppercase; color: var(--ouro); margin-bottom: 5mm; }
.capa h1 { font-weight: 800; font-size: 58pt; line-height: .95; letter-spacing: -.035em; max-width: 150mm; }
.capa-fio { width: 28mm; height: 1.4mm; background: var(--ouro); margin: 9mm 0 7mm; }
.capa-evento { font-size: 11pt; line-height: 1.55; color: rgba(255,255,255,.82); max-width: 135mm; }
.capa-numeros { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 16mm; border-top: .3mm solid rgba(255,255,255,.18);
  position: relative; z-index: 1; }
.capa-numeros div { padding: 5mm 0 0; }
.capa-numeros strong { display: block; font: 800 28pt/1 "Manrope", sans-serif; color: #fff; }
.capa-numeros span { font: 700 7pt "Manrope", sans-serif; letter-spacing: .2em; text-transform: uppercase; color: var(--ouro); }
.capa-versao { margin-top: 12mm; font: 500 6.4pt/1.5 ui-monospace, Menlo, monospace; color: rgba(255,255,255,.4); word-break: break-all; position: relative; z-index: 1; }
.capa-versao.escuro { color: var(--cinza); margin-top: 10mm; border-top: .3mm solid var(--linha); padding-top: 3mm; }

/* TAGS */
.tag { display: inline-block; font: 800 6.6pt/1 "Manrope", sans-serif; letter-spacing: .14em; padding: 1.6mm 2.2mm 1.4mm; border-radius: 1mm; white-space: nowrap; }
.tag.oficial { background: var(--carvao); color: #fff; border: .35mm solid var(--carvao); }
.tag.operacao { background: #fff; color: var(--carvao); border: .35mm solid var(--carvao); }
.tag.falta { color: var(--noite); border: .35mm solid var(--noite);
  background: repeating-linear-gradient(-45deg, var(--ouro) 0 1.3mm, #f3e7c9 1.3mm 2.6mm); }
.tag.mini { font-size: 6pt; padding: 1.2mm 1.8mm 1mm; margin-right: 1.2mm; }

/* PAGINAS DE TEXTO */
.pagina { break-after: page; }
.lacunas { break-before: page; }
.sobretitulo { font: 800 7pt "Manrope", sans-serif; letter-spacing: .26em; text-transform: uppercase; color: var(--ouro-escuro); margin-bottom: 3mm; }
.lead { font-size: 13.5pt; line-height: 1.5; font-weight: 500; color: var(--carvao); margin-bottom: 10mm; letter-spacing: -.005em; }
.secao { font-size: 13pt; font-weight: 800; letter-spacing: -.01em; padding-bottom: 2.4mm; border-bottom: .5mm solid var(--carvao); margin: 9mm 0 5mm; }
.titulo-grande { font-size: 30pt; font-weight: 800; letter-spacing: -.03em; line-height: 1.05; margin-bottom: 9mm; }
.legenda { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
.legenda-item { border: .35mm solid var(--linha); border-radius: 2mm; padding: 5mm 4.5mm; background: #fff; break-inside: avoid; }
.legenda-item.falta { background: #fbf6ea; border-color: #e7d6ad; }
.legenda-num { font: 800 34pt/1 "Manrope", sans-serif; letter-spacing: -.04em; margin-bottom: 3mm; }
.legenda-item .tag { margin-bottom: 3mm; }
.legenda-item p { font-size: 8.6pt; line-height: 1.5; color: #3a3935; }
.nota { margin-top: 4mm; font-size: 8pt; color: var(--cinza); }
.regra { font-size: 9.6pt; line-height: 1.6; max-width: 160mm; }

/* SUMARIO */
.linha-do-tempo { list-style: none; margin: 0; padding: 0; }
.linha-do-tempo li { display: grid; grid-template-columns: 18mm 1fr 62mm 22mm; align-items: baseline; gap: 4mm;
  padding: 4.2mm 0; border-bottom: .3mm solid var(--linha); }
.lt-num { font: 800 20pt/1 "Manrope", sans-serif; color: var(--areia); letter-spacing: -.03em; }
.lt-titulo { font: 800 12.5pt/1.25 "Manrope", sans-serif; letter-spacing: -.01em; }
.lt-quando { font-size: 8.2pt; color: var(--cinza); line-height: 1.4; }
.lt-cont { text-align: right; }
.lt-extra .lt-num { color: var(--ouro-escuro); }

/* MOMENTOS */
.momento { break-before: page; }
.momento-cab { display: grid; grid-template-columns: 40mm 1fr; gap: 6mm; align-items: end; padding-bottom: 6mm; margin-bottom: 6mm;
  border-bottom: .9mm solid var(--carvao); }
.momento-num { font: 800 88pt/.82 "Manrope", sans-serif; letter-spacing: -.06em; color: var(--carvao); }
.momento-tit h2 { font-size: 25pt; font-weight: 800; letter-spacing: -.025em; line-height: 1.05; margin-bottom: 3mm; }
.momento-tit .sobretitulo { margin-bottom: 2mm; }
.quando { display: flex; align-items: flex-start; gap: 1.8mm; font-size: 9pt; font-weight: 700; color: var(--carvao); margin-bottom: 3mm; }
.ico { width: 3.6mm; height: 3.6mm; flex: none; margin-top: .5mm; }
.contagem { display: flex; flex-wrap: wrap; gap: 1mm; }

.item { display: grid; grid-template-columns: 24mm 1fr; gap: 5mm; padding: 4.2mm 0; border-bottom: .3mm solid var(--linha); break-inside: avoid; }
.item h4 { font-size: 10.6pt; font-weight: 800; letter-spacing: -.008em; line-height: 1.3; margin-bottom: 1.6mm; }
.item .corpo { font-size: 9.3pt; line-height: 1.58; color: #26251f; white-space: pre-line; }
.item.operacao .conteudo { padding-left: 3.5mm; border-left: .35mm dashed var(--areia); }
.item.falta { background: #fbf6ea; border: .35mm solid #e7d6ad; border-left: 1.6mm solid var(--noite); border-radius: 1.2mm;
  padding: 4mm 4mm 4mm 0; margin: 2.5mm 0; }
.item.falta .trilho { padding-left: 3.5mm; }
.dequem { margin-top: 2mm; font-size: 8.8pt; }
.dequem b { font-family: "Manrope", sans-serif; font-size: 7.2pt; letter-spacing: .12em; text-transform: uppercase; margin-right: 1mm; }
.porque { margin-top: 1mm; font-size: 8.3pt; color: #4b4a44; font-style: italic; }
.porque b { font-style: normal; font-family: "Manrope", sans-serif; font-size: 7.2pt; letter-spacing: .12em; text-transform: uppercase; margin-right: 1mm; }
.fonte { margin-top: 2.2mm; font-size: 7pt; line-height: 1.45; color: #8a8983; overflow-wrap: anywhere; }
.fonte span { font: 800 5.8pt "Manrope", sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #b0afa9; margin-right: 1.2mm; }

/* LACUNAS */
.checklist { list-style: none; margin: 0; padding: 0; }
.checklist li { display: grid; grid-template-columns: 9mm 1fr; gap: 4mm; padding: 4.5mm 0; border-bottom: .3mm solid var(--linha); break-inside: avoid; }
.caixa { width: 6mm; height: 6mm; border: .6mm solid var(--noite); border-radius: 1mm; margin-top: .6mm; }
.ck-ref { font: 700 7pt "Manrope", sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--ouro-escuro); margin-bottom: 1.2mm; }
.ck-n { color: var(--noite); margin-right: 1.5mm; }
.checklist h4 { font-size: 10.6pt; font-weight: 800; margin-bottom: 1.4mm; }
.checklist .corpo { font-size: 9pt; line-height: 1.55; }

/* FIM */
.fontes { padding-left: 4.5mm; margin: 0; font-size: 7.8pt; line-height: 1.5; color: #4b4a44; }
.fontes li { margin-bottom: 1.6mm; overflow-wrap: anywhere; }
.fim { break-after: auto; }

@media screen {
  html { background: #d9d8d3; }
  body { width: 210mm; margin: 10mm auto; background: #fff; box-shadow: 0 2mm 8mm rgba(0,0,0,.18); }
  .pagina, .momento { padding: 17mm 16mm 18mm; }
  .capa { margin-bottom: 0; }
}
`;

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(c.cabecalho.titulo)}: Marco Zero</title>
<style>${css}</style>
</head>
<body>
${capa}
${comoLer}
${sumario}
${momentos}
${lacunas}
${fim}
</body>
</html>`;

// CONFERENCIA: todo texto do Caderno esta no HTML, letra por letra.
function textoVisivel(h: string): string {
  return h
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const visivel = textoVisivel(html);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const exigidos: string[] = [
  c.cabecalho.restricao, c.cabecalho.titulo, c.cabecalho.linhaEvento, c.cabecalho.versao, hash,
  c.abertura, ...c.comoLer, c.regraDeRedacao, c.limites, ...c.fontes,
  TEXTOS_CADERNO.tituloComoLer, TEXTOS_CADERNO.tituloRegra, TEXTOS_CADERNO.tituloLacunas, TEXTOS_CADERNO.tituloLimites,
];
for (const m of c.momentos) {
  exigidos.push(m.titulo);
  if (m.quando) exigidos.push(m.quando);
  for (const i of m.itens) {
    exigidos.push(i.rotulo, i.corpo);
    if (i.deQuem) exigidos.push(i.deQuem);
    if (i.porQue) exigidos.push(i.porQue);
    if (i.fonte) exigidos.push(i.fonte);
  }
}
for (const l of c.lacunas) exigidos.push(l.rotulo, l.falta, l.deQuem, l.momentoTitulo, ...l.conferidoEm);
const faltando = exigidos.filter((t) => !visivel.includes(norm(t)));
if (faltando.length > 0) {
  throw new Error(`Diagramacao recusada: ${faltando.length} texto(s) do Caderno sumiram:\n${faltando.slice(0, 5).join("\n")}`);
}
const contagemDeItens = (html.match(/<article class="item /g) ?? []).length;
const esperado = c.momentos.reduce((s, m) => s + m.itens.length, 0);
if (contagemDeItens !== esperado) throw new Error(`Itens impressos ${contagemDeItens}, esperado ${esperado}`);
if (/[—–]/.test(visivel)) throw new Error("Diagramacao com travessao");

writeFileSync(SAIDA_HTML, html);
execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--hide-scrollbars",
  `--print-to-pdf=${SAIDA_PDF}`, `file://${SAIDA_HTML}`,
], { stdio: "ignore" });
console.log(`Caderno diagramado: ${exigidos.length} textos conferidos, ${contagemDeItens} itens, conteudo ${hash.slice(0, 8)}`);
console.log(SAIDA_HTML);
console.log(SAIDA_PDF);
