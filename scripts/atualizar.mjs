// Atualiza data/dados.json com o conteúdo do dia.
// Roda todo dia pelo GitHub Actions (.github/workflows/atualizar.yml). Não precisa instalar nada (Node 20+).
//
// Sem chave de API: atualiza as notícias, o link da liturgia, o santo do dia (nome e link do Vatican News)
// e a catequese (a partir do banco data/catequese-banco.json).
// Com o segredo ANTHROPIC_API_KEY configurado no repositório: também escreve as referências das leituras,
// a cor litúrgica, a reflexão, o resumo do santo e uma catequese nova a cada dia.

import { readFile, writeFile } from "node:fs/promises";

const ARQ = new URL("../data/dados.json", import.meta.url);
const BANCO = new URL("../data/catequese-banco.json", import.meta.url);
const TZ = "America/Sao_Paulo";
const UA = { "user-agent": "FeDiaria/1.0 (+https://evangelizar.casadavochica.com.br)" };
const MESES = ["janeiro","fevereiro","marco","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

const hojeISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const agora = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const log = (...a) => console.log("•", ...a);

async function baixar(url) {
  const r = await fetch(url, { headers: UA, redirect: "follow" });
  if (!r.ok) throw new Error(`${url} respondeu ${r.status}`);
  return await r.text();
}
const decod = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const texto = s => decod(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? decod(m[1]).trim() : ""; };
const https = u => typeof u === "string" && /^https:\/\//.test(u);

// ---------- Notícias do Vatican News (RSS) ----------
export function lerRSS(xml, limite = 15) {
  const itens = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const titulo = texto(tag(it, "title"));
    const link = tag(it, "link").trim();
    const pub = tag(it, "pubDate");
    if (!titulo || !https(link)) continue;
    const caminho = (link.match(/vaticannews\.va\/pt\/([a-z-]+)\//) || [])[1] || "";
    const SECOES = { papa: "Papa", vaticano: "Vaticano", igreja: "Igreja", mundo: "Mundo", africa: "África", america: "América", asia: "Ásia", europa: "Europa", oceania: "Oceania" };
    const secao = /^Evangelho d/i.test(titulo) ? "Evangelho" : (SECOES[caminho] || "");
    const d = pub ? new Date(pub) : null;
    itens.push({ titulo, link, ...(d && !isNaN(d) ? { data: d.toISOString().replace(/\.\d+Z$/, "Z") } : {}), ...(secao ? { secao } : {}) });
    if (itens.length >= limite) break;
  }
  return itens;
}

// ---------- Notícias do Pe. Manzotti (página de notícias) ----------
export function lerManzotti(html, limite = 10) {
  const porLink = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href="(https:\/\/padrereginaldomanzotti\.com\.br\/blog\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = m[1].endsWith("/") ? m[1] : m[1] + "/";
    const t = texto(m[2]);
    const atual = porLink.get(link) || "";
    if (t && !/^(leia mais|saiba mais|ver mais|continuar lendo)$/i.test(t) && t.length > atual.length) porLink.set(link, t);
    else if (!porLink.has(link)) porLink.set(link, "");
  }
  const itens = [];
  for (const [link, t] of porLink) {
    const slug = link.split("/").filter(Boolean).pop() || "";
    const titulo = t || slug.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());
    if (titulo.length < 6) continue;
    itens.push({ titulo, link });
    if (itens.length >= limite) break;
  }
  return itens;
}

// ---------- Liturgia: link da página do dia ----------
export function acharLiturgia(html, iso) {
  const [a, m, d] = iso.split("-").map(Number);
  const trecho = `-${d}-de-${MESES[m - 1]}-de-${a}`;
  for (const mm of html.matchAll(/<a\b[^>]*href="(https:\/\/evangelizarepreciso\.com\.br\/liturgia-diaria\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (mm[1].includes(trecho)) {
      const slug = mm[1].split("/").filter(Boolean).pop();
      const titulo = texto(mm[2]) || slug.replace(trecho, "").replace(/-/g, " ");
      return { link: mm[1], titulo };
    }
  }
  return null;
}
function tituloLiturgia(slugTitulo) {
  const t = slugTitulo.replace(/\s+/g, " ").trim();
  return t ? t.replace(/^./, c => c.toUpperCase()).replace(/\b(\d+)a semana\b/i, "$1ª Semana").replace(/\b(\d+)o domingo\b/i, "$1º Domingo") : "Liturgia de hoje";
}

