// src/App.jsx  (updated — full file)
import { useState } from "react";

function readFileAsBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(",")[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

export default function App() {
  const [file, setFile] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [concurrency, setConcurrency] = useState(4);
  const [aggregate, setAggregate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rawResp, setRawResp] = useState(null);
  const [respStatus, setRespStatus] = useState(null);

  function makeChunks(f, CHUNK_SIZE = 2 * 1024 * 1024) {
    const total = Math.ceil(f.size / CHUNK_SIZE);
    const arr = [];
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, f.size);
      arr.push({ index: i, start, end, status: "pending", partial: null });
    }
    return arr;
  }

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
          chunkBase64: base64
        })
      });
      const json = await res.json();
      if (json?.ok) {
        setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "done", partial: json.partial } : c));
      } else {
        setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "error", error: json?.error || "unknown" } : c));
      }
    } catch (err) {
      setChunks(prev => prev.map(c => c.index === chunkObj.index ? { ...c, status: "error", error: String(err) } : c));
    }
  }

  async function uploadFileInChunksConcurrent(f) {
    if (!f) return;
    setAggregate(null);
    setRawResp(null);
    setRespStatus(null);
    setBusy(true);
    const CHUNK_SIZE = 2 * 1024 * 1024;
    const created = makeChunks(f, CHUNK_SIZE);
    setChunks(created);
    const CONCURRENCY = Math.max(1, Number(concurrency) || 4);
    let nextIndex = 0;
    const workers = new Array(CONCURRENCY).fill(null).map(async () => {
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

  // UPDATED fetchAggregate with raw text capture and better errors
  async function fetchAggregate() {
    if (!file) return;
    setBusy(true);
    setRawResp(null);
    setRespStatus(null);
    setAggregate(null);
    try {
      const res = await fetch(`/.netlify/functions/merge-results?fileId=${encodeURIComponent(file.name)}`);
      setRespStatus(`${res.status} ${res.statusText}`);
      const text = await res.text();
      setRawResp(text);
      // Try to parse JSON safely
      try {
        const json = JSON.parse(text);
        if (json?.ok && json.aggregate) {
          setAggregate(json.aggregate);
        } else if (json?.ok && !json.aggregate) {
          // server returned { ok:true } but no aggregate
          alert("Merge returned OK but no aggregate — check partials or server logs.");
        } else {
          // server returned an error object
          alert("Merge returned error: " + (json?.error || JSON.stringify(json)));
        }
      } catch (parseErr) {
        // not JSON — warn and show raw
        console.warn("Failed to parse merge-results response as JSON:", parseErr);
        alert("Received non-JSON response. Check Raw Response below and server logs.");
      }
    } catch (err) {
      alert("Failed to fetch aggregate: " + String(err));
    } finally {
      setBusy(false);
    }
  }

  const completed = chunks.filter(c => c.status === "done").length;
  const errored = chunks.filter(c => c.status === "error").length;
  const total = chunks.length;

  return (
    <div style={{ padding: 20, fontFamily: 'Inter, Roboto, sans-serif', maxWidth: 1000, margin: 'auto' }}>
      <h2>Serverless Parallel File Demo (Netlify) — Concurrent Uploads</h2>

      <div style={{ marginBottom: 10 }}>
        <input type="file" onChange={(e) => { setFile(e.target.files?.[0] || null); setChunks([]); setAggregate(null); setRawResp(null); }} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label style={{ minWidth: 90 }}>Concurrency:</label>
        <input type="number" min="1" max="16" value={concurrency} onChange={e => setConcurrency(e.target.value)} style={{ width: 80 }} />
        <button disabled={!file || busy} onClick={() => uploadFileInChunksConcurrent(file)}>Upload & Process Concurrently</button>
        <button disabled={!file || busy} onClick={fetchAggregate}>Fetch Aggregate</button>
        {busy && <span style={{ marginLeft: 8 }}>Working…</span>}
      </div>

      <div style={{ marginTop: 8 }}>
        <div>Completed: {completed} / {total} {errored ? ` — Errors: ${errored}` : ""}</div>
        <div style={{ height: 10, background: '#eee', borderRadius: 6, overflow: 'hidden', marginTop: 6 }}>
          <div style={{ width: total ? `${(completed / total) * 100}%` : '0%', height: '100%', background: '#3b82f6' }} />
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}><th>Chunk</th><th>Status</th><th>Info</th><th>Action</th></tr>
          </thead>
          <tbody>
            {chunks.map(c => (
              <tr key={c.index} style={{ borderTop: "1px solid #f0f0f0" }}>
                <td style={{ padding: '8px 4px' }}>#{c.index}</td>
                <td style={{ padding: '8px 4px' }}>{c.status}</td>
                <td style={{ padding: '8px 4px', whiteSpace: 'pre-wrap' }}>{c.partial ? JSON.stringify(c.partial) : (c.error ? c.error : "")}</td>
                <td style={{ padding: '8px 4px' }}>
                  {c.status === "error" && <button onClick={() => retryChunk(c.index)}>Retry</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 20 }}>
        <h4>Aggregate / Final</h4>
        <div style={{ marginBottom: 8 }}>
          <strong>HTTP</strong>: {respStatus || "n/a"} &nbsp;
          {rawResp && <button onClick={() => { navigator.clipboard?.writeText(rawResp); alert("Raw response copied to clipboard"); }}>Copy raw</button>}
        </div>

        {aggregate ? (
          <pre style={{ background: '#f8fafc', padding: 12, borderRadius: 6 }}>{JSON.stringify(aggregate, null, 2)}</pre>
        ) : (
          <div style={{ background: '#fff7ed', padding: 12, borderRadius: 6, minHeight: 60 }}>
            <div style={{ marginBottom: 8 }}>No aggregate parsed yet.</div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              <div><strong>Raw response preview:</strong></div>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', background: '#fff', padding: 8 }}>{rawResp || "(empty)"}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
