const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

// ---------------------------------------------------------------------------
//  .env laden (Key bleibt ausschliesslich serverseitig)
// ---------------------------------------------------------------------------
for (const p of [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]) {
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const MGA_BASE = process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MODELS = {
  opus: { id: process.env.MGA_MODEL || 'claude-opus-5', label: 'Claude Opus 5', hint: 'gründlich' },
  flash: { id: process.env.MGA_FAST_MODEL || 'gemini-3.5-flash-lite', label: 'Gemini Flash Lite', hint: 'schnell' },
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
//  Produktionsbetrieb (ein Dienst): Passwortschutz, /api-Prefix, Frontend
//  Lokal unveraendert: ohne APP_PASSWORD kein Schutz, ohne dist kein Static.
// ---------------------------------------------------------------------------
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, value] = header.split(' ');
    if (scheme === 'Basic' && value) {
      const pass = Buffer.from(value, 'base64').toString('utf8').split(':').slice(1).join(':');
      if (pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Research Radar"').status(401).send('Zugang geschuetzt');
  });
}

// Bildet den vite-/nginx-Proxy nach: /api/search -> /search
app.use((req, res, next) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) req.url = req.url.slice(4) || '/';
  next();
});

const DIST = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(DIST);
if (HAS_DIST) app.use(express.static(DIST));

