# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Prosjektoversikt
Full-stack BIM-valideringsverktøy som Trimble Connect 3D Extension.
- **Frontend:** React/Vite (`/frontend`)
- **Backend:** Python FastAPI med IfcOpenShell/IfcTester (`/backend`)
- **Deploy:** Frontend på Vercel, backend på Railway

---

## Ikke-forhandlbare regler

1. **Lag en plan før du koder.** Beskriv hva du skal gjøre og hvilke filer du skal endre — før du endrer noe.
2. **Spør hvis kravene er uklare.** Ikke gjett.
3. **Rør kun det du blir bedt om.** Ikke refaktorer nabofiler, ikke rydd opp i kode du tilfeldig oppdager.
4. **Foretrekk den enkle løsningen.** Ikke introduser nye biblioteker uten å spørre først.
5. **Bekreft at det fungerer** før du erklærer deg ferdig. "Ser riktig ut" er ikke godt nok.

---

## Git-workflow

- Bruk **feature branches** for alle endringer: `git checkout -b feature/beskrivende-navn`
- En branch = én logisk endring
- Commit messages på norsk eller engelsk, men vær beskrivende: `"Legg til språkvalg i header"` ikke `"fix"`
- Push aldri direkte til `main` uten å ha verifisert at appen fungerer
- Commit-størrelse: **én ting per commit**. Ikke bland f.eks. i18n-endringer med bugfixes.

### Anti-rasjonalisering
- *"Det er bare en liten endring, jeg pusher rett til main"* → Nei. Branch alltid.
- *"Jeg fikser bare denne andre tingen mens jeg er her"* → Nei. Ny branch, ny oppgave.

---

## Testing

Prosjektet har ingen automatiske tester ennå. Inntil videre gjelder:

- **Manuell verifisering er påkrevd** før hver commit
- For frontend-endringer: sjekk at komponenten rendres riktig og at eksisterende funksjonalitet ikke er ødelagt
- For backend-endringer: test det aktuelle endepunktet manuelt (curl eller via frontend)
- Ikke skriv tester for eksisterende kode uten at det er eksplisitt bedt om

### Når tester innføres
- Skriv **feiltesten først**, se den feile, deretter skriv koden som får den til å bestå
- Backend: pytest i `/backend/tests/`
- Frontend: Vitest i `/frontend/src/__tests__/`

---

## Arkitektur og tekniske valg

### Frontend (`/frontend`)
- React + Vite
- Norsk som standard språk i UI
- Ikke introduser eksterne i18n-biblioteker (bruk enkel translations-objekt/context)
- Bruk eksisterende komponentstil — ikke introduser nye UI-biblioteker

### Backend (`/backend`)
- FastAPI + Python
- IfcOpenShell / IfcTester for IFC-validering
- Endepunkter skal være konsistente i navngiving og responsformat
- Støtt `language`-parameter (`no`/`en`) i endepunkter som returnerer brukervendte meldinger

### CORS og Railway
- CORS-konfigurasjon ligger i `backend/main.py` — vær forsiktig med endringer her
- Railway har nettverksbegrensninger — ikke anta at alle utgående kall fungerer

---

## Scope-disiplin

Disse oppgavene er **utenfor scope** med mindre eksplisitt bedt om:
- Refaktorering av eksisterende komponenter
- Endring av deploy-konfigurasjon (Vercel/Railway)
- Oppdatering av avhengigheter
- Endring av IFC-valideringslogikk når oppgaven gjelder UI

---

## Når du er ferdig med en oppgave

Bekreft følgende før du sier deg ferdig:
- [ ] Kun de filene som var nødvendige er endret
- [ ] Appen starter uten feil
- [ ] Den spesifikke funksjonaliteten fungerer som beskrevet
- [ ] Ingen eksisterende funksjonalitet er ødelagt
- [ ] Branch er klar for push
