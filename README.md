# IDS Regelsjekker – Trimble Connect Extension

Valider IFC-filer mot IDS-regelsett (buildingSMART IDS 1.0) direkte i Trimble Connect.

---

## Mappestruktur

```
ids-checker/
├── backend/          Python API (FastAPI + IfcOpenShell)
├── frontend/         React app (Trimble Connect Extension)
└── manifest.json     TC Extension manifest
```

---

## Steg 1 – Sett opp lokalt

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
# Lag .env.local med:
echo "REACT_APP_API_URL=http://localhost:8000" > .env.local
npm start
# Appen kjører på http://localhost:3000
```

---

## Steg 2 – Deploy til produksjon

### Backend → Railway
1. Lag konto på https://railway.app
2. "New Project" → "Deploy from GitHub repo"
3. Velg `backend/`-mappen som root directory
4. Railway oppdager Dockerfile automatisk
5. Kopier den genererte URL-en (f.eks. `https://ids-checker-api.railway.app`)

### Frontend → Vercel
1. Lag konto på https://vercel.com
2. "New Project" → importer GitHub repo
3. Sett root directory til `frontend/`
4. Legg til environment variable:
   - `REACT_APP_API_URL` = Railway-URL fra forrige steg
5. Deploy – Vercel gir deg en URL (f.eks. `https://ids-checker.vercel.app`)

---

## Steg 3 – Registrer i Trimble Connect

1. Oppdater `manifest.json` med din Vercel-URL
2. Legg manifest.json på en offentlig URL (kan ligge i `frontend/public/manifest.json` → blir tilgjengelig på `https://ids-checker.vercel.app/manifest.json`)
3. Åpne TC-prosjektet i nettleseren
4. Gå til **Settings → Extensions**
5. Lim inn manifest-URL-en
6. Extensionen dukker opp i venstremenyen 🎉

---

## Bruk

1. Velg IFC-fil fra prosjektet
2. Velg IDS-regelsett (fra prosjektet eller last opp)
3. Klikk "Kjør IDS-sjekk"
4. Se resultater – klikk på feilede regler for å se hvilke objekter som feiler

---

## Avhengigheter

| Pakke | Versjon | Lisens |
|---|---|---|
| FastAPI | 0.115 | MIT |
| IfcOpenShell | 0.8.0 | LGPL-3.0 |
| IfcTester | 0.8.0 | LGPL-3.0 |
| React | 18 | MIT |
| trimble-connect-workspace-api | 1.x | Trimble |