// ---------------------------------------------------------------------------
//  KI-Aufruf (myGenAssist, OpenAI-kompatibel)
// ---------------------------------------------------------------------------
async function llm(messages, { maxTokens = 1500, temperature = 0.2, json = false, model = 'opus' } = {}) {
  if (!process.env.MGA_API_KEY) throw Object.assign(new Error('KI-Schlüssel fehlt'), { statusCode: 503 });
  const id = (MODELS[model] || MODELS.opus).id;
  const res = await fetch(`${MGA_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MGA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, messages, max_tokens: maxTokens, temperature }),
  });
  if (!res.ok) throw Object.assign(new Error('KI-Dienst nicht erreichbar'), { statusCode: 502, code: 'LLM_' + res.status });
  const data = await res.json();
  if (data.model && data.model !== id) console.warn(`MGA: Fallback-Modell ${data.model} statt ${id}`);
  const text = data.choices?.[0]?.message?.content ?? '';
  if (json) {
    if (data.choices?.[0]?.finish_reason === 'length') console.warn('MGA: Antwort durch max_tokens abgeschnitten - JSON wird repariert');
    return parseJson(text);
  }
  return text;
}

// Robustes JSON-Parsing: repariert auch abgeschnittene Antworten (max_tokens)
function parseJson(raw) {
  let text = String(raw).replace(/```json|```/g, '').trim();
  const a = text.indexOf('['), o = text.indexOf('{');
  const s = a === -1 ? o : o === -1 ? a : Math.min(a, o);
  if (s === -1) throw Object.assign(new Error('KI-Antwort ohne JSON'), { statusCode: 502, code: 'NO_JSON' });
  text = text.slice(s);
  const e = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  try {
    return JSON.parse(text.slice(0, e + 1));
  } catch {}
  // Abgeschnitten: bis zum letzten vollständigen Element zurückschneiden und Klammern schließen
  const close = (str) => {
    const st = [];
    let inStr = false, esc = false;
    for (const c of str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{' || c === '[') st.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') st.pop();
    }
    return str + st.reverse().join('');
  };
  const stack = [];
  let inStr = false, esc = false;
  const safe = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { stack.pop(); if (stack.length && stack.length <= 2) safe.push(i); }
  }
  for (let k = safe.length - 1; k >= 0; k--) {
    try {
      return JSON.parse(close(text.slice(0, safe[k] + 1)));
    } catch {}
  }
  throw Object.assign(new Error('KI-Antwort konnte nicht gelesen werden'), { statusCode: 502, code: 'BAD_JSON' });
}


// ---------------------------------------------------------------------------
//  PubMed / PMC
// ---------------------------------------------------------------------------
const SOURCES = { pubmed: { label: 'PubMed (nur freie Volltexte)', live: true } };
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const fmt = (d) => d.replace(/-/g, '/');

const DESIGN = {
  prospective: '(prospective[tiab] OR "prospective studies"[MeSH] OR randomized[tiab] OR "clinical trial"[pt])',
  retrospective: '(retrospective[tiab] OR "retrospective studies"[MeSH] OR "case-control"[tiab] OR "cohort"[tiab]) NOT prospective[tiab]',
};

async function searchPubMed(query, from, to, design, max = 24) {
  let term = `(${query}) AND (ophthalmology OR eye OR retina OR cornea OR glaucoma) AND pubmed pmc[sb]`;
  if (DESIGN[design]) term += ` AND ${DESIGN[design]}`;
  const es = await fetch(
    `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&datetype=pdat&mindate=${fmt(from)}&maxdate=${fmt(to)}&retmode=json&retmax=${max}&sort=relevance`
  ).then((r) => r.json());
  const ids = es.esearchresult?.idlist || [];
  if (!ids.length) return { term, papers: [] };
  const sum = await fetch(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`).then((r) => r.json());
  const papers = ids
    .map((id) => {
      const r = sum.result?.[id] || {};
      const pmc = (r.articleids || []).find((a) => a.idtype === 'pmc')?.value;
      const doi = (r.articleids || []).find((a) => a.idtype === 'doi')?.value;
      return {
        id: `pm-${id}`,
        pmid: id,
        pmc,
        source: 'pubmed',
        title: r.title || '(ohne Titel)',
        authors: (r.authors || []).slice(0, 3).map((a) => a.name).join(', ') + ((r.authors || []).length > 3 ? ' et al.' : ''),
        journal: r.fulljournalname || r.source || '',
        date: r.pubdate || '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        doi,
        fulltextUrl: pmc ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/` : null,
      };
    })
    .filter((p) => p.pmc);
  return { term, papers };
}

// JATS-XML aus PMC in lesbaren Text (Abschnitte mit ## Überschriften)
function jatsToText(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1] : '';
  };
  const conv = (s) =>
    s
      .replace(/<(table-wrap|fig|ref-list|disp-formula|supplementary-material|fn-group)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, '\n\n## $1\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const abs = conv(pick('abstract'));
  const body = conv(pick('body'));
  return { text: (abs ? '## Abstract\n' + abs + '\n\n' : '') + body, hasBody: body.length > 500 };
}

const stripTags = (s) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();

// Abbildungen aus dem JATS-XML: Label, Bildunterschrift, Dateiname der Grafik
function parseFigures(xml) {
  const figs = [];
  for (const m of xml.matchAll(/<fig[^>]*>([\s\S]*?)<\/fig>/gi)) {
    const inner = m[1];
    const label = stripTags((inner.match(/<label>([\s\S]*?)<\/label>/i) || [])[1] || '');
    const caption = stripTags((inner.match(/<caption>([\s\S]*?)<\/caption>/i) || [])[1] || '').slice(0, 500);
    const href = (inner.match(/<graphic[^>]*xlink:href="([^"]+)"/i) || [])[1];
    if (href) figs.push({ id: `f${figs.length + 1}`, label: label || `Figure ${figs.length + 1}`, caption, href });
  }
  return figs.slice(0, 4);
}

const UA = { 'User-Agent': 'Mozilla/5.0 ResearchRadar/1.0' };

// Bild-URLs stehen nur auf der PMC-Artikelseite (CDN-Blobs); Bilder werden in den Datenpool geladen
async function fetchFigures(pmc, figs) {
  if (!figs.length) return [];
  try {
    const html = await fetch(`https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/`, { headers: UA }).then((r) => r.text());
    const urls = [...new Set(html.match(/https:\/\/cdn\.ncbi\.nlm\.nih\.gov\/pmc\/blobs\/[^"' ]+/g) || [])];
    const out = await Promise.all(
      figs.map(async (f) => {
        const base = f.href.replace(/\.[a-z0-9]+$/i, '');
        const url = urls.find((u) => u.includes(base));
        if (!url) return null;
        const r = await fetch(url, { headers: UA });
        if (!r.ok) return null;
        const mime = r.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 4e6 || !mime.startsWith('image/')) return null;
        return { ...f, url, mime, data: buf.toString('base64'), bytes: buf.length };
      })
    );
    return out.filter(Boolean);
  } catch (e) {
    console.warn('Abbildungen fehlgeschlagen', pmc, e.message);
    return [];
  }
}

async function fetchFulltext(pmc) {
  try {
    const xml = await fetch(`${EUTILS}/efetch.fcgi?db=pmc&id=${pmc.replace(/^PMC/i, '')}&retmode=xml`).then((r) => r.text());
    const t = jatsToText(xml);
    t.figures = t.hasBody ? await fetchFigures(pmc, parseFigures(xml)) : [];
    return t;
  } catch (e) {
    console.warn('Volltext fehlgeschlagen', pmc, e.message);
    return { text: '', hasBody: false, figures: [] };
  }
}

// ---------------------------------------------------------------------------
//  In-Memory Datenpool
// ---------------------------------------------------------------------------
const pool = { papers: [], uploads: [], outline: '', deck: null, deckFindings: [] };
const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const pub = (p) => { const { fulltext, figures, ...rest } = p; return { ...rest, figures: (figures || []).map(({ data, ...f }) => f) }; };

app.get('/health', (req, res) => res.json({ status: 'ok', llm: Boolean(process.env.MGA_API_KEY) }));
app.get('/sources', (req, res) => res.json({ sources: SOURCES, models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { label: m.label, hint: m.hint }])) }));

// Suche: Zeitraum von–bis, Studiendesign, nur freie Volltexte, Volltexte werden geladen
app.post('/search', async (req, res, next) => {
  try {
    const query = clean(req.body?.query, 120);
    const to = isDate(req.body?.to) ? req.body.to : new Date().toISOString().slice(0, 10);
    const from = isDate(req.body?.from) ? req.body.from : new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const design = ['prospective', 'retrospective'].includes(req.body?.design) ? req.body.design : '';
    if (!query) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Stichwort fehlt', statusCode: 400 });
    if (from > to) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Zeitraum ungültig', statusCode: 400 });

    let term = query;
    if (process.env.MGA_API_KEY) {
      try {
        const t = await llm(
          [
            { role: 'system', content: 'Du formulierst PubMed-Suchbegriffe. Antworte nur mit JSON.' },
            { role: 'user', content: `Übersetze dieses ophthalmologische Thema in einen präzisen englischen PubMed-Suchbegriff (MeSH-Begriffe und gängige Synonyme mit OR verknüpfen, maximal 4 Synonyme, keine Erklärung). Thema: "${query}"\nAntwort: {"term":"..."}` },
          ],
          { json: true, maxTokens: 200 }
        );
        if (t?.term) term = clean(t.term, 300);
      } catch (e) {
        console.warn('Übersetzung übersprungen:', e.code || e.message);
      }
    }

    const found = await searchPubMed(term, from, to, design);
    let papers = found.papers;

    // Volltexte laden (parallel), nur Treffer mit echtem Volltext behalten
    const texts = await Promise.all(papers.map((p) => fetchFulltext(p.pmc)));
    papers = papers
      .map((p, i) => ({ ...p, fulltext: texts[i].text, hasBody: texts[i].hasBody, chars: texts[i].text.length, figures: texts[i].figures || [] }))
      .filter((p) => p.hasBody)
      .slice(0, 12);

    if (papers.length && process.env.MGA_API_KEY) {
      try {
        const list = papers.map((p, i) => `${i}. ${p.title} (${p.journal}, ${p.date})\n   Abstract: ${p.fulltext.slice(0, 700).replace(/\n+/g, ' ')}`).join('\n');
        const ranked = await llm(
          [
            { role: 'system', content: 'Du bist ein ophthalmologischer Research-Assistent. Antworte ausschließlich mit JSON.' },
            { role: 'user', content: `Thema: "${query}". Bewerte jede Publikation nach Relevanz für ein Update-Referat (Score 1-10), gib eine deutsche Ein-Satz-Begründung und das Studiendesign in 2-4 Worten (z. B. "prospektiv, randomisiert", "retrospektive Kohorte", "Review").\n\n${list}\n\nJSON-Array: [{"i":0,"score":8,"why":"...","design":"..."}]` },
          ],
          { json: true, maxTokens: 3000 }
        );
        for (const r of ranked) if (papers[r.i]) Object.assign(papers[r.i], { score: r.score, why: r.why, design: r.design });
        papers.sort((a, b) => (b.score || 0) - (a.score || 0));
      } catch (e) {
        console.warn('Ranking übersprungen:', e.code || e.message);
      }
    }

    pool.papers = papers.map((p) => {
      const body = p.fulltext.replace(/^## Abstract\n[\s\S]*?\n\n/, '');
      return { ...p, license: 'free', preview: body.replace(/^## .*\n/gm, '').replace(/\s+/g, ' ').slice(0, 320) + '…' };
    });
    pool.outline = ''; pool.deck = null; pool.deckFindings = [];
    res.json({ papers: pool.papers.map(pub), query, term: found.term, from, to, design });
  } catch (err) {
    next(err);
  }
});

app.get('/papers/:id/fulltext', (req, res) => {
  const p = pool.papers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND', message: 'Paper nicht gefunden', statusCode: 404 });
  res.json({ id: p.id, title: p.title, text: p.fulltext });
});

app.get('/papers/:id/figures/:fig', (req, res) => {
  const p = pool.papers.find((x) => x.id === req.params.id);
  const f = p?.figures?.find((x) => x.id === req.params.fig);
  if (!f) return res.status(404).json({ error: 'NOT_FOUND', message: 'Abbildung nicht gefunden', statusCode: 404 });
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(f.data, 'base64'));
});

app.post('/uploads', (req, res) => {
  const filename = clean(req.body?.filename, 120);
  if (!filename) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Dateiname fehlt', statusCode: 400 });
  const u = { id: `up-${Date.now()}`, filename, size: Number(req.body?.size) || 0, text: clean(req.body?.text, 200000), at: new Date().toISOString() };
  pool.uploads.push(u);
  res.status(201).json({ id: u.id, filename: u.filename, size: u.size, at: u.at });
});
app.delete('/uploads/:id', (req, res) => {
  pool.uploads = pool.uploads.filter((u) => u.id !== req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Kontext aus Volltexten
// ---------------------------------------------------------------------------
function poolContext(perPaper) {
  const lines = pool.papers.map((p, i) => `[${i + 1}] ${p.title} – ${p.authors} (${p.journal}, ${p.date})\n${p.fulltext.slice(0, perPaper)}`);
  const ups = pool.uploads.map((u, i) => `[U${i + 1}] Upload ${u.filename}\n${u.text.slice(0, 3000)}`);
  return [...lines, ...ups].join('\n\n=====\n\n');
}

app.post('/outline', async (req, res, next) => {
  try {
    const topic = clean(req.body?.topic, 120);
    const history = (Array.isArray(req.body?.messages) ? req.body.messages : [])
      .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
    if (!pool.papers.length && !pool.uploads.length)
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Datenpool ist leer', statusCode: 400 });

    const system = `Du bist ein erfahrener ophthalmologischer Referent und erstellst die Gliederung für einen Update-Vortrag zum Thema "${topic}".
Nutze AUSSCHLIESSLICH die folgenden Volltexte aus dem Datenpool. Erfinde keine Zahlen; jede Aussage muss aus einem Volltext stammen.
${poolContext(7000)}

Regeln:
- Antworte auf Deutsch, in Markdown.
- Gliederung als nummerierte Folien: "## Folie N: Titel", darunter 2-4 Stichpunkte als "- ...", jeder Stichpunkt endet mit Quellenverweis(en) wie [2] oder [1][3].
- 8-12 Folien, beginnend mit Titel/Agenda, endend mit Take-Home-Messages.
- Bei Feedback des Nutzers: die KOMPLETTE überarbeitete Gliederung erneut ausgeben, nicht nur die Änderung.`;

    const messages = [{ role: 'system', content: system }];
    if (!history.length) messages.push({ role: 'user', content: 'Erstelle den ersten Entwurf der Gliederung.' });
    else messages.push(...history);

    const content = await llm(messages, { maxTokens: 3500, temperature: 0.3, model: 'opus' });
    pool.outline = content;
    res.json({ content });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
//  Cross-Check: Text (Outline oder Folienplan) gegen die Volltexte prüfen
// ---------------------------------------------------------------------------
async function crossCheck(text, model) {
  const perPaper = Math.max(4000, Math.floor(110000 / Math.max(1, pool.papers.length)));
  const findings = await llm(
    [
      { role: 'system', content: 'Du bist ein sorgfältiger wissenschaftlicher Faktenprüfer. Du prüfst jeden Stichpunkt einer Vortragsgliederung ausschließlich gegen die mitgelieferten Volltexte. Antworte nur mit JSON.' },
      {
        role: 'user',
        content: `VOLLTEXTE:\n${poolContext(perPaper)}\n\n=====\n\nGLIEDERUNG:\n${text}\n\nPrüfe JEDEN Stichpunkt (Zeilen mit "- ") jeder Folie. Status:
- "ok": Aussage inkl. Zahlen wird durch die referenzierte Quelle gedeckt
- "unsupported": Aussage findet sich so nicht in den Quellen (oder falsche Quelle referenziert)
- "contradicted": Quelle sagt etwas anderes (z. B. andere Zahl, gegenteiliges Ergebnis)
- "general": Allgemeinwissen/Agenda/Struktur ohne Prüfbedarf
"quote" = wörtliches Zitat (max. 180 Zeichen, exakt wie im Volltext, Originalsprache) der Belegstelle bzw. der widersprechenden Stelle; "" wenn keine. "source" = Nummer der Quelle. "note" = kurze deutsche Begründung (max. 150 Zeichen), bei ok leer.

JSON-Array, Reihenfolge wie in der Gliederung: [{"slide":2,"bullet":1,"status":"ok","source":3,"quote":"...","note":""}]`,
      },
    ],
    { json: true, maxTokens: 10000, temperature: 0, model }
  );
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    slide: Number(f.slide) || 0,
    bullet: Number(f.bullet) || 0,
    status: ['ok', 'unsupported', 'contradicted', 'general'].includes(f.status) ? f.status : 'unsupported',
    source: Number(f.source) || null,
    quote: clean(f.quote, 300),
    note: clean(f.note, 300),
  }));
}

app.post('/crosscheck', async (req, res, next) => {
  try {
    const outline = typeof req.body?.outline === 'string' && req.body.outline.trim() ? req.body.outline.slice(0, 20000) : pool.outline;
    const model = MODELS[req.body?.model] ? req.body.model : 'flash';
    if (!outline) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Keine Outline vorhanden', statusCode: 400 });
    if (!pool.papers.length) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Keine Volltexte im Datenpool', statusCode: 400 });
    const t0 = Date.now();
    const findings = await crossCheck(outline, model);
    res.json({ findings, model, modelLabel: MODELS[model].label, ms: Date.now() - t0 });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
//  Folienplan (Design-Pass mit Opus): Outline -> Layout je Folie, Abbildungen, Charts, Notizen
// ---------------------------------------------------------------------------
const LAYOUTS = {
  title: 'Titelfolie {title, subtitle}',
  section: 'Kapiteltrenner mit großer Nummer {title, subtitle}',
  bullets: 'Klassische Aussagenfolie {title, bullets[3-5], sources}',
  two_column: 'Gegenüberstellung / Vergleich {title, left:{heading,bullets[2-4]}, right:{heading,bullets[2-4]}, sources}',
  stat: 'Kennzahlen-Kacheln {title, stats:[{value:"−34 %",label:"..."}] (2-4), note, sources} – nur für belegte Zahlen',
  timeline: 'Ablauf / Zeitstrahl / Studiendesign {title, steps:[{label,text}] (3-5), sources}',
  figure: 'Original-Abbildung aus einer Publikation {title, figure:{paper:n,id:"f1"}, caption (deutsch, kurz), bullets[1-3], sources} – NUR Abbildungen aus der Liste',
  chart: 'Selbst erzeugtes Diagramm aus belegten Zahlen {title, chart:{type:"bar"|"line"|"pie", unit, categories[], series:[{name, values[]}]}, insight, sources}',
  quote: 'Kernaussage / wörtliches Zitat {title, quote (Originalsprache, ≤200 Zeichen), attribution, sources}',
  takeaways: 'Take-Home-Messages {title, items[3-5]}',
};

function figureList() {
  return pool.papers
    .flatMap((p, i) => (p.figures || []).map((f) => `Quelle [${i + 1}] Abbildung id="${f.id}" (${f.label}): ${f.caption.slice(0, 220)}`))
    .join('\n');
}

// Folienplan in prüfbaren Text (für den Cross-Check)
function deckToText(deck) {
  const src = (s) => (s ? ' ' + String(s).replace(/(\d+)/g, '[$1]').replace(/\[\[(\d+)\]\]/g, '[$1]') : '');
  return (deck.slides || [])
    .map((s, i) => {
      const lines = [];
      const add = (t) => t && lines.push(`- ${t}${src(s.sources)}`);
      if (s.layout === 'bullets') (s.bullets || []).forEach(add);
      if (s.layout === 'two_column') { (s.left?.bullets || []).forEach((b) => add(`${s.left.heading}: ${b}`)); (s.right?.bullets || []).forEach((b) => add(`${s.right.heading}: ${b}`)); }
      if (s.layout === 'stat') { (s.stats || []).forEach((st) => add(`${st.value} ${st.label}`)); add(s.note); }
      if (s.layout === 'timeline') (s.steps || []).forEach((st) => add(`${st.label}: ${st.text}`));
      if (s.layout === 'figure') { add(s.caption); (s.bullets || []).forEach(add); }
      if (s.layout === 'chart') { const c = s.chart || {}; (c.series || []).forEach((se) => add(`${se.name}: ${(c.categories || []).map((cat, k) => `${cat} = ${se.values?.[k]}${c.unit ? ' ' + c.unit : ''}`).join(', ')}`)); add(s.insight); }
      if (s.layout === 'quote') add(`"${s.quote}" – ${s.attribution}`);
      if (s.layout === 'takeaways') (s.items || []).forEach(add);
      return `## Folie ${i + 1}: ${s.title}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

app.post('/deck', async (req, res, next) => {
  try {
    const topic = clean(req.body?.topic, 120) || 'Update';
    const outline = typeof req.body?.outline === 'string' && req.body.outline.trim() ? req.body.outline.slice(0, 20000) : pool.outline;
    if (!outline) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Keine Outline vorhanden', statusCode: 400 });
    const t0 = Date.now();

    const deck = await llm(
      [
        { role: 'system', content: 'Du bist ein erfahrener Präsentationsdesigner für medizinische Fachvorträge. Du übersetzt eine faktenbasierte Gliederung in einen visuell abwechslungsreichen, präsentablen Folienplan. Antworte ausschließlich mit JSON.' },
        {
          role: 'user',
          content: `Thema: "${topic}".

Die folgende GLIEDERUNG ist nur der thematische rote Faden. Übernimm die Stichpunkte NICHT wörtlich, sondern gestalte jede Folie so, dass der Punkt bestmöglich rüberkommt: passendes Layout, prägnante Formulierung, Sprechernotizen.

GLIEDERUNG:
${outline}

VOLLTEXTE (Quelle [n]) – alle Zahlen und Aussagen müssen hieraus stammen:
${poolContext(5000)}

VERFÜGBARE ORIGINAL-ABBILDUNGEN (nur diese dürfen verwendet werden):
${figureList() || '(keine)'}

LAYOUT-KATALOG (layout → Felder):
${Object.entries(LAYOUTS).map(([k, v]) => `- "${k}": ${v}`).join('\n')}

Regeln:
- 10-14 Folien. Erste Folie "title", nach der Agenda mindestens 1 "section", letzte Folie "takeaways".
- Abwechslung: nie mehr als 2 "bullets"-Folien hintereinander. Nutze "stat", "two_column", "timeline", "chart", "figure", "quote", wo der Inhalt es hergibt.
- "figure": Verwende passende Original-Abbildungen (paper = Quellennummer, id wie in der Liste), wenn sie den Punkt tragen. Caption auf Deutsch kurz erklären.
- "chart": Nur mit Zahlen, die wörtlich in den Volltexten stehen (Einheiten angeben). Max 2 chart-Folien.
- "stat": Nur belegte Zahlen, z. B. Effektgrößen, n, Prozentwerte.
- Jede Inhaltsfolie: "sources" = Quellennummern als String wie "[1], [3]"; "notes" = 2-4 Sätze Sprechernotizen auf Deutsch mit dem Kontext, den die Folie nicht zeigt.
- Texte deutsch, prägnant: Titel ≤ 60 Zeichen, Stichpunkte ≤ 90 Zeichen, keine [n]-Verweise im Fließtext.

JSON: {"title":"...","subtitle":"...","slides":[{"layout":"...","title":"...", ...felder..., "sources":"[1]","notes":"..."}]}`,
        },
      ],
      { json: true, maxTokens: 14000, temperature: 0.35, model: 'opus' }
    );

    const slides = (Array.isArray(deck.slides) ? deck.slides : []).filter((s) => LAYOUTS[s.layout]).slice(0, 16);
    // Abbildungsverweise validieren
    for (const s of slides) {
      if (s.layout === 'figure') {
        const p = pool.papers[Number(s.figure?.paper) - 1];
        const f = p?.figures?.find((x) => x.id === s.figure?.id);
        if (!f) s.layout = 'bullets';
        else s.figureMeta = { paper: p.id, paperIndex: Number(s.figure.paper), id: f.id, label: f.label, url: `/api/papers/${p.id}/figures/${f.id}` };
      }
    }
    pool.deck = { title: deck.title || topic, subtitle: deck.subtitle || 'Update Ophthalmologie', slides };
    const tDesign = Date.now() - t0;

    // Cross-Referencing des Folienplans mit Opus
    let findings = [];
    try { findings = await crossCheck(deckToText(pool.deck), 'opus'); } catch (e) { console.warn('Deck-Check übersprungen:', e.code || e.message); }
    pool.deckFindings = findings;
    res.json({ deck: pool.deck, findings, ms: { design: tDesign, check: Date.now() - t0 - tDesign } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
//  PowerPoint-Renderer: Layout-Bibliothek
// ---------------------------------------------------------------------------
const T = { navy: '0B2447', blue: '0A6CFF', sky: '5AA0FF', teal: '0E9F8A', amber: 'F59E0B', rose: 'E11D48', ink: '1C2430', muted: '5B6675', light: 'F3F6FB', line: 'E2E8F0', white: 'FFFFFF' };
const F = 'Calibri';
const PALETTE = [T.blue, T.teal, T.amber, T.rose, T.navy];

function chrome(slide, pptx, n, total, title) {
  if (title) {
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.95, fill: { color: T.white }, line: { color: T.white } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.45, y: 0.72, w: 0.7, h: 0.05, fill: { color: T.blue }, line: { color: T.blue } });
    slide.addText(title, { x: 0.45, y: 0.15, w: 9.1, h: 0.58, fontSize: 24, bold: true, color: T.navy, fontFace: F, valign: 'middle' });
  }
  slide.addText('Research Radar · Update Ophthalmologie', { x: 0.45, y: 5.3, w: 6, h: 0.25, fontSize: 9, color: T.muted, fontFace: F });
  slide.addText(`${n} / ${total}`, { x: 8.6, y: 5.3, w: 1, h: 0.25, fontSize: 9, color: T.muted, align: 'right', fontFace: F });
}
const sourcesLine = (slide, s) => s.sources && slide.addText(`Quellen: ${s.sources}`, { x: 0.45, y: 4.98, w: 9, h: 0.3, fontSize: 9, italic: true, color: T.muted, fontFace: F });
const bulletsText = (arr, max = 6) => (arr || []).slice(0, max).map((b) => ({ text: String(b), options: { bullet: { indent: 16 }, breakLine: true } }));

const R = {
  title(s, slide, pptx, deck) {
    slide.background = { color: T.navy };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 5.63, fill: { type: 'solid', color: T.navy } });
    slide.addShape(pptx.ShapeType.ellipse, { x: 6.8, y: -1.6, w: 5, h: 5, fill: { color: '13315C' }, line: { color: '13315C' } });
    slide.addShape(pptx.ShapeType.ellipse, { x: 8.2, y: 3.4, w: 3.2, h: 3.2, fill: { color: T.blue }, line: { color: T.blue } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.55, w: 0.9, h: 0.06, fill: { color: T.sky }, line: { color: T.sky } });
    slide.addText(s.title || deck.title, { x: 0.6, y: 1.7, w: 7.4, h: 1.7, fontSize: 36, bold: true, color: T.white, fontFace: F, valign: 'top' });
    slide.addText(s.subtitle || deck.subtitle, { x: 0.6, y: 3.45, w: 7, h: 0.6, fontSize: 18, color: 'BFD4FF', fontFace: F });
    slide.addText(new Date().toLocaleDateString('de-DE', { year: 'numeric', month: 'long' }), { x: 0.6, y: 4.7, w: 6, h: 0.35, fontSize: 12, color: '8FB3FF', fontFace: F });
  },
  section(s, slide, pptx, deck, i) {
    slide.background = { color: T.light };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 3.2, h: 5.63, fill: { color: T.navy }, line: { color: T.navy } });
    slide.addText(String(i).padStart(2, '0'), { x: 0.3, y: 1.6, w: 2.7, h: 2, fontSize: 80, bold: true, color: T.sky, fontFace: F, align: 'center', valign: 'middle' });
    slide.addText(s.title, { x: 3.7, y: 1.7, w: 5.9, h: 1.3, fontSize: 32, bold: true, color: T.navy, fontFace: F, valign: 'bottom' });
    if (s.subtitle) slide.addText(s.subtitle, { x: 3.7, y: 3.05, w: 5.9, h: 0.9, fontSize: 16, color: T.muted, fontFace: F });
  },
  bullets(s, slide, pptx) {
    slide.addText(bulletsText(s.bullets), { x: 0.5, y: 1.2, w: 9, h: 3.6, fontSize: 17, color: T.ink, fontFace: F, valign: 'top', paraSpaceAfter: 10 });
    sourcesLine(slide, s);
  },
  two_column(s, slide, pptx) {
    [[s.left, 0.45, T.blue], [s.right, 5.15, T.teal]].forEach(([col, x, color]) => {
      if (!col) return;
      slide.addShape(pptx.ShapeType.rect, { x, y: 1.2, w: 4.4, h: 3.7, fill: { color: T.light }, line: { color: T.light }, rectRadius: 0.1 });
      slide.addShape(pptx.ShapeType.rect, { x, y: 1.2, w: 4.4, h: 0.55, fill: { color }, line: { color } });
      slide.addText(col.heading || '', { x: x + 0.15, y: 1.2, w: 4.1, h: 0.55, fontSize: 15, bold: true, color: T.white, fontFace: F, valign: 'middle' });
      slide.addText(bulletsText(col.bullets, 4), { x: x + 0.15, y: 1.85, w: 4.1, h: 2.95, fontSize: 14, color: T.ink, fontFace: F, valign: 'top', paraSpaceAfter: 6 });
    });
    sourcesLine(slide, s);
  },
  stat(s, slide, pptx) {
    const stats = (s.stats || []).slice(0, 4);
    const w = (9.1 - 0.25 * (stats.length - 1)) / stats.length;
    stats.forEach((st, k) => {
      const x = 0.45 + k * (w + 0.25);
      slide.addShape(pptx.ShapeType.rect, { x, y: 1.3, w, h: 2.3, fill: { color: T.light }, line: { color: T.line } });
      slide.addShape(pptx.ShapeType.rect, { x, y: 1.3, w, h: 0.08, fill: { color: PALETTE[k % PALETTE.length] }, line: { color: PALETTE[k % PALETTE.length] } });
      slide.addText(String(st.value), { x: x + 0.1, y: 1.5, w: w - 0.2, h: 1.1, fontSize: stats.length > 3 ? 30 : 38, bold: true, color: PALETTE[k % PALETTE.length], fontFace: F, align: 'center', valign: 'middle' });
      slide.addText(String(st.label), { x: x + 0.15, y: 2.6, w: w - 0.3, h: 0.9, fontSize: 12, color: T.ink, fontFace: F, align: 'center', valign: 'top' });
    });
    if (s.note) slide.addText(s.note, { x: 0.45, y: 3.85, w: 9.1, h: 0.9, fontSize: 14, color: T.muted, fontFace: F, italic: true, valign: 'top' });
    sourcesLine(slide, s);
  },
  timeline(s, slide, pptx) {
    const steps = (s.steps || []).slice(0, 5);
    const w = 9.1 / steps.length;
    slide.addShape(pptx.ShapeType.line, { x: 0.45 + w / 2, y: 1.75, w: 9.1 - w, h: 0, line: { color: T.line, width: 3 } });
    steps.forEach((st, k) => {
      const cx = 0.45 + k * w + w / 2;
      slide.addShape(pptx.ShapeType.ellipse, { x: cx - 0.24, y: 1.51, w: 0.48, h: 0.48, fill: { color: PALETTE[k % PALETTE.length] }, line: { color: T.white, width: 2 } });
      slide.addText(String(k + 1), { x: cx - 0.24, y: 1.51, w: 0.48, h: 0.48, fontSize: 12, bold: true, color: T.white, fontFace: F, align: 'center', valign: 'middle' });
      slide.addText(st.label || '', { x: 0.45 + k * w + 0.05, y: 2.15, w: w - 0.1, h: 0.5, fontSize: 13, bold: true, color: T.navy, fontFace: F, align: 'center' });
      slide.addText(st.text || '', { x: 0.45 + k * w + 0.05, y: 2.65, w: w - 0.1, h: 2.1, fontSize: 11.5, color: T.ink, fontFace: F, align: 'center', valign: 'top' });
    });
    sourcesLine(slide, s);
  },
  figure(s, slide, pptx) {
    const f = s.figureMeta;
    const p = pool.papers.find((x) => x.id === f?.paper);
    const fig = p?.figures?.find((x) => x.id === f?.id);
    if (fig) slide.addImage({ data: `${fig.mime};base64,${fig.data}`, x: 0.45, y: 1.15, w: 5.6, h: 3.7, sizing: { type: 'contain', w: 5.6, h: 3.7 } });
    slide.addShape(pptx.ShapeType.rect, { x: 6.3, y: 1.15, w: 3.25, h: 3.7, fill: { color: T.light }, line: { color: T.light } });
    slide.addText(bulletsText(s.bullets, 3), { x: 6.45, y: 1.3, w: 3, h: 2.4, fontSize: 13, color: T.ink, fontFace: F, valign: 'top', paraSpaceAfter: 6 });
    slide.addText(`${fig?.label || 'Abbildung'} aus Quelle [${f?.paperIndex}]${s.caption ? ': ' + s.caption : ''}`, { x: 6.45, y: 3.75, w: 3, h: 1.05, fontSize: 9.5, italic: true, color: T.muted, fontFace: F, valign: 'bottom' });
    sourcesLine(slide, s);
  },
  chart(s, slide, pptx) {
    const c = s.chart || {};
    const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[c.type] || pptx.ChartType.bar;
    const data = (c.series || []).map((se) => ({ name: se.name, labels: c.categories || [], values: (se.values || []).map(Number) }));
    if (data.length) {
      slide.addChart(type, data, {
        x: 0.45, y: 1.15, w: 6.1, h: 3.75, chartColors: PALETTE, barGrouping: 'clustered',
        showLegend: data.length > 1 || c.type === 'pie', legendPos: 'b', legendFontSize: 10,
        catAxisLabelFontSize: 10, valAxisLabelFontSize: 10, valAxisTitle: c.unit || '', showValAxisTitle: Boolean(c.unit),
        showValue: true, dataLabelFontSize: 9, dataLabelColor: T.ink, valGridLine: { color: T.line, size: 0.5 },
        showTitle: false, showPercent: c.type === 'pie',
      });
    }
    slide.addShape(pptx.ShapeType.rect, { x: 6.8, y: 1.15, w: 2.75, h: 3.75, fill: { color: T.navy }, line: { color: T.navy } });
    slide.addText('Was das zeigt', { x: 6.95, y: 1.3, w: 2.5, h: 0.4, fontSize: 12, bold: true, color: T.sky, fontFace: F });
    slide.addText(s.insight || '', { x: 6.95, y: 1.7, w: 2.5, h: 2.6, fontSize: 13, color: T.white, fontFace: F, valign: 'top' });
    slide.addText('Diagramm aus Studiendaten erzeugt', { x: 6.95, y: 4.4, w: 2.5, h: 0.4, fontSize: 9, italic: true, color: '8FB3FF', fontFace: F });
    sourcesLine(slide, s);
  },
  quote(s, slide, pptx) {
    slide.addShape(pptx.ShapeType.rect, { x: 0.45, y: 1.3, w: 9.1, h: 3.3, fill: { color: T.light }, line: { color: T.light } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.45, y: 1.3, w: 0.12, h: 3.3, fill: { color: T.amber }, line: { color: T.amber } });
    slide.addText('“', { x: 0.75, y: 1.2, w: 1, h: 1, fontSize: 72, bold: true, color: T.amber, fontFace: 'Georgia' });
    slide.addText(s.quote || '', { x: 1.3, y: 1.6, w: 7.9, h: 2.2, fontSize: 19, italic: true, color: T.navy, fontFace: 'Georgia', valign: 'middle' });
    slide.addText(`— ${s.attribution || ''}`, { x: 1.3, y: 3.9, w: 7.9, h: 0.5, fontSize: 12, color: T.muted, fontFace: F, align: 'right' });
    sourcesLine(slide, s);
  },
  takeaways(s, slide, pptx) {
    const items = (s.items || []).slice(0, 5);
    items.forEach((it, k) => {
      const y = 1.2 + k * (3.7 / Math.max(items.length, 3));
      slide.addShape(pptx.ShapeType.ellipse, { x: 0.5, y: y + 0.05, w: 0.5, h: 0.5, fill: { color: T.teal }, line: { color: T.teal } });
      slide.addText(String(k + 1), { x: 0.5, y: y + 0.05, w: 0.5, h: 0.5, fontSize: 13, bold: true, color: T.white, fontFace: F, align: 'center', valign: 'middle' });
      slide.addText(String(it), { x: 1.2, y, w: 8.3, h: 0.6, fontSize: 16, color: T.ink, fontFace: F, valign: 'middle' });
    });
  },
};

async function buildPptx(deck) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Research Radar';
  pptx.title = deck.title;
  const slides = deck.slides || [];
  const total = slides.length + 1;
  let sectionNo = 0;
  slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: T.white };
    const plain = !['title', 'section'].includes(s.layout);
    if (s.layout === 'section') sectionNo += 1;
    (R[s.layout] || R.bullets)(s, slide, pptx, deck, sectionNo);
    if (plain) chrome(slide, pptx, i + 1, total, s.title);
    if (s.notes) slide.addNotes(String(s.notes));
  });
  const ref = pptx.addSlide();
  ref.background = { color: T.white };
  chrome(ref, pptx, total, total, 'Quellen');
  const refText = pool.papers.map((p, i) => ({ text: `[${i + 1}] ${p.authors}. ${p.title} ${p.journal} ${p.date}. PMID ${p.pmid}`, options: { breakLine: true } }));
  if (refText.length) ref.addText(refText, { x: 0.5, y: 1.1, w: 9, h: 4.1, fontSize: 9, color: T.ink, fontFace: F, valign: 'top', paraSpaceAfter: 4 });
  return pptx.write({ outputType: 'nodebuffer' });
}

app.post('/pptx', async (req, res, next) => {
  try {
    const topic = clean(req.body?.topic, 120) || 'Update';
    if (!pool.deck) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Kein Folienplan vorhanden', statusCode: 400 });
    const buf = await buildPptx(pool.deck);
    const fname = `Update_${topic.replace(/[^\wÀ-ſ-]+/g, '_').slice(0, 60)}.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('X-Slide-Count', String((pool.deck.slides || []).length + 1));
    res.send(buf);
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Server error:', err.code || 'INTERNAL_ERROR', err.message);
  try { fs.appendFileSync(path.join(__dirname, 'error.log'), new Date().toISOString() + ' ' + req.method + ' ' + req.path + ' :: ' + (err.stack || err.message) + String.fromCharCode(10)); } catch {}
  const code = err.statusCode || 500;
  res.status(code).json({ error: err.code || 'INTERNAL_ERROR', message: code < 500 ? err.message : 'Ein unerwarteter Fehler ist aufgetreten', statusCode: code });
});

if (HAS_DIST) app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend läuft auf Port ${PORT} · KI: ${process.env.MGA_API_KEY ? 'aktiv' : 'fehlt'}`));
