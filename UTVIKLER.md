# IDS Regelsjekker — Utviklerdokumentasjon

> Teknisk referanse for utviklere som skal jobbe med kodebasen.  
> Sist oppdatert: juni 2026

---

## Mappestruktur

```
ids-checker/
├── backend/
│   ├── Dockerfile              (Railway-bygg)
│   ├── main.py                 (FastAPI-app, API-endepunkter)
│   ├── checker.py              (IDS-valideringslogikk — brukes som fallback)
│   ├── updater.py              (IFC-egenskapsoppdatering + TC-opplasting)
│   ├── requirements.txt
│   └── ids/                    (IDS-regelfilbibliotek servert via API)
│       ├── Fagmodell veg - MMI 400.ids
│       └── fagmodell_rekkvek.ids
└── frontend/
    ├── package.json
    ├── src/
    │   ├── App.jsx             (Hele React-appen, ~2800 linjer)
    │   └── index.jsx           (React DOM-oppstart)
    └── public/
        ├── index.html          (HTML-mal, <link rel="icon">)
        ├── manifest.json       (TC Extension-manifest)
        ├── pyodide-worker.js   (Web Worker med Python-kode embedded)
        └── icon.svg            (Trimble Gray #252a2e)
```

---

## Lokalt oppsett

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Sjekk at det kjører: `http://localhost:8000/health`

### Frontend

```bash
cd frontend
npm install
# Sett backend-URL lokalt:
echo "REACT_APP_API_URL=http://localhost:8000" > .env.local
npm start
```

Frontenden åpnes på `http://localhost:3000`.

**Merk:** TC Workspace API (`trimble-connect-workspace-api`) fungerer bare inni Trimble Connects iframe. Ved lokal utvikling uten TC-kontekst vil TC-spesifikke funksjoner (3D-marking, To-Do, BCF) feile stille — resten av appen fungerer normalt.

---

## Nøkkelfiler i detalj

### `frontend/public/pyodide-worker.js`

**Dette er den viktigste filen.** IDS-validering kjøres **ikke** via backenden — den kjøres i denne Web Workeren ved hjelp av Pyodide (Python i WebAssembly).

Filen har tre deler:

**1. Initialisering (`type: "load"`)**
- Laster Pyodide v0.28.3 fra CDN
- Installerer Python-pakker: `numpy`, `micropip`, `ifcopenshell`, `ifctester`, `elementpath`, `xmlschema`
- Registrerer IFC4X3_ADD2-skjema

**2. `VALIDATE_PY` — strengkonstant med Python-kode (linje ~22–368)**
- Meldingstype: `type: "validate"`, payload: `{ifcBytes, idsText}`
- Åpner IFC med `ifcopenshell`, validerer mot IDS med `ifctester`
- Bygger JSON-resultater med spec/requirement/failure-hierarki
- Legger til **tre tilpassede valideringer** etter IDS-loopen:
  - "Mangler egenskapssett Objektdata" — `IfcElement` uten `Objektdata`-pset
  - "Mangler Objekttype i Objektdata" — har `Objektdata` men `Objekttype` er tom
  - "Inneholder ikke Prosessdata" — `IfcElement` uten `Prosessdata`-pset
- Hopper over: `IfcOpeningElement`, `IfcVoidingFeature`, `IfcSurfaceFeature`, `IfcProjectionElement`
- Ekskluderte IFC-typer (har ikke GlobalId): `IfcPresentationLayerAssignment`

**3. `UPDATE_PY` — strengkonstant med Python-kode (linje ~370–434)**
- Meldingstype: `type: "update_properties"`, payload: `{requirements, guids}`
- Leser IFC fra Pyodide-filsystemet (`/model.ifc`)
- For hver GUID: setter egenskapsverdier med korrekt IFC-datatype
- Støttede IFC-datatyper: `IfcLabel`, `IfcText`, `IfcIdentifier`, `IfcReal`, `IfcInteger`, `IfcBoolean`, `IfcLengthMeasure`, `IfcAreaMeasure`, `IfcVolumeMeasure`
- Skriver resultat til `/model_korrigert.ifc`

