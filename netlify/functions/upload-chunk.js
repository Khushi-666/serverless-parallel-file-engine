// netlify/functions/upload-chunk.js
// Computes hash for each chunk and stores partial metadata.
// Uses Netlify Blobs if available; otherwise falls back to writing files under ./local_partials/

const crypto = require("crypto");
const path = require("path");
const fs = require("fs").promises;

let blobsModule;
try {
  blobsModule = require("@netlify/blobs");
} catch (e) {
  blobsModule = null;
}

const LOCAL_BASE = path.join(process.cwd(), "local_partials"); // fallback directory

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

async function writeLocal(key, data) {
  const full = path.join(LOCAL_BASE, key);
  const dir = path.dirname(full);
  await ensureDir(dir);
  await fs.writeFile(full, data, "utf8");
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { fileId, chunkIndex, totalChunks, chunkBase64 } = body;

    if (!chunkBase64) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "no chunk" }) };
    }

    const chunk = Buffer.from(chunkBase64, "base64");
    const hash = crypto.createHash("sha256").update(chunk).digest("hex");

    const partial = {
      fileId,
      chunkIndex,
      totalChunks,
      hash,
      len: chunk.length,
      ts: Date.now(),
    };

    const safeFileId = encodeURIComponent(fileId);
    const key = `partials/${safeFileId}/chunk_${chunkIndex}.json`;
    const payload = JSON.stringify(partial);

    // Use Netlify Blobs if available and provides `set`
    const blobClient = blobsModule && (blobsModule.set ? blobsModule : (blobsModule.default ? blobsModule.default : null));

    if (blobClient && typeof blobClient.set === "function") {
      // attempt to use blobs API
      try {
        await blobClient.set(key, payload, { contentType: "application/json" });
        console.log("upload-chunk: stored via blobs:", key);
      } catch (e) {
        console.warn("upload-chunk: blobs.set failed, falling back to local. err:", String(e));
        await writeLocal(key, payload);
      }
    } else {
      // fallback: write to local filesystem under ./local_partials
      await writeLocal(key, payload);
      console.log("upload-chunk: stored locally:", key);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial }) };
  } catch (err) {
    console.error("upload-chunk error:", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
