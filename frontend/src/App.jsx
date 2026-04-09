import { useState, useEffect } from "react";

const API_BASE = process.env.REACT_APP_API_URL || "https://ids-checker-api.railway.app";

// ── Trimble Connect integration ───────────────────────────────────────────────
async function connectToTC() {
  if (!window.parent || window.parent === window) return null;
  try {
    const WorkspaceAPI = await import("trimble-connect-workspace-api");
    let accessToken = null;

    const api = await WorkspaceAPI.connect(
      window.parent,
      (event, args) => {
        if (event === "extension.accessToken") {
          accessToken = args?.data;
        }
      },
      10000
    );

    // Set up menu so TC shows the extension in sidebar
    await api.ui.setMenu({
      title: "IDS Regelsjekker",
      icon: "",
      command: "ids_checker",
      subMenus: [],
    });

    // Request access token from TC
    const token = await api.extension.requestPermission("accesstoken");
    if (token && token !== "pending" && token !== "denied") {
      accessToken = token;
    }

    return { api, getAccessToken: () => accessToken };
  } catch (e) {
    console.log("TC connect failed (dev mode):", e.message);
    return null;
  }
}

async function fetchProjectFiles(accessToken, projectId) {
  // Use TC REST API directly with the access token
  const res = await fetch(
    `https://app.connect.trimble.com/tc/api/2.0/projects/${projectId}/files`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) throw new Error(`TC API feil: ${res.status}`);
  const data = await res.json();
  const all = data?.list || data?.files || [];
  return {
    ifcFiles: all.filter((f) => f.name?.toLowerCase().endsWith(".ifc")),
    idsFiles: all.filter((f) => f.name?.toLowerCase().endsWith(".ids")),
  };
}

async function downloadTCFile(accessToken, file) {
  const res = await fetch(
    `https://app.connect.trimble.com/tc/api/2.0/files/${file.id}/download`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Nedlasting feilet: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], file.name);
}

// ── Mock data for dev mode ────────────────────────────────────────────────────
const DEV_IFC = [
  { id: "1", name: "Arkitektur_K11.ifc", size: 18400000, versionDate: "2025-04-05" },
  { id: "2", name: "RIB_konstruksjon.ifc", size: 9100000, versionDate: "2025-04-03" },
];
const DEV_IDS = [
  { id: "a", name: "Byggherre_krav_v2.ids", versionDate: "2025-03-28" },
  { id: "b", name: "LOD300_leveranse.ids", versionDate: "2025-02-15" },
];

// ── Icons ────────────────────────────────────────────────────────────────────
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="6.5" fill="#16a34a" />
    <path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FailIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="6.5" fill="#dc2626" />
    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const FileIcon = ({ color = "#64748b" }) => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
    <path d="M3 2a1 1 0 011-1h5.5L12 4.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V2z" stroke={color} strokeWidth="1.2" />
    <path d="M8.5 1v3.5H12" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const ChevronIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
    style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.2s" }}>
    <path d="M4 2l4 4-4 4" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const UploadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M9 12V4M6 7l3-3 3 3" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 14h12" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const SpinnerIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none"
    style={{ animation: "spin 0.9s linear infinite" }}>
    <circle cx="10" cy="10" r="8" stroke="#334155" strokeWidth="2" />
    <path d="M10 2a8 8 0 018 8" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// ── FileRow ──────────────────────────────────────────────────────────────────