**Meldingsprotokoll (Worker ↔ App.jsx):**

| Innkommende `type` | Hva workeren gjør |
|---|---|
| `"load"` | Initialiserer Pyodide |
| `"validate"` | Kjører VALIDATE_PY |
| `"update_properties"` | Kjører UPDATE_PY |
| `"run_python"` | Kjører vilkårlig Python (brukes av PropertyEditorPage) |
| `"fs_read"` | Leser fil fra Pyodide-filsystemet |

| Utgående `type` | Innhold |
|---|---|
| `"ready"` | Pyodide initialisert |
| `"step"` | Fremdriftsmelding (string) |
| `"validate_result"` | `{summary, specifications}` JSON |
| `"update_result"` | `{updated_count}` |
| `"error"` | `{message}` |

---

### `frontend/src/App.jsx`

Hele React-appen i én fil (~2800 linjer). Ingen state management-bibliotek — all state er `useState`/`useEffect` i rotkomponenten.

**Viktige hooks og funksjoner:**

| Funksjon | Linje ca. | Beskrivelse |
|---|---|---|
| `usePyodide()` | ~80 | Hook som wrapper Worker-kommunikasjon |
| `connectToTC()` | ~147 | Initialiserer TC Workspace API, henter token |
| `handleValidate()` | ~400 | Sender IFC+IDS til Worker, håndterer resultat |
| `handleUpdateProperties()` | ~600 | Sender egenskapsrettinger til Worker |
| `uploadFileToTC()` | ~750 | Laster opp IFC til TC via backend |
| `createTodos()` | ~900 | Kaller backend `/create-todos` |
| `createTopics()` | ~1000 | Kaller backend `/create-topics` |

**UI-sider (rendres betinget basert på state):**

| Side | Betingelse | Beskrivelse |
|---|---|---|
| Upload | `!results` | Filvalg, IDS-valg, start-knapp |
| Validering pågår | `loading` | Spinner med fremdriftsmelding |
| Resultater | `results && !editMode` | Spec-liste, pass/fail, objekt-detaljer |
| PropertyEditor | `editMode` | Skjema for å rette IFC-egenskaper |

**Trimble Modus fargepalett (inline CSS):**
```js
const M = {
  blue:  '#0063a3',
  red:   '#da212c',
  green: '#1e8a44',
  gray:  '#252a2e',  // Trimble Gray (ikonet)
  // ...
}
```

---

### `backend/main.py`

FastAPI-app med følgende endepunkter:

```
GET  /health
GET  /ids-files                          → liste over .ids-filer i backend/ids/
GET  /ids-files/{filename}               → last ned en IDS-fil
POST /validate                           → IDS-validering (fallback fra Pyodide)
POST /update-properties                  → endre IFC-egenskaper + evt. TC-opplasting
GET  /project-members                    → hente TC-prosjektmedlemmer
POST /create-todos                       → opprette TC To-Do med objektlenker
POST /create-topics                      → opprette BCF-topics med objektlenker
```

**`POST /validate`** (brukes sjelden — Pyodide er primær)
- Form-felter: `ids_file` (upload), `ifc_file` (upload)
- Kaller `checker.py:run_ids_check()`
- Returnerer samme JSON-format som Pyodide-workeren

**`POST /update-properties`**
- Form-felter: `requirements` (JSON-string), `guids` (JSON-string), `output_filename`
- Valgfritt: `upload_to_project=true` + TC-credentials (`tc_token`, `tc_project_id`, `tc_region`)
- Kaller `updater.py:update_multiple_properties()`
- Returnerer: `FileResponse` (nedlasting) eller `{tc_file: {...}}` (TC-opplasting)

**TC API-proxy-kall:**  
Frontenden kan ikke kalle TC API direkte (CORS). Backenden bruker `httpx` som async proxy.

**CORS-konfigurasjon (må ikke endres uten grunn):**
```python
allow_origins=[
    "https://ids-checker.vercel.app",
    "https://*.vercel.app",
    "null",   # TC extension iframe sender Origin: null
]
```

---

