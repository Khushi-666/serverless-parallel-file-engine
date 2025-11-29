// src/App.jsx
import { useEffect, useState, useRef } from "react";

/* ---------- Helpers ---------- */
function readFileAsBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(",")[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function humanBytes(n) {
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 1024 && i === 0 ? 0 : 2)} ${units[i]}`;
}

/* ---------- UI icons (small inline SVGs) ---------- */
const IconUpload = ({ className = "icon" }) => (
  <svg className={className} viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconRetry = ({ className = "icon" }) => (
  <svg className={className} viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12a9 9 0 10-3.7 7.1L21 12z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M21 3v6h-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

/* ---------- Main component ---------- */
export default function App() {
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [chunks, setChunks] = useState([]); // {index, start, end, status, partial?, error?}
  const [concurrency, setConcurrency] = useState(4);
  const [busy, setBusy] = useState(false);
  const [aggregate, setAggregate] = useState(null);
  const [rawResp, setRawResp] = useState(null);
  const inputRef = useRef();

  useEffect(() => {
    // reset when file changes
    setChunks([]);
    setAggregate(null);
    setRawResp(null);
  }, [file]);

  /* ---------- chunk creation ---------- */
  function makeChunks(f, CHUNK_SIZE = 2 * 1024 * 1024) {
    const total = Math.max(1, Math.ceil(f.size / CHUNK_SIZE));
    const arr = [];
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, f.size);
      arr.push({ index: i, start, end, status: "pending", partial: null });
    }
    return arr;
  }

  /* ---------- per chunk upload ---------- */
  async function uploadChunk(f, chunkObj, totalChunks) {
    setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "uploading", error: undefined } : c));
    try {
      const blob = f.slice(chunkObj.start, chunkObj.end);
      const base64 = await readFileAsBase64(blob);

      const res = await fetch("/.netlify/functions/upload-chunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: f.name,
          chunkIndex: chunkObj.index,
          totalChunks,
          chunkBase64: base64,
        }),
      });

      const json = await res.json().catch(() => null);
      if (json?.ok) {
        setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "done", partial: json.partial } : c));
      } else {
        const err = json?.error || `HTTP ${res.status}`;
        setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "error", error: err } : c));
      }
    } catch (err) {
      setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "error", error: String(err) } : c));
    }
  }

  /* ---------- concurrent orchestrator ---------- */
  async function uploadFileInChunksConcurrent(f) {
    if (!f) return;
    setAggregate(null);
    setRawResp(null);
    setBusy(true);
    const CHUNK_SIZE = 2 * 1024 * 1024;
    const created = makeChunks(f, CHUNK_SIZE);
    setChunks(created);

    const CONC = Math.max(1, Number(concurrency) || 4);
    let nextIndex = 0;

    const workers = new Array(CONC).fill(null).map(async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= created.length) break;
        await uploadChunk(f, created[i], created.length);
      }
    });

    await Promise.all(workers);
    setBusy(false);
  }

  async function retryChunk(index) {
    const chunkObj = chunks.find(c => c.index === index);
    if (!chunkObj || !file) return;
    setChunks(prev => prev.map(c => c.index === index ? { ...c, status: "pending", error: undefined } : c));
    await uploadChunk(file, chunkObj, chunks.length);
  }

  /* ---------- fetch aggregate ---------- */
  async function fetchAggregate() {
    if (!file) return;
    setBusy(true);
    setAggregate(null);
    setRawResp(null);
    try {
      const res = await fetch(`/.netlify/functions/merge-results?fileId=${encodeURIComponent(file.name)}`);
      const text = await res.text();
      setRawResp(text);
      try {
        const json = JSON.parse(text);
        if (json?.ok && json.aggregate) setAggregate(json.aggregate);
        else {
          // show error to user
          alert("Merge returned error or unexpected response. See raw response panel.");
        }
      } catch (e) {
        alert("Merge result is not valid JSON. See raw response.");
      }
    } catch (err) {
      alert("Failed to fetch aggregate: " + String(err));
    } finally {
      setBusy(false);
    }
  }

  /* ---------- drag & drop handlers ---------- */
  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
    }
  }

  /* ---------- small file preview ---------- */
  function FilePreview({ file }) {
    if (!file) return null;
    const isImage = file.type.startsWith("image/");
    return (
      <div className="file-preview">
        {isImage ? (
          <img alt={file.name} src={URL.createObjectURL(file)} className="preview-img" />
        ) : (
          <div className="file-meta">
            <div className="file-name">{file.name}</div>
            <div className="file-size">{humanBytes(file.size)}</div>
            <div className="file-type">{file.type || "Unknown type"}</div>
          </div>
        )}
      </div>
    );
  }

  const completed = chunks.filter(c => c.status === "done").length;
  const errored = chunks.filter(c => c.status === "error").length;
  const total = chunks.length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo">SPFE</div>
          <div className="tag">Serverless Parallel File Engine</div>
        </div>
        <div className="top-actions">
          <button className="btn ghost" onClick={() => { setFile(null); setChunks([]); setAggregate(null); setRawResp(null); }}>
            Clear
          </button>
        </div>
      </header>

      <main className="container">
        <section
          className={`dropzone ${dragOver ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
        >
          <div className="drop-inner">
            <IconUpload />
            <h3>Drag & drop a file here</h3>
            <p className="muted">or click to select a file. Works best with 5–50 MB test files.</p>
            <div className="small">Tip: try increasing concurrency to see parallel uploads.</div>
            <input ref={inputRef} type="file" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
        </section>

        <section className="panel-grid">
          <div className="left-panel card">
            <h4>File</h4>
            {file ? (
              <>
                <FilePreview file={file} />
                <div className="file-controls">
                  <div className="control-row">
                    <label>Chunk size</label>
                    <div className="muted">2 MB (fixed for demo)</div>
                  </div>

                  <div className="control-row">
                    <label>Concurrency</label>
                    <div className="concurrency-row">
                      <input
                        type="range"
                        min="1"
                        max="12"
                        value={concurrency}
                        onChange={(e) => setConcurrency(Number(e.target.value))}
                      />
                      <div className="concurrency-value">{concurrency}</div>
                    </div>
                  </div>

                  <div className="buttons-row">
                    <button className="btn primary" disabled={!file || busy} onClick={() => uploadFileInChunksConcurrent(file)}>
                      {busy ? "Working..." : "Upload & Process"}
                    </button>
                    <button className="btn" disabled={!file || busy} onClick={fetchAggregate}>
                      Fetch Aggregate
                    </button>
                  </div>

                  <div className="summary">
                    <div>Chunks: <strong>{total}</strong></div>
                    <div>Completed: <strong>{completed}</strong></div>
                    <div style={{ color: errored ? "#c2410c" : "#6b7280" }}>Errors: <strong>{errored}</strong></div>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <div className="muted">No file selected yet. Click the drop area or drag a file here to begin.</div>
              </div>
            )}
          </div>

          <div className="right-panel card">
            <h4>Chunks</h4>

            <div className="progress-bar-outer">
              <div className="progress-bar-inner" style={{ width: total ? `${(completed / total) * 100}%` : "0%" }} />
            </div>

            <div className="chunks-grid">
              {chunks.length === 0 && <div className="muted">No chunks yet. Upload a file to see chunk cards.</div>}

              {chunks.map(c => (
                <div key={c.index} className={`chunk-card ${c.status}`}>
                  <div className="chunk-index">#{c.index}</div>
                  <div className="chunk-body">
                    <div className="chunk-info">
                      <div className="small muted">status</div>
                      <div className="status-row">
                        <span className={`badge ${c.status}`}>{c.status}</span>
                        {c.partial && <div className="meta">{c.partial.hash.slice(0, 10)}…</div>}
                      </div>
                    </div>

                    <div className="chunk-actions">
                      {c.status === "error" && (
                        <button className="btn small ghost" onClick={() => retryChunk(c.index)}>
                          <IconRetry /> Retry
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="aggregate-box">
              <div className="agg-header">
                <div style={{ fontWeight: 600 }}>Aggregate</div>
                <div className="muted small">{aggregate ? `${aggregate.totalChunksFound} partials` : "no aggregate yet"}</div>
              </div>

              <div className="agg-body">
                {aggregate ? (
                  <pre className="agg-pre">{JSON.stringify(aggregate, null, 2)}</pre>
                ) : (
                  <div className="muted">
                    Click <strong>Fetch Aggregate</strong> to retrieve combined results from the server.
                    <div style={{ marginTop: 8 }}>
                      <small>Raw response preview:</small>
                      <pre className="raw-pre">{rawResp ? rawResp : "(empty)"}</pre>
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>
        </section>
      </main>

      <footer className="footer">
        <div>Made for demo • Serverless Parallel File Engine</div>
        <div className="muted small">Tip: use 5–30MB files to see chunking in action.</div>
      </footer>
    </div>
  );
}
