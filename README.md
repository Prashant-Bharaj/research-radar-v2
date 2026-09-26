# Research Radar — Belege und Foliensatz

Prototyp aus dem Mini-Hackathon beim Ophthalmologen-Kongress (25.–26.09.2026).

Recherche-Werkzeug für ophthalmologische Update-Referate: PubMed-Suche, Volltext-Belege
mit Sprung zur Belegstelle, KI-gestützte Gliederung und eine fertige PPTX-Datei.
Jede Aussage bleibt gegen den Volltext überprüfbar.

> Parallel dazu gibt es eine anders ausgerichtete Fassung:
> [research-radar-v1](https://github.com/NiclasBayer/research-radar-v1) — dort steht
> das Sammeln in einem Datenpool im Vordergrund statt der Volltext-Belege.

## Aufbau

- `frontend/` — React + Vite
- `backend/` — Express: PubMed (NCBI E-utilities), LLM über myGenAssist, PPTX via pptxgenjs

Im Betrieb ist es **ein Dienst**: Express liefert die API und das gebaute Frontend aus.

## Lokal starten

```bash
npm install --prefix backend
npm install --prefix frontend
# Key bereitstellen (wird nur serverseitig gelesen, nie ans Frontend gegeben):
echo "MGA_API_KEY=..." > backend/.env
npm start --prefix backend        # Backend auf :3000
npm run dev --prefix frontend     # Frontend auf :8080
```

## Konfiguration

Alle Werte kommen aus der Umgebung — **im Repo steht kein Schlüssel**.

| Variable | Zweck |
|---|---|
| `MGA_API_KEY` | Zugang zum LLM-Gateway. Ohne ihn laufen Suche und Volltext, die KI-Schritte antworten mit 503. |
| `APP_PASSWORD` | Schützt die öffentlich erreichbare Instanz per Passwortabfrage. Nicht gesetzt = kein Schutz (nur lokal sinnvoll). |
| `MGA_MODEL` | Modell-ID, Vorgabe `claude-opus-5`. |
| `PORT` | Vom Hoster gesetzt, lokal 3000. |

Alle Beispieldaten sind synthetisch — keine echten Patientendaten.