function FileRow({ file, selected, onSelect, type }) {
  const color = type === "ifc" ? "#0ea5e9" : "#8b5cf6";
  const size = file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ` : "";
  const date = file.versionDate ? file.versionDate.slice(0, 10) : "";
  return (
    <button onClick={() => onSelect(file)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 6, border: "none", cursor: "pointer",
      background: selected ? `${color}10` : "transparent",
      outline: selected ? `1.5px solid ${color}` : "1.5px solid transparent",
      transition: "all 0.15s", textAlign: "left", marginBottom: 3,
    }}>
      <FileIcon color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "#e2e8f0", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.name}
        </div>
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{size}{date}</div>
      </div>
      {selected && <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />}
    </button>
  );
}

// ── SpecRow ──────────────────────────────────────────────────────────────────
function SpecRow({ spec, index }) {
  const [open, setOpen] = useState(false);
  const pct = spec.total > 0 ? Math.round((spec.passed / spec.total) * 100) : 100;
  return (
    <div style={{
      background: "#0f172a", borderRadius: 8, overflow: "hidden",
      border: `1px solid ${spec.status === "passed" ? "#16a34a22" : "#dc262622"}`,
      marginBottom: 6, animation: "fadeUp 0.3s ease both",
      animationDelay: `${index * 0.04}s`,
    }}>
      <button onClick={() => spec.failures?.length > 0 && setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "10px 12px", background: "transparent", border: "none",
        cursor: spec.failures?.length > 0 ? "pointer" : "default", textAlign: "left",
      }}>
        {spec.status === "passed" ? <CheckIcon /> : <FailIcon />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", marginBottom: 2 }}>{spec.name}</div>
          <div style={{ fontSize: 10, color: "#64748b", fontFamily: "'IBM Plex Mono', monospace" }}>{spec.applicability}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: spec.status === "passed" ? "#16a34a" : "#dc2626" }}>
            {spec.passed}/{spec.total}
          </div>
          <div style={{ width: 48, height: 3, background: "#1e293b", borderRadius: 2, marginTop: 3 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: spec.status === "passed" ? "#16a34a" : "#dc2626", borderRadius: 2, transition: "width 0.6s ease" }} />
          </div>
        </div>
        {spec.failures?.length > 0 && <ChevronIcon open={open} />}
      </button>

      {open && spec.failures?.length > 0 && (
        <div style={{ borderTop: "1px solid #1e293b", padding: "8px 12px 10px" }}>
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 6 }}>KRAV: {spec.requirement}</div>
          {spec.failures.map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: 8, alignItems: "center", padding: "4px 0",
              borderBottom: i < spec.failures.length - 1 ? "1px solid #0f172a" : "none",
            }}>
              <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#dc2626", flexShrink: 0 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", flex: 1 }}>{f.name}</div>
              <div style={{ fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", color: "#475569" }}>{f.type}</div>
            </div>
          ))}
          {spec.more_failures > 0 && (
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>
              + {spec.more_failures} flere feil ikke vist
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function IDSChecker() {
  const [tc, setTc] = useState(null); // { api, getAccessToken }
  const [project, setProject] = useState(null);
  const [projectIfc, setProjectIfc] = useState([]);
  const [projectIds, setProjectIds] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [devMode, setDevMode] = useState(false);

  const [selectedIfc, setSelectedIfc] = useState(null);
  const [uploadedIfc, setUploadedIfc] = useState(null);
  const [ifcTab, setIfcTab] = useState("project");
  const [selectedIds, setSelectedIds] = useState(null);
  const [uploadedIds, setUploadedIds] = useState(null);
  const [idsTab, setIdsTab] = useState("project");

  const [loadingStep, setLoadingStep] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [filterFailed, setFilterFailed] = useState(false);

  useEffect(() => {
    (async () => {
      const tcConn = await connectToTC();

      if (!tcConn) {
        // Dev mode
        setDevMode(true);
        setProjectIfc(DEV_IFC);
        setProjectIds(DEV_IDS);
        setLoadingFiles(false);
        return;
      }

      setTc(tcConn);

      try {
        const proj = await tcConn.api.project.getCurrentProject();
        setProject(proj);

        // Wait briefly for access token to arrive
        await new Promise((r) => setTimeout(r, 1500));
        const token = tcConn.getAccessToken();

        if (token && proj?.id) {
          const { ifcFiles, idsFiles } = await fetchProjectFiles(token, proj.id);
          setProjectIfc(ifcFiles);
          setProjectIds(idsFiles);
        } else {
          setError("Kunne ikke hente access token fra Trimble Connect.");
        }
      } catch (e) {
        setError("Feil ved henting av prosjektfiler: " + e.message);
      }

      setLoadingFiles(false);
    })();
  }, []);

  const activeIfc = ifcTab === "upload" ? uploadedIfc : selectedIfc;
  const activeIds = idsTab === "upload" ? uploadedIds : selectedIds;
  const canRun = activeIfc && activeIds;

  const handleRun = async () => {
    setError(null);
    setResults(null);

    try {
      let ifcFile, idsFile;
      const token = tc?.getAccessToken();

      setLoadingStep("Laster IFC-fil…");
      if (ifcTab === "upload") {
        ifcFile = uploadedIfc;
      } else if (!devMode && token) {
        ifcFile = await downloadTCFile(token, activeIfc);
      } else {
        ifcFile = new File(["placeholder"], activeIfc.name);
      }

      setLoadingStep("Henter IDS-regelsett…");
      if (idsTab === "upload") {
        idsFile = uploadedIds;
      } else if (!devMode && token) {
        idsFile = await downloadTCFile(token, selectedIds);
      } else {
        idsFile = new File(["placeholder"], selectedIds.name);
      }

      setLoadingStep("Validerer mot IDS-regler…");
      const form = new FormData();
      form.append("ifc_file", ifcFile);
      form.append("ids_file", idsFile);

      const res = await fetch(`${API_BASE}/validate`, { method: "POST", body: form });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.detail || `Server svarte med ${res.status}`);
      }

      setResults(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingStep(null);
    }
  };

  const specs = results
    ? filterFailed
      ? results.specifications.filter((s) => s.status === "failed")
      : results.specifications
    : [];

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", background: "#080f1a", minHeight: "100vh", color: "#e2e8f0", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
      `}</style>

      {/* Header */}
      <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(180deg,#0d1b2e,#080f1a)" }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg,#6366f1,#0ea5e9)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 4h10M2 7h6M2 10h8" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="11" cy="10" r="2.5" stroke="white" strokeWidth="1.2" />
            <path d="M10.2 10l.6.6 1.2-1.2" stroke="white" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>IDS Regelsjekker</div>
          <div style={{ fontSize: 10, color: "#475569" }}>
            {devMode ? "Utviklingsmodus" : project ? `TC: ${project.name}` : "Kobler til TC…"}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Step 1 – IFC */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 8 }}>
            1 · IFC-fil
          </div>
          <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "#0f172a", borderRadius: 7, padding: 3 }}>
            {[["project", "Fra prosjektet"], ["upload", "Last opp"]].map(([key, label]) => (
              <button key={key} onClick={() => setIfcTab(key)} style={{
                flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, border: "none",
                cursor: "pointer", borderRadius: 5, transition: "all 0.15s", fontFamily: "inherit",
                background: ifcTab === key ? "#1e293b" : "transparent",
                color: ifcTab === key ? "#e2e8f0" : "#64748b",
              }}>{label}</button>
            ))}
          </div>

          {ifcTab === "project" ? (
            loadingFiles ? (
              <div style={{ fontSize: 11, color: "#475569", display: "flex", gap: 6, alignItems: "center" }}>
                <SpinnerIcon /> Henter filer…
              </div>
            ) : projectIfc.length === 0 ? (
              <div style={{ fontSize: 11, color: "#475569" }}>Ingen IFC-filer funnet i prosjektet.</div>
            ) : (
              projectIfc.map((f) => (
                <FileRow key={f.id} file={f} selected={selectedIfc?.id === f.id} onSelect={setSelectedIfc} type="ifc" />
              ))
            )
          ) : (
            <label style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
              border: `1.5px dashed ${uploadedIfc ? "#0ea5e9" : "#1e293b"}`,
              borderRadius: 8, padding: "20px 14px", cursor: "pointer",
              background: uploadedIfc ? "#0ea5e908" : "transparent",
            }}>
              <input type="file" accept=".ifc" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadedIfc(f); }} />
              <UploadIcon />
              {uploadedIfc ? (
                <div style={{ fontSize: 12, color: "#0ea5e9", fontWeight: 600 }}>{uploadedIfc.name}</div>
              ) : (
                <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>
                  Dra og slipp <span style={{ color: "#0ea5e9" }}>.ifc-fil</span> hit<br />
                  <span style={{ fontSize: 10 }}>eller klikk for å velge</span>
                </div>
              )}
            </label>
          )}
        </section>

        {/* Step 2 – IDS */}
        <section>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 8 }}>
            2 · IDS-regelsett
          </div>
          <div style={{ display: "flex", gap: 2, marginBottom: 8, background: "#0f172a", borderRadius: 7, padding: 3 }}>
            {[["project", "Fra prosjektet"], ["upload", "Last opp"]].map(([key, label]) => (
              <button key={key} onClick={() => setIdsTab(key)} style={{
                flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, border: "none",
                cursor: "pointer", borderRadius: 5, transition: "all 0.15s", fontFamily: "inherit",
                background: idsTab === key ? "#1e293b" : "transparent",
                color: idsTab === key ? "#e2e8f0" : "#64748b",
              }}>{label}</button>
            ))}
          </div>

          {idsTab === "project" ? (
            loadingFiles ? null : projectIds.length === 0 ? (
              <div style={{ fontSize: 11, color: "#475569" }}>Ingen .ids-filer funnet i prosjektet.</div>
            ) : (
              projectIds.map((f) => (
                <FileRow key={f.id} file={f} selected={selectedIds?.id === f.id} onSelect={setSelectedIds} type="ids" />
              ))
            )
          ) : (
            <label style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
              border: `1.5px dashed ${uploadedIds ? "#8b5cf6" : "#1e293b"}`,
              borderRadius: 8, padding: "20px 14px", cursor: "pointer",
              background: uploadedIds ? "#8b5cf608" : "transparent",
            }}>
              <input type="file" accept=".ids" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadedIds(f); }} />
              <UploadIcon />
              {uploadedIds ? (
                <div style={{ fontSize: 12, color: "#8b5cf6", fontWeight: 600 }}>{uploadedIds.name}</div>
              ) : (
                <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>
                  Dra og slipp <span style={{ color: "#8b5cf6" }}>.ids-fil</span> hit<br />
                  <span style={{ fontSize: 10 }}>eller klikk for å velge</span>
                </div>
              )}
            </label>
          )}
        </section>

        {/* Run button */}
        <button disabled={!canRun || !!loadingStep} onClick={handleRun} style={{
          padding: "11px 0", borderRadius: 8, border: "none",
          cursor: canRun && !loadingStep ? "pointer" : "not-allowed",
          background: canRun && !loadingStep ? "linear-gradient(135deg,#6366f1,#0ea5e9)" : "#1e293b",
          color: canRun && !loadingStep ? "white" : "#334155",
          fontFamily: "inherit", fontSize: 13, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          transition: "opacity 0.2s",
        }}>
          {loadingStep ? <><SpinnerIcon /> {loadingStep}</> : "▶  Kjør IDS-sjekk"}
        </button>

        {/* Error */}
        {error && (
          <div style={{ background: "#450a0a", border: "1px solid #dc2626", borderRadius: 8, padding: 12, fontSize: 12, color: "#fca5a5" }}>
            <strong>Feil:</strong> {error}
          </div>
        )}

        {/* Results */}
        {results && (
          <div style={{ animation: "fadeUp 0.4s ease" }}>
            <div style={{ background: "linear-gradient(135deg,#0d1b2e,#0f172a)", borderRadius: 10, padding: 14, marginBottom: 12, border: "1px solid #1e293b" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase", marginBottom: 10 }}>Resultat</div>
              <div style={{ display: "flex", gap: 10 }}>
                {[["Bestått", results.summary.passed, "#16a34a"], ["Feilet", results.summary.failed, "#dc2626"], ["Totalt", results.summary.total, "#6366f1"]].map(([label, val, color]) => (
                  <div key={label} style={{ flex: 1, textAlign: "center", background: "#080f1a", borderRadius: 7, padding: "8px 4px" }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "'IBM Plex Mono', monospace" }}>{val}</div>
                    <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "#475569" }}>{activeIfc?.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#16a34a", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%
                  </span>
                </div>
                <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
                  <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg,#16a34a,#22c55e)", width: `${results.summary.total > 0 ? Math.round((results.summary.passed / results.summary.total) * 100) : 100}%`, transition: "width 1s ease" }} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#475569", textTransform: "uppercase" }}>
                Spesifikasjoner ({specs.length})
              </div>
              <button onClick={() => setFilterFailed(!filterFailed)} style={{
                fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "none", cursor: "pointer",
                background: filterFailed ? "#dc262620" : "#1e293b",
                color: filterFailed ? "#ef4444" : "#64748b",
                fontFamily: "inherit", fontWeight: 600,
                outline: filterFailed ? "1px solid #dc262640" : "none",
              }}>
                {filterFailed ? "✕ Kun feil" : "Vis kun feil"}
              </button>
            </div>

            {specs.map((spec, i) => <SpecRow key={spec.name} spec={spec} index={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}
