# IDS Regelsjekker — IT-arkitektur

> Dokumentasjon for IT-arkitekt og systemansvarlig.  
> Sist oppdatert: juni 2026

---

## Hva er dette?

**IDS Regelsjekker** er et nettbasert verktøy som validerer BIM-modeller (bygningsinformasjonsmodeller i IFC-format) mot regelbaserte kvalitetskrav definert i IDS-formatet (Information Delivery Specification, buildingSMART).

Verktøyet er bygget som en **Trimble Connect 3D Extension** — en nettapp som kjøres innebygd i Trimble Connects nettklient og samhandler direkte med 3D-visningsprogrammet og TC-prosjektene.

### Typisk bruksflyt

1. Bruker åpner en IFC-modell i Trimble Connect
2. Åpner IDS Regelsjekker-utvidelsen (innbygd i TC-grensesnittet)
3. Velger et IDS-regelsett (lokalt eller fra server)
4. Verktøyet sjekker modellen mot reglene direkte i nettleseren
5. Resultater vises med objektnivå-detaljer og linking til 3D-visning
6. Bruker kan rette feil direkte, laste opp korrigert modell til TC, og opprette oppgaver (To-Do/BCF) i TC

---

## Systemarkitektur

```
┌────────────────────────────────────────────────────────────────────┐
│  Sluttbruker (nettleser, Trimble Connect)                          │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  TC Extension iframe — https://ids-checker.vercel.app       │  │
│  │                                                             │  │
│  │  ┌──────────────────┐    ┌──────────────────────────────┐  │  │
│  │  │  React-app       │◄──►│  Pyodide Web Worker          │  │  │
│  │  │  (App.jsx)       │    │  (pyodide-worker.js)         │  │  │
│  │  │                  │    │  Python-kode i WebAssembly   │  │  │
│  │  │  - UI-sider      │    │  - IDS-validering            │  │  │
│  │  │  - TC API-kall   │    │  - IFC-filmanipulering       │  │  │
│  │  │  - Filhåndtering │    │  - Kjøres off main thread    │  │  │
│  │  └────────┬─────────┘    └──────────────────────────────┘  │  │
│  └───────────┼─────────────────────────────────────────────────┘  │
└──────────────┼─────────────────────────────────────────────────────┘
               │ HTTPS
               │
               │  ┌──────────────────────────────────┐
               ├─►│  Backend API (Railway)            │
               │  │  https://ids-checker-api.railway.app│
               │  │  FastAPI / Python                 │
               │  │  - BCF-opprettelse                │
               │  │  - To-Do-opprettelse              │
               │  │  - TC-fillasting                  │
               │  │  - IDS-filer (bibliotek)          │
               │  └──────────────────────────────────┘
               │
               │  ┌──────────────────────────────────┐
               └─►│  Trimble Connect API             │
                  │  app.eu.connect.trimble.com       │
                  │  - Prosjektdata                   │
                  │  - Filoppasting                   │
                  │  - To-Do / BCF-opprettelse        │
                  └──────────────────────────────────┘
```

---

## Komponenter

### Frontend — Vercel

| Egenskap | Verdi |
|---|---|
| URL | https://ids-checker.vercel.app |
| Teknologi | React 18, JavaScript |
| Byggesystem | Create React App (react-scripts) |
| Hosting | Vercel (statisk hosting, gratis tier) |

**Frontenden gjør det tunge arbeidet.** IDS-validering kjøres helt i nettleseren ved hjelp av Pyodide — Python kompilert til WebAssembly. Ingen IFC-filer sendes til en server for validering (med mindre brukeren eksplisitt velger å laste opp til TC).

### Backend — Railway

| Egenskap | Verdi |
|---|---|
| URL | https://ids-checker-api.railway.app |
| Teknologi | Python 3.11, FastAPI |
| Hosting | Railway (containerbasert, Docker) |

**Backenden brukes ikke til selve valideringen.** Den er ansvarlig for:
- Proxy-kall til Trimble Connect API (opprette To-Do, BCF-topics, hente prosjektmedlemmer)
- Å servere ferdige IDS-regelfilbibliotek
- Fallback-validering hvis Pyodide feiler (sjeldent)

### Pyodide Web Worker (kjøres i nettleseren)

Pyodide er Python-kjøretidsmiljøet i WebAssembly. Appen laster ned Python-pakker fra CDN og kjører valideringslogikken lokalt i brukerens nettleser — ingen data forlater klienten under validering.

| Pakke | Versjon | Formål |
|---|---|---|
| ifcopenshell | 0.8.5 | Åpne og lese IFC-filer |
| ifctester | 0.8.5 | Validere mot IDS-regler |
| elementpath | — | XPath-behandling (IDS-krav) |
| xmlschema | — | XML-skjemavalidering |

Pyodide-kjøretiden lastes fra `cdn.jsdelivr.net` ved første oppstart (~200–400 MB nedlastning første gang, deretter cachet av nettleseren).

---

## Dataflyt — validering

```
IFC-fil (lokal)   IDS-regelsett (lokal/server)
      │                    │
      └─────────┬──────────┘
                │ (binærdata, ingen opplasting)
                ▼
    Pyodide Web Worker (i nettleseren)
    ┌────────────────────────────────┐
    │  ifcopenshell leser IFC        │
    │  ifctester kjører IDS-sjekk   │
    │  Tilpassede valideringer:      │
    │  - Mangler "Objektdata"-pset   │
    │  - Mangler "Objekttype"        │
    │  - Mangler "Prosessdata"-pset  │
    └────────────┬───────────────────┘
                 │ JSON (oppsummering + detaljer)
                 ▼
    React-appen viser resultater
    - Bestått/feilet per spesifikasjon
    - Objektnivå-detaljer
    - Kobling til 3D-visning i TC
```

