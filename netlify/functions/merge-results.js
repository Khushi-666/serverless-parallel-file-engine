// netlify/functions/merge-results.js
// Reads partials for a given fileId and returns an aggregate.
// Tries Netlify Blobs list/get; if unavailable, reads from OS tmp fallback.

const path = require("path");
const fs = require("fs").promises;
const os = require("os");

let blobsModule;
try {
  blobsModule = require("@netlify/blobs");
} catch (e) {
  blobsModule = null;
}

const LOCAL_BASE = path.join(os.tmpdir(), "local_partials");

async function readLocalPrefix(prefix) {
  // prefix is like "partials/<safeFileId>/"
  const dir = path.join(LOCAL_BASE, prefix);
  const out = [];
  try {
    const items = await fs.readdir(dir);
    for (const name of items) {
      const fp = path.join(dir, name);
      try {
        const stat = await fs.stat(fp);
        if (stat.isFile()) {
          const txt = await fs.readFile(fp, "utf8");
          try {
            out.push(JSON.parse(txt));
          } catch (e) {
            console.warn("readLocalPrefix: failed parse", fp, e);
          }
        }
      } catch (e) {
        // ignore file read errors
      }
    }
  } catch (e) {
    // directory may not exist -> return empty
  }
  return out;
}

exports.handler = async (event) => {
  try {
    const fileId = event.queryStringParameters?.fileId;
    if (!fileId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "missing fileId" }) };
    }

    const safeFileId = encodeURIComponent(fileId);
    const prefix = `partials/${safeFileId}/`;

    const blobClient = blobsModule && (blobsModule.list ? blobsModule : (blobsModule.default ? blobsModule.default : null));
    let partials = [];

    if (blobClient && typeof blobClient.list === "function" && typeof blobClient.get === "function") {
      // Use blobs API
      try {
        const listed = await blobClient.list(prefix);
        const items = listed && Array.isArray(listed.blobs) ? listed.blobs : [];
        for (const obj of items) {
          try {
            const content = await blobClient.get(obj.key, { type: "json" });
            if (content) partials.push(content);
          } catch (e) {
            console.warn("merge-results: failed to get blob", obj.key, e);
          }
        }
      } catch (e) {
        console.warn("merge-results: blobs.list/get failed, falling back to local tmp. err:", String(e));
        partials = await readLocalPrefix(prefix);
      }
    } else {
      // fallback to OS tmp local filesystem
      partials = await readLocalPrefix(prefix);
    }

    partials.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));

    const aggregate = {
      fileId,
      totalChunksFound: partials.length,
      hashes: partials.map((p) => p.hash),
      partials,
      generatedAt: Date.now(),
    };

    return { statusCode: 200, body: JSON.stringify({ ok: true, aggregate }) };
  } catch (err) {
    console.error("merge-results error:", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