### `backend/checker.py`

Brukes som fallback hvis Pyodide-workeren feiler. Inneholder samme logikk som `VALIDATE_PY` i workeren, men i ren Python.

Viktig: **Denne filen er ikke primær valideringskode.** Primærkoden er `VALIDATE_PY`-strengen i `pyodide-worker.js`. Hvis du endrer valideringslogikk, sjekk om endringen skal gjøres begge steder.

Nøkkelfunksjoner:
- `run_ids_check(ifc_path, ids_path) → dict`
- `_extract_requirements(spec)` — parser krav fra IDS-spesifikasjon
- `_req_failing(req, ifc_model)` — finner IFC-entiteter som feiler på et krav

---

### `backend/updater.py`

- `update_multiple_properties(ifc_path, requirements, guids, output_path)` — setter egenskaper for flere GUIDer i én IFC-fil
- `upload_to_tc(file_path, tc_token, project_id, region, parent_id, filename)` — to-stegs TC-opplasting:
  1. `POST /files` → får `{id, uploadUrl}`
  2. `PUT uploadUrl` med filinnhold

---

### `frontend/public/manifest.json`

TC Extension-manifest. Viktige felter:

```json
{
  "title": "IDS Regelsjekker",
  "url": "https://ids-checker.vercel.app",
  "icon": "https://ids-checker.vercel.app/icon.svg",
  "enabled": true
}
```

`enabled: true` betyr at utvidelsen aktiveres automatisk for alle prosjektmedlemmer som har den installert.

---

## Resultatsformat (JSON)

Både Pyodide-workeren og backend-API-et returnerer samme format:

```json
{
  "summary": {
    "passed": 3,
    "failed": 2,
    "total": 5
  },
  "specifications": [
    {
      "name": "Vegkonstruksjon — MMI 400",
      "status": "failed",
      "passed": 12,
      "failed": 4,
      "applicability_detail": "IfcWall / Objekttype: Vegkonstruksjon",
      "requirements": [
        {
          "name": "Har egenskap Høydekote",
          "status": "failed",
          "krav_tekst": "Skal inneholde egenskapen Høydekote",
          "failing": [
            {
              "guid": "3Bx...",
              "name": "Vegkonstruksjon-001",
              "ifc_type": "IfcWall"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Fjernede funksjoner

### "Oppdater egenskaper"-knappen (juni 2026)

Knappen som dukket opp på mislykkede spesifikasjoner i valideringsresultatene er fjernet (kodsnutten er slettet fra `SpecCard`-komponenten, ~linje 1323). Resten av `PropertyEditor`-komponenten og tilhørende logikk i `App.jsx` er beholdt.

Var plassert i `SpecCard`-komponenten, betinget på `!passed && hasEditableReqs`. Åpnet `PropertyEditor`-komponenten via `onEditProps(spec)`-callback og `editingSpec`-state.

---

### "Last ned fra TC"-siden (juni 2026)

Hele siden er slettet. Gjenskapelsesinstruksjoner:

**Kom i gang:**
Legg til et kort i `HomePage.cards`-arrayet med `id: "download"`, og håndter ruten i `IDSChecker`-funksjonen med `if (page === "download") { return <DownloadPage .../>; }`.

**State i komponenten:**
```js
const [items, setItems] = useState([]);
const [loading, setLoading] = useState(false);
const [path, setPath] = useState([]);          // breadcrumb: [{ id, name }, ...]
const [downloading, setDownloading] = useState(null);  // item.id under nedlasting
```

**Finn startmappe (root):**
1. Hent loadede modeller: `tc.api.viewer.getModels("loaded")`
2. Slå opp filversjoner for første modell: `GET /tc/api/2.1/projects/{projectId}/{fileId}/versions`
3. Trekk ut `items[0].parentId` — dette er mappen modellen ligger i
4. Last mappeinnhold med `loadFolder(parentId, ...)`

**Last inn mappeinnhold:**
```
GET https://{host}/tc/api/2.1/folders/{folderId}/items?tokenThumburl=false&sort=+name
Authorization: Bearer {token}
```
Svar har `data.list` eller `data.items` (array med `{id, name, type}` — `type === "FOLDER"` eller fil).

**Last ned en fil:**
```
GET https://{host}/tc/api/2.0/files/fs/{fileId}/downloadurl
Authorization: Bearer {token}
```
Svar: `{ url: "signert nedlastings-URL" }`. Trigger nedlasting med:
```js
const a = document.createElement("a"); a.href = dlUrl; a.download = item.name; a.click();
```

**Host-valg:** `project.location === "europe"` → `app21.connect.trimble.com`, ellers `app.connect.trimble.com`.

**Breadcrumb-navigasjon:**
- `path`-arrayet bygges opp etter hvert som bruker navigerer inn i mapper
- Klikk på et steg i breadcrumben: pop path til det indekset og kall `loadFolder` på nytt

---

## Legge til en ny IDS-regel

1. Plasser `.ids`-filen i `backend/ids/`
2. Committ filen
3. Deploy backend (Railway bygger automatisk ved push til main)
4. Filen dukker opp i dropdownen i appen via `GET /ids-files`

---

## Deploy

### Frontend (Vercel)
- Root directory: `frontend/`
- Build command: `npm run build`
- Output directory: `build/`
- Environment variable: `REACT_APP_API_URL=https://ids-checker-api.railway.app`
- Push til `main` → automatisk deploy