---

## Dataflyt — rettinger og TC-integrasjon

```
Bruker retter egenskaper i UI
         │
         ▼
Pyodide Worker skriver ny IFC-fil (lokalt i nettleseren)
         │
         ├──► Last ned til PC (ingen serverinvolvering)
         │
         └──► Last opp til TC-prosjekt
                │ (via backend-API)
                ▼
              Railway-backend
                │
                ▼
              Trimble Connect API
              (To-Do / BCF / filoppasting)
```

---

## Integrasjoner

### Trimble Connect Workspace API
- Nettleserpakke: `trimble-connect-workspace-api`
- Brukes til: hente modellinformasjon fra TC-visningsprogrammet, markere objekter i 3D, få tilgang til TC-token
- Kommunikasjon: `postMessage` til overordnet vindu (TC-rammen)
- Autentisering: TC gir token automatisk via session til utvidelsen

### Trimble Connect REST API
- Kalt via backend (Railway) for å unngå CORS-begrensninger
- Endepunkter brukt:
  - `POST /tc/api/2.0/todos` — opprette To-Do med objektkobling
  - `POST /v1/context/{contextId}/issues` — opprette BCF-issue
  - `GET /tc/api/2.0/projects/{id}/users` — hente prosjektmedlemmer
  - `POST /tc/api/2.0/projects/{id}/files` + `PUT` — laste opp IFC-fil
- Europeisk region: `app.eu.connect.trimble.com`

### buildingSMART / IDS-standard
- IDS 1.0-formatet følges (XML-basert)
- IFC4X3_ADD2-skjema lastes ved behov fra buildingSMART CDN

---

## Hosting og infrastruktur

| Komponent | Plattform | Kostnad | Skalering |
|---|---|---|---|
| Frontend | Vercel (hobby) | Gratis | Automatisk (CDN) |
| Backend API | Railway | ~5–10 USD/mnd | Manuell |
| Pyodide CDN | jsDelivr | Gratis (tredjepart) | Automatisk |

### CORS-policy (backend)

Backenden tillater forespørsler fra:
- `https://ids-checker.vercel.app`
- `https://*.vercel.app` (preview-deployments)
- `null` (TC Extension iframe-opprinnelse)

---

## Funksjoner som er tilgjengelige

| Funksjon | Status | Kommentar |
|---|---|---|
| IDS Validering | Aktiv | Kjerneflyt |
| Property Editor | Aktiv | Redigere IFC-egenskaper, laste opp til TC |
| Oppdater egenskaper (fra valideringsresultat) | Fjernet (knapp skjult) | Kode beholdt, knapp ikke synlig for bruker |
| Last ned fra TC | Fjernet | Kode slettet |

---

## Sikkerhetsmerknader

### Datahåndtering
- **IFC-filer valideres lokalt i nettleseren** — filer sendes ikke til backend under normal bruk
- Backend mottar IFC-data kun ved eksplisitt oppasting til TC
- Ingen IFC-data lagres permanent på serveren

### Autentisering
- Bruker TC-token injisert fra Trimble Connect-sesjonen
- Token brukes videre i API-kall fra backend
- **Kjent svakhet:** Token refresh håndteres ikke — utvidelsen feiler stille hvis token utløper under en lang sesjon (se åpne punkt #6)

### Avhengigheter mot tredjepart
| Avhengighet | Risiko |
|---|---|
| jsDelivr CDN (Pyodide) | Nedtid → validering feiler. Mitigation: nettlesercache hjelper etter første last |
| Railway | Backend-nedetid → BCF/To-Do-funksjonalitet feiler. Validering fortsatt mulig |
| Trimble Connect API | Endringer i TC API kan bryte integrasjonen |

---

## Kjente åpne punkt (teknisk gjeld)

| Nr | Beskrivelse | Konsekvens |
|---|---|---|
| 3 | `trimble-connect-workspace-api` versjon er upinnet (`"*"` i package.json) | Kan bryte ved ny major-versjon |
| 4 | Create React App er utdatert (react-scripts) — bør migreres til Vite | Treg build, manglende HMR |
| 6 | Token refresh ikke håndtert i `App.jsx:147` | Stille feil ved utløpt TC-sesjon |

---

## TC Extension-status

Utvidelsen er **ikke offisielt registrert** i Trimble Connect Marketplace. Den fungerer fordi TC Workspace API gir token til alle utvidelser lastet inn i TC-sesjonen.

For organisasjonsbruk:
- **Intern bruk:** Registrer via `connect-support@trimble.com` (krever betalt TC-lisens)
- **Distribusjon til andre organisasjoner:** Krever Tekla Partners Program-avtale

---

## Oppsummering

Systemet har en uvanlig, men bevisst arkitektur der tung beregning (IDS-validering) er flyttet til klienten via WebAssembly, mens serveren kun håndterer integrasjonsoppgaver. Dette gir:

- **Personvern:** Ingen IFC-data forlater klienten under validering
- **Skalerbarhet:** Serverbelastning er minimal uavhengig av antall brukere
- **Avhengighet av CDN:** Første oppstart krever nedlasting av ~200–400 MB fra jsDelivr
