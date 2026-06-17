# IDS Regelsjekker – Trimble Connect Extension

Valider IFC-modeller mot IDS-regelsett (buildingSMART IDS 1.0) direkte i Trimble Connect. Valideringslogikken kjøres i nettleseren via Pyodide (Python i WebAssembly) — ingen IFC-filer sendes til server.

---

## Mappestruktur

```
ids-checker/
├── backend/                  Python API (FastAPI)
│   ├── main.py               API-endepunkter
│   ├── checker.py            IDS-valideringslogikk (fallback)
│   ├── updater.py            IFC-egenskapsoppdatering og TC-opplasting
│   ├── requirements.txt
│   ├── Dockerfile
│   └── ids/                  IDS-regelfiler som serveres via API
└── frontend/                 React-app (Trimble Connect Extension)
    ├── src/App.jsx            Hele React-appen
    └── public/
        ├── pyodide-worker.js  Web Worker – kjører Python-validering i nettleseren
        └── manifest.json      TC Extension-manifest
```

---

## Funksjonalitet

- **IDS Validering** — valider IFC-modell mot IDS-regelsett, se resultater per spesifikasjon og objekt, marker feilede objekter i TC 3D-viewer
- **BCF Topics og To-Do** — opprett saker i TC direkte fra valideringsresultater, tildel til prosjektmedlemmer
- **Property Editor** — rediger IFC-egenskaper og last opp korrigert modell til TC

---

## Lokalt oppsett

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
# API kjører på http://localhost:8000
```

### Frontend
```bash
cd frontend
npm install
echo "REACT_APP_API_URL=http://localhost:8000" > .env.local
npm start
# Appen kjører på http://localhost:3000
```

TC Workspace API (markering, BCF, prosjektmedlemmer) fungerer kun inni TC-iframe. Valideringsflyten fungerer uten TC-tilkobling.

---

## Deploy

### Backend → Railway
1. "New Project" → "Deploy from GitHub repo"
2. Sett root directory til `backend/`
3. Railway oppdager Dockerfile automatisk
4. Kopier den genererte URL-en

### Frontend → Vercel
1. "New Project" → importer GitHub-repo
2. Sett root directory til `frontend/`
3. Legg til environment variable: `REACT_APP_API_URL` = Railway-URL
4. Deploy

### Trimble Connect
Extensionen lastes inn via manifest-URL. Manifest ligger på `{frontend-url}/manifest.json` etter deploy.

---

## Avhengigheter

| Pakke | Versjon | Formål |
|---|---|---|
| FastAPI | 0.115.0 | Backend API |
| IfcOpenShell | 0.8.0 (backend) / 0.8.5 (Pyodide) | IFC-parsing |
| IfcTester | 0.8.0 (backend) / 0.8.5 (Pyodide) | IDS-validering |
| Pyodide | 0.28.3 | Python i WebAssembly (CDN) |
| React | 18.3.0 | Frontend |
| trimble-connect-workspace-api | * | TC 3D-viewer integrasjon |