### Backend (Railway)
- Root directory: `backend/`
- Bygger med `Dockerfile`
- Start-kommando: `uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}`
- Python 3.11-slim + libgomp1 (kreves av ifcopenshell)
- Push til `main` → automatisk deploy

---

## Vanlige fallgruver

**"Validering fungerer ikke — endret checker.py men ingenting skjer"**  
Validering kjøres i `pyodide-worker.js:VALIDATE_PY`, ikke i `checker.py`. Endre riktig fil.

**"TC-funksjoner feiler lokalt"**  
TC Workspace API krever at appen kjøres inni TC-iframe. Lokal utvikling uten TC gir `window.parent.tc` = undefined — dette er forventet.

**"Pyodide laster ikke"**  
Første oppstart laster ~200–400 MB fra CDN (jsDelivr). Etter første last er det cachet. Sjekk nettleserkonsollen for CORS- eller nettverksfeil.

**"IFC-type mangler GlobalId → TypeError"**  
`VALIDATE_PY` har en ekskluderingsliste (`_EXCLUDED_IFC_TYPES`) for IFC-entiteter uten GlobalId. Legg til typen der hvis den dukker opp i feil.

**"Token er 'pending' — TC-kall feiler"**  
Kjent bug i `App.jsx:147`. Token fra TC er asynkront og kan komme etter at appen allerede prøver å bruke det. Token refresh håndteres heller ikke — utvidelsen må eventuelt lastes på nytt.

---

## Teknisk gjeld (prioritert)

| Prioritet | Beskrivelse | Fil |
|---|---|---|
| Høy | Token refresh ikke håndtert | `App.jsx:147` |
| Middels | `trimble-connect-workspace-api` versjon upinnet (`"*"`) | `package.json:9` |
| Lav | Migrere fra Create React App til Vite | `package.json` |
| Lav | App.jsx er for stor — bør splittes i komponenter | `src/App.jsx` |

---

## Teknologier og versjoner

| Teknologi | Versjon | Formål |
|---|---|---|
| React | 18.3.0 | UI-rammeverk |
| react-scripts (CRA) | 5.0.1 | Byggesystem |
| trimble-connect-workspace-api | `*` (upinnet) | TC 3D-visningsintegrasjon |
| Pyodide | 0.28.3 | Python i WebAssembly (CDN) |
| ifcopenshell | 0.8.5 (Pyodide) / 0.8.0 (backend) | IFC-parsing |
| ifctester | 0.8.5 (Pyodide) / 0.8.0 (backend) | IDS-validering |
| FastAPI | 0.115.0 | Backend API-rammeverk |
| httpx | 0.27.0 | Async HTTP-klient (TC API-proxy) |
| Python | 3.11 | Backend-kjøretid |
