import { useEffect, useMemo, useRef, useState } from 'react';

const STEPS = ['Recherche', 'Datenpool', 'Outline', 'Foliendesign'];
const iso = (d) => d.toISOString().slice(0, 10);
const fmtBytes = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB');
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('de-DE') : '');

function readFile(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => resolve('');
    if (file.type.startsWith('text') || /\.(txt|md|csv)$/i.test(file.name)) r.readAsText(file);
    else resolve('');
  });
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Fehler');
  return data;
}

// Outline-Markdown in Folien/Stichpunkte zerlegen
function parseOutline(text) {
  const slides = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    if (!line) return;
    if (/^#{1,3}\s/.test(line)) {
      cur = { title: line.replace(/^#+\s*/, ''), bullets: [], n: slides.length + 1 };
      const m = cur.title.match(/Folie\s*(\d+)/i);
      if (m) cur.n = Number(m[1]);
      slides.push(cur);
    } else if (/^[-*•]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
      if (!cur) { cur = { title: '', bullets: [], n: slides.length + 1 }; slides.push(cur); }
      cur.bullets.push(line.replace(/^([-*•]|\d+[.)])\s*/, ''));
    } else if (cur) cur.bullets.push(line);
  });
  return slides;
}

export default function App() {
  const [sources, setSources] = useState({});
  const [models, setModels] = useState({});
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState(iso(new Date(Date.now() - 365 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  const [design, setDesign] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, label: '' });
  const [papers, setPapers] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState('');
  const [term, setTerm] = useState('');
  const [searched, setSearched] = useState(false);
  const [step, setStep] = useState(0);
  const [chat, setChat] = useState([]);
  const [outline, setOutline] = useState('');
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pptx, setPptx] = useState({ busy: false, url: '', name: '', slides: 0 });
  const [deck, setDeck] = useState({ busy: false, phase: '', data: null, findings: [] });
  const [check, setCheck] = useState({ busy: false, findings: null, modelLabel: '', ms: 0, at: null });
  const [checkModel, setCheckModel] = useState(() => { try { return localStorage.getItem('rr-checkModel') || ''; } catch { return ''; } });
  const [modelDialog, setModelDialog] = useState(null); // {after: fn}
  const [viewer, setViewer] = useState(null); // {paper, quote}
  const timer = useRef();

  useEffect(() => {
    fetch('/api/sources').then((r) => r.json()).then((d) => { setSources(d.sources || {}); setModels(d.models || {}); }).catch(() => {});
  }, []);

  function startProgress() {
    const phases = ['PubMed wird abgefragt…', 'Freie Volltexte werden geladen…', 'Relevanz wird bewertet…', 'Datenpool wird aufgebaut…'];
    let pct = 0;
    setProgress({ pct: 3, label: phases[0] });
    timer.current = setInterval(() => {
      pct = Math.min(92, pct + (pct < 40 ? 3 : pct < 75 ? 1.5 : 0.5));
      setProgress({ pct, label: phases[Math.min(3, Math.floor(pct / 25))] });
    }, 300);
  }

  async function search(e) {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setError(''); setLoading(true); setPapers([]); setSearched(false);
    startProgress();
    try {
      const data = await post('/api/search', { query: query.trim(), from, to, design });
      setPapers(data.papers || []);
      setTerm(data.term || '');
      setSearched(true);
      setStep(1);
    } catch (err) {
      setError(err.message);
    } finally {
      clearInterval(timer.current);
      setProgress({ pct: 100, label: 'Fertig' });
      setTimeout(() => setLoading(false), 350);
    }
  }

  async function addUpload(file) {
    const text = await readFile(file);
    const created = await post('/api/uploads', { filename: file.name, size: file.size, text });
    setUploads((u) => [...u, created]);
  }
  async function removeUpload(id) {
    await fetch(`/api/uploads/${id}`, { method: 'DELETE' });
    setUploads((u) => u.filter((x) => x.id !== id));
  }

  // ---------------- Outline + Cross-Check ----------------
  async function requestOutline(messages) {
    setOutlineBusy(true); setError('');
    try {
      const data = await post('/api/outline', { topic: query.trim(), messages });
      setOutline(data.content);
      setChat([...messages, { role: 'assistant', content: data.content }]);
      runCheck(data.content);
    } catch (err) {
      setError(err.message);
    } finally {
      setOutlineBusy(false);
    }
  }

  function chooseModel(after) {
    setModelDialog({ after });
  }

  function runCheck(text, forceModel) {
    const model = forceModel || checkModel;
    if (!model) return chooseModel((m) => runCheck(text, m));
    setCheck((c) => ({ ...c, busy: true }));
    post('/api/crosscheck', { outline: text || outline, model })
      .then((d) => setCheck({ busy: false, findings: d.findings, modelLabel: d.modelLabel, ms: d.ms, at: new Date() }))
      .catch((err) => { setCheck((c) => ({ ...c, busy: false })); setError(err.message); });
  }

  function goOutline() {
    setStep(2); setChat([]); setOutline(''); setCheck({ busy: false, findings: null, modelLabel: '', ms: 0, at: null });
    requestOutline([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function sendFeedback(e) {
    e.preventDefault();
    if (!feedback.trim() || outlineBusy) return;
    const msgs = [...chat, { role: 'user', content: feedback.trim() }];
    setFeedback('');
    requestOutline(msgs);
  }

  // Schritt 1: Folienplan (Design-Pass mit Opus) + Cross-Referencing
  async function designDeck() {
    setStep(3); setError('');
    setDeck({ busy: true, phase: 'design', data: null, findings: [] });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const t = setTimeout(() => setDeck((d) => (d.busy ? { ...d, phase: 'check' } : d)), 45000);
    try {
      const data = await post('/api/deck', { topic: query.trim(), outline });
      setDeck({ busy: false, phase: '', data: data.deck, findings: data.findings || [] });
    } catch (err) {
      setError(err.message);
      setDeck({ busy: false, phase: '', data: null, findings: [] });
    } finally {
      clearTimeout(t);
    }
  }

  // Schritt 2: PPTX aus dem geprüften Folienplan
  async function createPptx() {
    setPptx({ busy: true, url: '', name: '', slides: 0 }); setError('');
    try {
      const res = await fetch('/api/pptx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: query.trim() }) });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.message || 'PowerPoint konnte nicht erstellt werden'); }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || 'Update.pptx';
      const url = URL.createObjectURL(blob);
      setPptx({ busy: false, url, name, slides: Number(res.headers.get('X-Slide-Count')) || 0 });
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    } catch (err) {
      setError(err.message);
      setPptx({ busy: false, url: '', name: '', slides: 0 });
    }
  }

  function openSource(n, quote) {
    const p = papers[n - 1];
    if (p) setViewer({ paper: p, quote: quote || '' });
  }

  const summary = useMemo(() => {
    const f = check.findings || [];
    return { ok: f.filter((x) => x.status === 'ok').length, warn: f.filter((x) => x.status === 'unsupported').length, bad: f.filter((x) => x.status === 'contradicted').length };
  }, [check.findings]);

  const designLabel = { '': 'alle Studiendesigns', prospective: 'nur prospektiv', retrospective: 'nur nicht-prospektiv' }[design];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand"><span className="dot" />Research Radar · Ophthalmologie</div>
        <nav className="stepper">
          {STEPS.map((s, i) => (
            <span key={s} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}><b>{i + 1}</b> {s}</span>
          ))}
        </nav>
      </header>

      <main className="container wide">
        {/* ---------------- Suche ---------------- */}
        {step < 2 && (
          <section className="card">
            <h1>Was ist neu zu deinem Thema?</h1>
            <p className="lead">Stichwort, Zeitraum und Studiendesign wählen. Es werden nur Publikationen mit frei verfügbarem Volltext berücksichtigt und die Volltexte direkt in den Datenpool geladen.</p>
            <form onSubmit={search} className="searchform">
              <div className="row">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="z. B. Faricimab bei diabetischem Makulaödem" maxLength={120} autoFocus />
                <button type="submit" disabled={loading || !query.trim()}>{loading ? 'Recherchiert…' : 'Recherche starten'}</button>
              </div>

              <div className="filters">
                <div className="filter">
                  <label>Zeitraum</label>
                  <div className="daterange">
                    <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                    <span>bis</span>
                    <input type="date" value={to} min={from} max={iso(new Date())} onChange={(e) => setTo(e.target.value)} />
                  </div>
                  <div className="quick">
                    {[[6, '6 Mon.'], [12, '1 Jahr'], [24, '2 Jahre'], [36, '3 Jahre']].map(([m, l]) => (
                      <button type="button" key={m} className="ghost small" onClick={() => { const d = new Date(); d.setMonth(d.getMonth() - m); setFrom(iso(d)); setTo(iso(new Date())); }}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="filter">
                  <label>Studiendesign</label>
                  <div className="seg">
                    {[['', 'Egal'], ['prospective', 'Prospektiv'], ['retrospective', 'Nicht prospektiv']].map(([v, l]) => (
                      <button type="button" key={v} className={design === v ? 'on' : ''} onClick={() => setDesign(v)}>{l}</button>
                    ))}
                  </div>
                  <small className="muted">{design ? 'Filter aktiv – über „Egal" wieder ausschalten' : 'Kein Filter, alle Designs'}</small>
                </div>
                <div className="filter">
                  <label>Quellen</label>
                  <div className="chips">
                    {Object.entries(sources).map(([key, s]) => (
                      <span key={key} className="chip on">{s.label}</span>
                    ))}
                  </div>
                  <small className="muted">Recherche und Bewertung mit Claude Opus 5</small>
                </div>
              </div>
            </form>

            {loading && (
              <div className="progress">
                <div className="bar"><div style={{ width: progress.pct + '%' }} /></div>
                <span>{progress.label}</span>
              </div>
            )}
            {error && <p className="error">{error}</p>}
            {!loading && term && <p className="muted termline">PubMed-Suchbegriff: <code>{term}</code> · {fmtDate(from)} – {fmtDate(to)} · {designLabel}</p>}
            {!loading && searched && papers.length === 0 && !error && (
              <p className="error">Keine Treffer mit freiem Volltext im gewählten Zeitraum. Zeitraum erweitern, Design-Filter lösen oder Stichwort anpassen.</p>
            )}
          </section>
        )}

        {/* ---------------- Ergebnisse ---------------- */}
        {step < 2 && papers.length > 0 && (
          <section className="card">
            <div className="cardhead">
              <h2>{papers.length} Publikationen mit Volltext im Datenpool</h2>
              <div className="stats">
                <span className="pill ok">✓ {papers.length} Volltexte geladen</span>
                <span className="pill muted">{Math.round(papers.reduce((a, p) => a + (p.chars || 0), 0) / 1000)} k Zeichen</span>
              </div>
            </div>
            <ul className="papers">
              {papers.map((p, i) => (
                <li key={p.id} className="paper">
                  <div className="status green">{i + 1}</div>
                  <div className="body">
                    <a href={p.url} target="_blank" rel="noreferrer" className="title">{p.title}</a>
                    <div className="meta">
                      {p.authors && <span>{p.authors}</span>}
                      {p.journal && <span>{p.journal}</span>}
                      {p.date && <span>{p.date}</span>}
                      {p.design && <span className="design">{p.design}</span>}
                      {p.score != null && <span className="score">Relevanz {p.score}/10</span>}
                    </div>
                    {p.why && <p className="why">{p.why}</p>}
                    {p.preview && <p className="preview">{p.preview}</p>}
                    <div className="actions">
                      <button type="button" className="ghost small" onClick={() => setViewer({ paper: p, quote: '' })}>Volltext ansehen</button>
                      <a href={p.fulltextUrl} target="_blank" rel="noreferrer" className="linkbtn">PMC öffnen ↗</a>
                      <span className="tag">{Math.round((p.chars || 0) / 1000)} k Zeichen Volltext</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---------------- Zusatz-Uploads ---------------- */}
        {step < 2 && papers.length > 0 && (
          <section className="card">
            <div className="cardhead">
              <h2>Weitere Unterlagen zum Datenpool hinzufügen</h2>
              <label className="ghost filebtn">+ Datei hochladen<input type="file" hidden onChange={(e) => e.target.files[0] && addUpload(e.target.files[0])} /></label>
            </div>
            {uploads.length === 0 ? (
              <p className="empty">Noch keine zusätzlichen Unterlagen (eigene Notizen, Vortragsfolien, Abstracts …).</p>
            ) : (
              <ul className="list">
                {uploads.map((u) => (
                  <li key={u.id} className="uploadrow">
                    <span>📄 {u.filename} <small>{fmtBytes(u.size)}</small></span>
                    <button type="button" className="ghost small" onClick={() => removeUpload(u.id)}>Entfernen</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="next">
              <span className="muted">Datenpool: {papers.length} Volltexte + {uploads.length} Unterlagen</span>
              <button type="button" className="go" onClick={goOutline}>Analyse starten →</button>
            </div>
          </section>
        )}

        {/* ---------------- Outline ---------------- */}
        {step === 2 && (
          <section className="card outline">
            <div className="cardhead">
              <div>
                <h1>Vortrags-Outline: {query}</h1>
                <p className="lead">Basis: {papers.length} Volltexte + {uploads.length} Unterlagen. Jeder Stichpunkt wird gegen die Volltexte gegengeprüft. Quellenverweise [n] öffnen die Belegstelle.</p>
              </div>
              <button type="button" className="ghost" onClick={() => setStep(1)}>← Zurück zum Datenpool</button>
            </div>

            <div className="split">
              <div className="draft">
                {outlineBusy && (
                  <div className="progress">
                    <div className="bar indeterminate"><div /></div>
                    <span>{outline ? 'Gliederung wird überarbeitet…' : 'Gliederung wird aus den Volltexten erstellt…'}</span>
                  </div>
                )}
                {outline && !outlineBusy && (
                  <CheckBar check={check} summary={summary} models={models} checkModel={checkModel} onCheck={() => chooseModel((m) => runCheck(outline, m))} onModel={() => chooseModel(() => {})} />
                )}
                {outline && <Outline text={outline} findings={check.findings} onSource={openSource} />}
                {error && <p className="error">{error}</p>}
              </div>

              <aside className="chatbox">
                <h2>Feedback</h2>
                <div className="msgs">
                  {chat.filter((m) => m.role === 'user').length === 0 && (
                    <p className="empty">z. B. „Folie 3 nach vorn, Take-Home-Messages kürzen, mehr zu Anti-VEGF-Intervallen"</p>
                  )}
                  {chat.map((m, i) => (m.role === 'user' ? <div key={i} className="msg me">{m.content}</div> : i > 0 && <div key={i} className="msg ai">Gliederung aktualisiert ✓</div>))}
                </div>
                <form onSubmit={sendFeedback} className="row">
                  <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Änderungswunsch…" maxLength={500} disabled={outlineBusy} />
                  <button type="submit" disabled={outlineBusy || !feedback.trim()}>Senden</button>
                </form>
                {summary.bad > 0 && <p className="hint bad">⚠ {summary.bad} Widerspruch{summary.bad > 1 ? 'e' : ''} zu den Volltexten – vor der PowerPoint prüfen.</p>}
                <button type="button" className="go" disabled={!outline || outlineBusy} onClick={designDeck}>✓ PowerPoint erstellen</button>
                <small className="muted">Die Gliederung dient als roter Faden. Im nächsten Schritt werden Layouts, Abbildungen und Formulierungen gestaltet und erneut gegen die Volltexte geprüft.</small>
              </aside>
            </div>
          </section>
        )}

        {/* ---------------- Foliendesign + PowerPoint ---------------- */}
        {step === 3 && (
          <section className="card pptx">
            <div className="cardhead">
              <div>
                <h1>Foliendesign: {query}</h1>
                <p className="lead">Aus der Gliederung wird ein gestalteter Foliensatz: passendes Layout je Aussage, Original-Abbildungen aus den Publikationen, Diagramme aus belegten Zahlen, Sprechernotizen.</p>
              </div>
            </div>

            {deck.busy && (
              <div className="progress">
                <div className="bar indeterminate"><div /></div>
                <span>{deck.phase === 'check' ? 'Folienplan wird gegen die Volltexte geprüft (Claude Opus 5)…' : 'Layouts, Abbildungen und Formulierungen werden gestaltet (Claude Opus 5)…'}</span>
              </div>
            )}
            {error && <p className="error">{error}</p>}

            {deck.data && !pptx.url && (
              <DeckPreview deck={deck.data} findings={deck.findings} onSource={openSource} busy={pptx.busy} onBuild={createPptx} onBack={() => setStep(2)} />
            )}

            {pptx.url && (
              <div className="done">
                <div className="bigcheck">✓</div>
                <h2>Präsentation fertig</h2>
                <p className="lead">{pptx.name} · {pptx.slides} Folien · Download wurde gestartet</p>
                <div className="row center">
                  <a className="btn" href={pptx.url} download={pptx.name}>⬇ Erneut herunterladen</a>
                  <button type="button" className="ghost" onClick={() => setPptx({ busy: false, url: '', name: '', slides: 0 })}>← Folienplan ansehen</button>
                  <button type="button" className="ghost" onClick={() => { setPptx({ busy: false, url: '', name: '', slides: 0 }); setStep(2); }}>← Outline anpassen</button>
                </div>
              </div>
            )}
            {!deck.busy && !deck.data && error && <div className="row center"><button type="button" className="ghost" onClick={() => setStep(2)}>← Zurück zur Outline</button></div>}
          </section>
        )}
      </main>

      {modelDialog && (
        <ModelDialog
          models={models}
          current={checkModel}
          onClose={() => setModelDialog(null)}
          onPick={(m, remember) => {
            setCheckModel(m);
            try { remember ? localStorage.setItem('rr-checkModel', m) : localStorage.removeItem('rr-checkModel'); } catch {}
            const after = modelDialog.after;
            setModelDialog(null);
            after(m);
          }}
        />
      )}
      {viewer && <FullTextDrawer paper={viewer.paper} quote={viewer.quote} index={papers.indexOf(viewer.paper) + 1} onClose={() => setViewer(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function CheckBar({ check, summary, checkModel, models, onCheck, onModel }) {
  const total = summary.ok + summary.warn + summary.bad;
  return (
    <div className={`checkbar ${check.busy ? 'busy' : summary.bad ? 'bad' : summary.warn ? 'warn' : check.findings ? 'ok' : ''}`}>
      <div className="ctext">
        {check.busy ? (
          <><span className="spin" /> Cross-Check läuft – jeder Stichpunkt wird gegen die Volltexte geprüft…</>
        ) : check.findings ? (
          <>
            <b>Cross-Check:</b> {summary.ok}/{total} belegt
            {summary.warn > 0 && <span className="cb warn">{summary.warn} nicht belegt</span>}
            {summary.bad > 0 && <span className="cb bad">{summary.bad} Widerspruch</span>}
            {total > 0 && summary.warn === 0 && summary.bad === 0 && <span className="cb ok">keine Auffälligkeiten</span>}
            <small>{check.modelLabel} · {(check.ms / 1000).toFixed(1)} s</small>
          </>
        ) : (
          <>Noch kein Cross-Check durchgeführt.</>
        )}
      </div>
      <div className="cactions">
        <button type="button" className="ghost small" onClick={onModel} title="Prüfmodell wählen">{models[checkModel]?.label || 'Modell wählen'} ▾</button>
        <button type="button" className="small" disabled={check.busy} onClick={onCheck}>⟳ Double Check</button>
      </div>
    </div>
  );
}

function ModelDialog({ models, current, onClose, onPick }) {
  const [sel, setSel] = useState(current || 'flash');
  const [remember, setRemember] = useState(true);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Welches Modell soll den Cross-Check machen?</h2>
        <p className="title">Die Outline wird Stichpunkt für Stichpunkt gegen die geladenen Volltexte geprüft.</p>
        <fieldset className="license">
          {Object.entries(models).map(([k, m]) => (
            <label key={k} className={sel === k ? 'on' : ''}>
              <input type="radio" name="model" checked={sel === k} onChange={() => setSel(k)} />
              <b>{m.label}</b>
              <small>{k === 'flash' ? 'Schnell (wenige Sekunden), gut für die laufende Kontrolle' : 'Gründlich, langsamer – für die finale Abnahme'}</small>
            </label>
          ))}
        </fieldset>
        <label className="remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Auswahl merken (jederzeit über „Modell ▾" änderbar)</label>
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>Abbrechen</button>
          <button type="button" onClick={() => onPick(sel, remember)}>Cross-Check starten</button>
        </div>
      </div>
    </div>
  );
}

// Outline mit Befunden und klickbaren Quellenverweisen
function Outline({ text, findings, onSource }) {
  const slides = useMemo(() => parseOutline(text), [text]);
  const find = (s, b) => (findings || []).find((f) => f.slide === s && f.bullet === b);
  const label = { unsupported: 'nicht belegt', contradicted: 'Widerspruch', ok: 'belegt', general: '' };

  function renderRefs(str, f) {
    const parts = str.split(/(\[\d+\])/g);
    return parts.map((part, i) => {
      const m = part.match(/^\[(\d+)\]$/);
      if (!m) return part;
      const n = Number(m[1]);
      const q = f && f.source === n ? f.quote : '';
      return <button type="button" key={i} className="ref" title="Belegstelle im Volltext öffnen" onClick={() => onSource(n, q)}>[{n}]</button>;
    });
  }

  return (
    <div className="md">
      {slides.map((s) => {
        const fl = s.bullets.map((_, i) => find(s.n, i + 1)).filter(Boolean);
        const bad = fl.filter((f) => f.status === 'contradicted').length;
        const warn = fl.filter((f) => f.status === 'unsupported').length;
        return (
          <div key={s.n} className="slide">
            <h3>
              {s.title}
              {findings && fl.length > 0 && (bad ? <span className="cb bad">⚠ {bad} Widerspruch</span> : warn ? <span className="cb warn">? {warn} nicht belegt</span> : <span className="cb ok">✓ belegt</span>)}
            </h3>
            <ul>
              {s.bullets.map((b, i) => {
                const f = find(s.n, i + 1);
                const st = f?.status;
                return (
                  <li key={i} className={st && st !== 'general' ? `f-${st}` : ''}>
                    <span>{renderRefs(b, f)}</span>
                    {f && (st === 'unsupported' || st === 'contradicted') && (
                      <div className="finding">
                        <b>{label[st]}:</b> {f.note}
                        {f.source && <button type="button" className="ghost small" onClick={() => onSource(f.source, f.quote)}>{f.quote ? 'Stelle im Volltext zeigen' : `Quelle [${f.source}] öffnen`}</button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Volltext-Panel mit Sprung zur Belegstelle
// ---------------------------------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

function FullTextDrawer({ paper, quote, index, onClose }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(0);
  const bodyRef = useRef();

  useEffect(() => {
    setText('');
    fetch(`/api/papers/${paper.id}/fulltext`).then((r) => r.json()).then((d) => setText(d.text || '')).catch(() => setText('Volltext konnte nicht geladen werden.'));
  }, [paper.id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Absätze; Belegstelle (quote) bzw. Suche (q) markieren
  const paras = useMemo(() => text.split(/\n\n+/).filter(Boolean), [text]);
  const target = useMemo(() => {
    if (!quote || !paras.length) return -1;
    const nq = norm(quote);
    let i = paras.findIndex((p) => norm(p).includes(nq));
    if (i === -1) { const head = nq.split(' ').slice(0, 6).join(' '); i = paras.findIndex((p) => norm(p).includes(head)); }
    if (i === -1) { const words = nq.split(' ').filter((w) => w.length > 4); let best = -1, score = 0; paras.forEach((p, k) => { const np = norm(p); const s = words.filter((w) => np.includes(w)).length; if (s > score && s >= Math.max(3, words.length * 0.5)) { score = s; best = k; } }); i = best; }
    return i;
  }, [quote, paras]);

  useEffect(() => {
    if (target < 0 || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(`[data-i="${target}"]`);
    if (el) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  }, [target, paras]);

  useEffect(() => {
    if (!q || !bodyRef.current) return setHits(0);
    const n = paras.filter((p) => p.toLowerCase().includes(q.toLowerCase())).length;
    setHits(n);
    const el = bodyRef.current.querySelector('mark.hit');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [q, paras]);

  function mark(p, i) {
    if (i === target && quote) {
      const m = p.match(new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      if (m) { const k = m.index; return <>{p.slice(0, k)}<mark className="proof">{p.slice(k, k + m[0].length)}</mark>{p.slice(k + m[0].length)}</>; }
      return <mark className="proof soft">{p}</mark>;
    }
    if (q) {
      const parts = p.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
      return parts.map((x, k) => (x.toLowerCase() === q.toLowerCase() ? <mark key={k} className="hit">{x}</mark> : x));
    }
    return p;
  }

  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <span className="tag">Quelle [{index}]</span>
            <h2>{paper.title}</h2>
            <p className="muted">{paper.authors} · {paper.journal} · {paper.date} · <a href={paper.fulltextUrl} target="_blank" rel="noreferrer">PMC ↗</a></p>
          </div>
          <button type="button" className="ghost small" onClick={onClose}>Schließen ✕</button>
        </header>
        {quote && (
          <div className={`proofbox ${target < 0 ? 'missing' : ''}`}>
            {target >= 0 ? <><b>Belegstelle:</b> „{quote}"</> : <><b>Zitat nicht wörtlich gefunden:</b> „{quote}" – bitte Volltext prüfen.</>}
          </div>
        )}
        <div className="row find">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Im Volltext suchen…" />
          {q && <span className="muted">{hits} Absätze</span>}
        </div>
        <div className="fulltext" ref={bodyRef}>
          {!text && <p className="muted">Volltext wird geladen…</p>}
          {paras.map((p, i) =>
            p.startsWith('## ') ? <h4 key={i} data-i={i}>{p.slice(3)}</h4> : <p key={i} data-i={i} className={i === target ? 'target' : ''}>{mark(p, i)}</p>
          )}
        </div>
      </aside>
    </div>
  );
}
// ---------------------------------------------------------------------------
//  Folienplan-Vorschau (Schritt 4): Layouts, Abbildungen, Befunde
// ---------------------------------------------------------------------------
const LAYOUT_LABEL = {
  title: 'Titel', section: 'Kapitel', bullets: 'Aussagen', two_column: 'Gegenüberstellung',
  stat: 'Kennzahlen', timeline: 'Ablauf', figure: 'Original-Abbildung', chart: 'Diagramm',
  quote: 'Zitat', takeaways: 'Take-Home',
};

function DeckPreview({ deck, findings, onSource, onBuild, busy, onBack }) {
  const f = findings || [];
  const bad = f.filter((x) => x.status === 'contradicted').length;
  const warn = f.filter((x) => x.status === 'unsupported').length;
  const ok = f.filter((x) => x.status === 'ok').length;
  const find = (s, b) => f.find((x) => x.slide === s && x.bullet === b);

  return (
    <>
      <div className={`checkbar ${bad ? 'bad' : warn ? 'warn' : 'ok'}`}>
        <div className="ctext">
          <b>Folienplan geprüft:</b> {ok}/{ok + warn + bad} belegt
          {warn > 0 && <span className="cb warn">{warn} nicht belegt</span>}
          {bad > 0 && <span className="cb bad">{bad} Widerspruch</span>}
          {!warn && !bad && <span className="cb ok">keine Auffälligkeiten</span>}
          <small>Claude Opus 5 · Layout und Formulierung</small>
        </div>
        <div className="cactions">
          <button type="button" className="ghost small" onClick={onBack}>← Outline anpassen</button>
          <button type="button" className="small" disabled={busy} onClick={onBuild}>{busy ? 'Baut…' : '⬇ PowerPoint herunterladen'}</button>
        </div>
      </div>

      <div className="deckgrid">
        {(deck.slides || []).map((s, i) => {
          const fl = s.bullets ? [] : [];
          const slideFindings = f.filter((x) => x.slide === i + 1 && ['unsupported', 'contradicted'].includes(x.status));
          return (
            <article key={i} className={`slidecard l-${s.layout} ${slideFindings.length ? (slideFindings.some((x) => x.status === 'contradicted') ? 'has-bad' : 'has-warn') : ''}`}>
              <div className="slidehead">
                <span className="num">{i + 1}</span>
                <span className="layout">{LAYOUT_LABEL[s.layout] || s.layout}</span>
                {s.sources && <span className="srcs">{String(s.sources).split(/[,\s]+/).filter(Boolean).map((t, k) => {
                  const n = Number(t.replace(/\D/g, ''));
                  return n ? <button key={k} type="button" className="ref" onClick={() => onSource(n, '')}>[{n}]</button> : null;
                })}</span>}
              </div>
              <h4>{s.title}</h4>
              <SlideBody s={s} />
              {slideFindings.length > 0 && (
                <div className="slidefindings">
                  {slideFindings.map((x, k) => (
                    <div key={k} className={`finding f-${x.status}`}>
                      <b>{x.status === 'contradicted' ? 'Widerspruch' : 'nicht belegt'}:</b> {x.note}
                      {x.source ? <button type="button" className="ghost small" onClick={() => onSource(x.source, x.quote)}>Belegstelle</button> : null}
                    </div>
                  ))}
                </div>
              )}
              {s.notes && <details className="notes"><summary>Sprechernotizen</summary><p>{s.notes}</p></details>}
            </article>
          );
        })}
      </div>
    </>
  );
}

function SlideBody({ s }) {
  switch (s.layout) {
    case 'title':
    case 'section':
      return <p className="sub">{s.subtitle}</p>;
    case 'two_column':
      return (
        <div className="mini2">
          {[s.left, s.right].filter(Boolean).map((c, k) => (
            <div key={k}><b>{c.heading}</b><ul>{(c.bullets || []).map((b, j) => <li key={j}>{b}</li>)}</ul></div>
          ))}
        </div>
      );
    case 'stat':
      return (
        <>
          <div className="ministats">{(s.stats || []).map((st, k) => <div key={k}><span>{st.value}</span><small>{st.label}</small></div>)}</div>
          {s.note && <p className="sub">{s.note}</p>}
        </>
      );
    case 'timeline':
      return <ol className="minitl">{(s.steps || []).map((st, k) => <li key={k}><b>{st.label}</b> {st.text}</li>)}</ol>;
    case 'figure':
      return (
        <div className="minifig">
          {s.figureMeta && <img src={s.figureMeta.url} alt={s.figureMeta.label} loading="lazy" />}
          <div>
            <ul>{(s.bullets || []).map((b, k) => <li key={k}>{b}</li>)}</ul>
            <p className="cap">{s.figureMeta?.label} aus Quelle [{s.figureMeta?.paperIndex}]{s.caption ? ': ' + s.caption : ''}</p>
          </div>
        </div>
      );
    case 'chart':
      return (
        <div className="minichart">
          <MiniChart chart={s.chart} />
          <p className="sub">{s.insight}</p>
        </div>
      );
    case 'quote':
      return <blockquote>„{s.quote}" <cite>— {s.attribution}</cite></blockquote>;
    case 'takeaways':
      return <ol className="minitake">{(s.items || []).map((it, k) => <li key={k}>{it}</li>)}</ol>;
    default:
      return <ul>{(s.bullets || []).map((b, k) => <li key={k}>{b}</li>)}</ul>;
  }
}

// Kleines SVG-Vorschaudiagramm (Balken/Linie/Kreis)
function MiniChart({ chart }) {
  if (!chart || !(chart.series || []).length) return null;
  const cats = chart.categories || [];
  const series = chart.series.slice(0, 3);
  const all = series.flatMap((s) => (s.values || []).map(Number)).filter((n) => !isNaN(n));
  const max = Math.max(...all, 0) || 1;
  const COLORS = ['#0a6cff', '#0e9f8a', '#f59e0b'];
  const W = 300, H = 120, pad = 18;
  if (chart.type === 'pie') {
    const vals = (series[0].values || []).map(Number);
    const sum = vals.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return (
      <svg viewBox="0 0 120 120" className="chartsvg pie">
        {vals.map((v, i) => {
          const a0 = (acc / sum) * 2 * Math.PI - Math.PI / 2; acc += v;
          const a1 = (acc / sum) * 2 * Math.PI - Math.PI / 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = `M60,60 L${60 + 55 * Math.cos(a0)},${60 + 55 * Math.sin(a0)} A55,55 0 ${large} 1 ${60 + 55 * Math.cos(a1)},${60 + 55 * Math.sin(a1)} Z`;
          return <path key={i} d={p} fill={COLORS[i % 3]} opacity={0.85} />;
        })}
      </svg>
    );
  }
  const bw = (W - pad * 2) / Math.max(cats.length, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chartsvg">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#e2e8f0" />
      {series.map((s, si) =>
        chart.type === 'line' ? (
          <polyline key={si} fill="none" stroke={COLORS[si % 3]} strokeWidth="2"
            points={(s.values || []).map((v, i) => `${pad + bw * i + bw / 2},${H - pad - (Number(v) / max) * (H - pad * 2)}`).join(' ')} />
        ) : (
          (s.values || []).map((v, i) => {
            const w = (bw * 0.7) / series.length;
            const h = (Number(v) / max) * (H - pad * 2);
            return <rect key={si + '-' + i} x={pad + bw * i + bw * 0.15 + si * w} y={H - pad - h} width={w} height={Math.max(h, 1)} fill={COLORS[si % 3]} rx="2" />;
          })
        )
      )}
      {cats.map((c, i) => <text key={i} x={pad + bw * i + bw / 2} y={H - 5} fontSize="7" textAnchor="middle" fill="#5b6675">{String(c).slice(0, 12)}</text>)}
    </svg>
  );
}
