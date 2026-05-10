# Oppgave: Bygg "Property Editor" side i IDS Regelsjekker

## Viktige regler
- Endre KUN `frontend/src/App.jsx`
- Rør IKKE: `backend/`, `frontend/public/manifest.json`, `frontend/src/index.js`, `frontend/package.json`
- Les gjennom hele App.jsx før du begynner
- Ikke fjern eksisterende funksjonalitet – legg til ny
- Bruk eksisterende komponenter: `usePyodide`, `FolderPicker`, `uploadFileToTC`, `IFC_DATATYPES`, `M` (fargepalett), `log`
- Test at Vercel-build ikke feiler (ingen syntaksfeil, balanserte klammeparenteser)
- Kjør `cd frontend && npm run build` for å verifisere før du er ferdig

---

## Kontekst

Appen er en Trimble Connect 3D Extension bygget i React (CRA), hostet på Vercel.
Navigasjon styres av `page`-state i `IDSChecker`-komponenten:
- `"home"` → forsiden med tre kort
- `"ids"` → IDS Validering (eksisterer)
- `"download"` → Last ned fra TC (eksisterer)
- `"props"` → **Property Editor (skal bygges)**

Forsiden har allerede et kort for "Property Editor" som kaller `onSelect("props")`.
Du trenger bare å legge til routing for `page === "props"` og selve komponenten.

---

## Hva som skal bygges: PropertyEditorPage

Dette er en **ny selvstendig side** – ikke det samme som den eksisterende `PropertyEditor`-komponenten (som brukes etter IDS-validering). Kall den `PropertyEditorPage` for å unngå konflikt.

### 1. IFC-kilde (øverst på siden)

Bruker velger mellom to faner:
- **Last opp fra PC** – bruk eksisterende `UploadZone`-komponent med `accept=".ifc"`
- **Hent fra TC-mappe** – bruk eksisterende `FolderPicker` + `downloadurl`-logikk

Når IFC er valgt, last den inn i Pyodide:
```javascript
const bytes = await file.arrayBuffer();
await pyodide.FS.writeFile("/editor_model.ifc", new Uint8Array(bytes));
```

Vis filnavn og størrelse når fil er lastet. Pyodide lastes via eksisterende `usePyodide`-hook.

---

### 2. Regelbygger

Bruker kan legge til flere regler med "+ Legg til regel"-knapp.

Hver regel inneholder:

#### 2a. Filtre (AND mellom alle)
Bruker kan legge til flere filtre per regel med "+ Legg til filter".
Hvert filter har en rullegardin med type og tilhørende inputfelt(er):

| Type (rullegardin) | Inputfelt(er) |
|---|---|
| `IFC-type` | Tekstfelt, f.eks. `IfcSlab` |
| `Name inneholder` | Tekstfelt |
| `Har egenskapssett` | Tekstfelt (pset-navn) |
| `Egenskap = verdi` | Tre felter: pset-navn + egenskap-navn + verdi |

Alle filtre kombineres med AND.

#### 2b. "Sjekk treff"-knapp per regel
Valgfri knapp som kjører filtrering i Pyodide og viser antall matchende objekter.
Eksempel resultat: `✓ 14 objekter matcher`

Python-logikk for filtrering:
```python
import ifcopenshell, ifcopenshell.util.element, json

filters_json = '...'  # sendes fra JS via py.globals.set()
filters = json.loads(filters_json)

model = ifcopenshell.open("/editor_model.ifc")

def matches_filters(entity, filters):
    for f in filters:
        ftype = f.get("type")
        if ftype == "ifc_type":
            if not entity.is_a(f["value"]): return False
        elif ftype == "name_contains":
            name = getattr(entity, "Name", "") or ""
            if f["value"].lower() not in name.lower(): return False
        elif ftype == "has_pset":
            psets = ifcopenshell.util.element.get_psets(entity)
            if f["pset"] not in psets: return False
        elif ftype == "property_equals":
            psets = ifcopenshell.util.element.get_psets(entity)
            pset = psets.get(f["pset"], {})
            if str(pset.get(f["property"], "")) != f["value"]: return False
    return True

count = sum(1 for e in model.by_type("IfcProduct") if matches_filters(e, filters))
str(count)
```

#### 2c. Egenskaper å sette (én eller flere per regel)
Bruker kan legge til flere egenskaper med "+ Legg til egenskap".
Hver egenskap har fire felt på én rad:
- Egenskapssett (tekstfelt)
- Egenskap-navn (tekstfelt)
- Verdi (tekstfelt)
- Datatype (rullegardin) – bruk eksisterende `IFC_DATATYPES`-konstant

---

### 3. Lagre og laste inn regler (CSV)

#### CSV-format
```csv
filter_type,filter_pset,filter_property,filter_value,target_pset,target_property,target_value,target_datatype
IfcSlab,,,, Objektdata,Tykkelse,40,IfcReal
,Objektdata,Objekttype,Slitelag,Objektdata,Fase,Drift,IfcLabel
```

Én rad per kombinasjon av (regel-filtre × egenskap).
- `filter_type` – IFC-type (tom = ikke brukt)
- `filter_pset/property/value` – egenskap-filter (alle tre tomme = ikke brukt)
- `target_*` – egenskapen som skal settes

Merk: Én regel med 2 filtre og 2 egenskaper → 2 rader (samme filtre gjentas).

