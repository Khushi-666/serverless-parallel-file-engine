// netlify/functions/upload-chunk.js
// Computes hash for each chunk and stores partial metadata.
// Uses Netlify Blobs if available; otherwise falls back to writing files under the OS temp directory.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");

let blobsModule;
try {
  blobsModule = require("@netlify/blobs");
} catch (e) {
  blobsModule = null;
}

const LOCAL_BASE = path.join(os.tmpdir(), "local_partials"); // use OS temp dir (writable in serverless)

async function ensureDir(p) {
  try {
    await fs.mkdir(p, { recursive: true });
  } catch (e) {
    // ignore mkdir errors (we'll surface on write)
  }
}

async function writeLocal(key, data) {
  // key: "partials/<safeFileId>/chunk_0.json"
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

    // Figure out blob client (support CJS default shape)
    const blobClient = blobsModule && (blobsModule.set ? blobsModule : (blobsModule.default ? blobsModule.default : null));

    if (blobClient && typeof blobClient.set === "function") {
      try {
        await blobClient.set(key, payload, { contentType: "application/json" });
        console.log("upload-chunk: stored via blobs:", key);
      } catch (e) {
        console.warn("upload-chunk: blobs.set failed, falling back to local tmp. err:", String(e));
        await writeLocal(key, payload);
        console.log("upload-chunk: stored locally in tmp:", path.join(LOCAL_BASE, key));
      }
    } else {
      // fallback: write to OS temp directory
      await writeLocal(key, payload);
      console.log("upload-chunk: stored locally in tmp:", path.join(LOCAL_BASE, key));
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial }) };
  } catch (err) {
    console.error("upload-chunk error:", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