// ---------- Santo do dia (Vatican News) ----------
async function santoVatican(iso) {
  const [, m, d] = iso.split("-");
  const urls = [`https://www.vaticannews.va/pt/santo-do-dia/${m}/${d}.html`, "https://www.vaticannews.va/pt/santo-do-dia.html"];
  for (const url of urls) {
    try {
      const html = await baixar(url);
      const og = (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || [])[1];
      const titulo = texto(og || tag(html, "title")).replace(/\s*[-|]\s*Vatican News.*$/i, "");
      if (titulo && !/santo do dia$/i.test(titulo)) return { nome: titulo, link: url };
    } catch (e) { log("santo:", e.message); }
  }
  return null;
}

// ---------- Catequese sem IA: próxima dica do banco ----------
function catequeseDoBanco(banco, anterior, iso) {
  const usados = new Set([anterior?.tema, ...(anterior?.historico || []).map(h => h.tema)].filter(Boolean));
  const dia = Math.floor(Date.parse(iso + "T12:00:00Z") / 864e5);
  for (let k = 0; k < banco.length; k++) {
    const c = banco[(dia + k) % banco.length];
    if (!usados.has(c.tema)) return c;
  }
  return banco[dia % banco.length];
}

// ---------- Conteúdo escrito por IA (opcional) ----------
async function perguntarClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 2500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error("API respondeu " + r.status + ": " + (await r.text()).slice(0, 300));
  const j = await r.json();
  const txt = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("resposta sem JSON");
  return JSON.parse(txt.slice(a, b + 1));
}

function promptIA(iso, linkLiturgia, temasUsados) {
  return `Hoje é ${iso} (fuso America/Sao_Paulo). Você está preparando o conteúdo diário de um app católico brasileiro.
Use a busca na web para conferir os fatos. Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois, neste formato:
{
 "liturgia": {"celebracao": "ex.: Terça-feira da 29ª Semana do Tempo Comum · Memória de São X", "tempo": "Tempo Comum|Advento|Tempo do Natal|Quaresma|Semana Santa|Tempo Pascal", "cor": "verde|branco|vermelho|roxo|rosa|preto", "leituras": [{"tipo":"1ª Leitura","ref":"Livro cap,vers"},{"tipo":"Salmo","ref":"Sl N · primeiras palavras do refrão"},{"tipo":"Evangelho","ref":"..."}], "reflexao": "2 frases suas resumindo o sentido das leituras"},
 "santo": {"nome": "santo celebrado hoje no calendário romano (no Brasil)", "resumo": "2 a 3 frases suas com fatos verificados: época, quem foi, por que é lembrado", "link": "URL https confiável sobre o santo, de preferência vaticannews.va"},
 "catequese": {"parte": "A profissão da fé|A celebração do mistério cristão|A vida em Cristo|A oração cristã", "tema": "título curto", "texto": "3 a 5 frases suas, em linguagem simples, fiéis ao Catecismo da Igreja Católica", "cic": "ex.: CIC 1213-1216", "pergunta": "pergunta prática para reflexão pessoal"}
}
Regras: as leituras devem ser as da liturgia diária no Brasil para hoje${linkLiturgia ? " (página de referência: " + linkLiturgia + ")" : ""}; inclua "2ª Leitura" só se houver. NUNCA copie o texto das leituras nem do Catecismo, só referências e textos seus. Considere memórias e festas para a cor. A catequese não pode repetir estes temas: ${temasUsados.join("; ") || "(nenhum)"}; siga um percurso pelas quatro partes do Catecismo.`;
}