#### Lagre til TC
1. Serialiser regler til CSV-streng
2. Åpne `FolderPicker` for å velge mappe
3. Kall `uploadFileToTC(tc, csvBytes, "regler.csv", folderId)` – bruk eksisterende funksjon

#### Laste inn fra TC
1. Åpne `FolderPicker` → vis kun `.csv`-filer
2. Hent fil via `downloadurl`-endepunktet
3. Parse CSV med `Papa.parse` (importer fra `papaparse` – allerede tilgjengelig i React-miljøet)
4. Bygg regelstrukturen fra CSV-radene

#### Laste inn fra PC
Enkel filopplasting med `<input type="file" accept=".csv">`, parse med Papa.parse.

---

### 4. Kjør alle regler

"Kjør alle regler"-knapp kjører Pyodide-kode:

```python
import ifcopenshell, ifcopenshell.util.element, ifcopenshell.api, json

rules_json = '...'  # sendes via py.globals.set()
rules = json.loads(rules_json)

model = ifcopenshell.open("/editor_model.ifc")
schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(model.schema_identifier)

def matches_filters(entity, filters):
    for f in filters:
        ftype = f.get("type")
        if ftype == "ifc_type":
            if not entity.is_a(f["value"]): return False
        elif ftype == "name_contains":
            name = getattr(entity, "Name", "") or ""
            if f["value"].lower() not in name.lower(): return False
        elif ftype == "has_pset":
            psets = ifcopenshell.util.element.get_psets(entity)
            if f["pset"] not in psets: return False
        elif ftype == "property_equals":
            psets = ifcopenshell.util.element.get_psets(entity)
            pset = psets.get(f["pset"], {})
            if str(pset.get(f["property"], "")) != f["value"]: return False
    return True

def cast_value(value, data_type):
    try:
        ifc_type = schema.declaration_by_name(data_type)
        if ifc_type: return ifc_type(value)
    except: pass
    if data_type in ("IfcReal","IfcLengthMeasure","IfcAreaMeasure","IfcVolumeMeasure","IfcMassMeasure","IfcPositiveLengthMeasure","IfcPlaneAngleMeasure"):
        return float(value)
    if data_type in ("IfcInteger","IfcCountMeasure"):
        return int(value)
    if data_type == "IfcBoolean":
        return value.lower() in ("true","1","ja","yes")
    return value

total_updated = 0
for rule in rules:
    filters = rule.get("filters", [])
    properties = rule.get("properties", [])
    matching = [e for e in model.by_type("IfcProduct") if matches_filters(e, filters)]
    for entity in matching:
        for prop in properties:
            pset_name = prop["pset"]
            prop_name = prop["name"]
            prop_value = cast_value(prop["value"], prop.get("datatype", "IfcLabel"))
            psets = ifcopenshell.util.element.get_psets(entity)
            if pset_name in psets:
                pset_obj = model.by_id(psets[pset_name]["id"])
                ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: prop_value})
            else:
                pset_obj = ifcopenshell.api.run("pset.add_pset", model, product=entity, name=pset_name)
                ifcopenshell.api.run("pset.edit_pset", model, pset=pset_obj, properties={prop_name: prop_value})
        total_updated += 1

model.write("/editor_output.ifc")
str(total_updated)
```

Etter kjøring:
- Vis resultat: f.eks. `✓ 42 objekter oppdatert`
- Knapp: **Last ned til PC** – les `/editor_output.ifc` fra Pyodide FS og lag blob-nedlasting
- Knapp: **Last opp til TC** – åpne `FolderPicker`, kall `uploadFileToTC`

---

### 5. Routing i IDSChecker

Legg til i `IDSChecker`-render:
```javascript
if (page === "props") {
  return (
    <div style={{ fontFamily:"'Open Sans','Roboto',sans-serif", minHeight:"100vh", color:M.gray, display:"flex", flexDirection:"column" }}>
      {globalStyle}
      <PropertyEditorPage
        tc={tc}
        devMode={devMode}
        pyodide={/* pass pyodide ref fra usePyodide */}
        onBack={() => setPage("home")}
      />
    </div>
  );
}
```

`usePyodide`-hooken må eksponere `pyodide`-instansen direkte (eller en `run`-funksjon) i tillegg til `validate` og `updateProperties`.

---

### 6. Datastruktur for regler (JavaScript)

```javascript
const rule = {
  id: "regel-1",  // unik ID for React key
  filters: [
    { id: "f1", type: "ifc_type", value: "IfcSlab" },
    { id: "f2", type: "property_equals", pset: "Objektdata", property: "Objekttype", value: "Slitelag" },
  ],
  properties: [
    { id: "p1", pset: "Objektdata", name: "Tykkelse", value: "40", datatype: "IfcReal" },
    { id: "p2", pset: "Objektdata", name: "Fase", value: "Drift", datatype: "IfcLabel" },
  ],
  matchCount: null,  // null = ikke sjekket, tall etter sjekk
};
```

---

### 7. UI-stil

Følg eksisterende mønster fra resten av App.jsx:
- Inline styles med `M`-fargepaletten
- Seksjoner med `<section>` og grå overskrift
- Samme knappestil som resten
- Header med tilbake-pil (`←`) og tittel "Property Editor"
- `log.info/ok/warn/error` for debugging