// ---------- Principal ----------
async function main() {
  const iso = hojeISO();
  const dados = JSON.parse(await readFile(ARQ, "utf8"));
  dados.noticias ||= {};

  try { const v = lerRSS(await baixar("https://www.vaticannews.va/pt.rss.xml"));
    if (v.length) { const antigos = new Map((dados.noticias.vatican?.items || []).map(i => [i.link, i.resumo]));
      v.forEach(i => { if (antigos.get(i.link)) i.resumo = antigos.get(i.link); });
      dados.noticias.vatican = { atualizadoEm: agora(), fonte: "https://www.vaticannews.va/pt.rss.xml", items: v }; log("Vatican News:", v.length); } }
  catch (e) { log("Vatican News falhou, mantendo as anteriores:", e.message); }

  try { const m = lerManzotti(await baixar("https://padrereginaldomanzotti.com.br/noticias"));
    if (m.length) { dados.noticias.manzotti = { atualizadoEm: agora(), fonte: "https://padrereginaldomanzotti.com.br/noticias", items: m }; log("Pe. Manzotti:", m.length); } }
  catch (e) { log("Pe. Manzotti falhou, mantendo as anteriores:", e.message); }

  let lit = null;
  try { lit = acharLiturgia(await baixar("https://evangelizarepreciso.com.br/liturgia-diaria/"), iso); } catch (e) { log("liturgia:", e.message); }

  const catAnterior = dados.catequese && dados.catequese.data !== iso ? dados.catequese : null;
  const novoHistorico = () => {
    if (!catAnterior) return dados.catequese?.historico || [];
    const { historico, ...semHist } = catAnterior;
    return [semHist, ...(historico || [])].slice(0, 14);
  };

  let ia = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const temas = [dados.catequese?.tema, ...(dados.catequese?.historico || []).map(h => h.tema)].filter(Boolean);
      ia = await perguntarClaude(promptIA(iso, lit?.link, temas)); log("conteúdo escrito pela IA recebido");
    } catch (e) { log("IA falhou, usando o modo simples:", e.message); }
  }

  // Liturgia
  if (ia?.liturgia?.leituras?.length) {
    dados.liturgia = { data: iso, ...ia.liturgia, link: lit?.link || "https://evangelizarepreciso.com.br/liturgia-diaria/", atualizadoEm: agora() };
  } else if (dados.liturgia?.data !== iso) {
    dados.liturgia = { data: iso, celebracao: lit ? tituloLiturgia(lit.titulo) : "Liturgia de hoje", leituras: [], link: lit?.link || "https://evangelizarepreciso.com.br/liturgia-diaria/", atualizadoEm: agora() };
  }

  // Santo
  if (ia?.santo?.nome) {
    dados.santo = { data: iso, nome: ia.santo.nome, resumo: ia.santo.resumo || "", link: https(ia.santo.link) ? ia.santo.link : "https://www.vaticannews.va/pt/santo-do-dia.html", atualizadoEm: agora() };
  } else if (dados.santo?.data !== iso) {
    const s = await santoVatican(iso);
    dados.santo = { data: iso, nome: s?.nome || "Santo do dia", resumo: s ? "" : "Toque em “Saiba mais” para conhecer o santo de hoje.", link: s?.link || "https://www.vaticannews.va/pt/santo-do-dia.html", atualizadoEm: agora() };
  }

  // Catequese
  if (dados.catequese?.data !== iso) {
    const historico = novoHistorico();
    const c = ia?.catequese?.tema ? { ...ia.catequese, link: linkParte(ia.catequese.parte) } : catequeseDoBanco(JSON.parse(await readFile(BANCO, "utf8")), { tema: catAnterior?.tema, historico }, iso);
    dados.catequese = { data: iso, ...c, historico, atualizadoEm: agora() };
  }

  dados.geradoEm = agora();
  await writeFile(ARQ, JSON.stringify(dados, null, 1) + "\n");
  log("pronto:", iso, "·", dados.santo.nome, "·", dados.catequese.tema);
}
function linkParte(p = "") {
  const base = "https://www.vatican.va/archive/cathechism_po/index_new/";
  if (/profiss/i.test(p)) return base + "index-primeira-parte_po.html";
  if (/celebra/i.test(p)) return base + "index-segunda-parte_po.html";
  if (/vida em cristo/i.test(p)) return base + "index-terceira-parte_po.html";
  if (/ora/i.test(p)) return base + "index-quarta-parte_po.html";
  return base + "prima-pagina-cic_po.html";
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
