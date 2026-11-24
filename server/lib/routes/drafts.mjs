// What is being typed in a session's message box (text and attachments), kept by the server so it survives a restart,
// a closed window and a page opened on another address or port (the browser's own storage is per address).
// One small file per session in <dataDir>/drafts (an emptied box keeps a tiny file with its time). Drafts untouched for
// 30 days go.
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_TEXT = 200_000;
const MAX_TOTAL = 30 * 1024 * 1024; // attachments included (base64)
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export default function register({ route, config, join, HttpError }) {
  const dir = join(config.dataDir, "drafts");
  const file = (id) => {
    if (!ID.test(String(id))) throw new HttpError(400, "bad session id");
    return join(dir, `${id}.json`);
  };
  const writes = new Map(); // id -> promise: writes of one draft happen in order

  // Old drafts of sessions nobody went back to.
  (async () => {
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [])) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > MAX_AGE_MS) await unlink(path).catch(() => {});
    }
  })();

  route("GET", "/api/drafts/([^/]+)", async ({ params }) => {
    try {
      const draft = JSON.parse(await readFile(file(params[0]), "utf8"));
      return { text: String(draft.text || ""), images: Array.isArray(draft.images) ? draft.images : [], at: Number(draft.at) || 0 };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return { text: "", images: [], at: 0 };
    }
  });

  route("PUT", "/api/drafts/([^/]+)", async ({ params, body }) => {
    const path = file(params[0]);
    const text = String(body?.text || "").slice(0, MAX_TEXT);
    let images = (Array.isArray(body?.images) ? body.images : [])
      .filter((image) => image && typeof image.data === "string" && typeof image.mediaType === "string")
      .map((image) => ({ mediaType: image.mediaType, name: String(image.name || "file"), size: Number(image.size) || 0, data: image.data }));
    const at = Number(body?.at) || Date.now();
    const previous = writes.get(params[0]) || Promise.resolve();
    let stale = false;
    const next = previous.then(async () => {
      let stored = null;
      try { stored = JSON.parse(await readFile(path, "utf8")); } catch { /* none yet */ }
      // A save older than the stored one (a retry, a slow request, another window) must not overwrite it.
      if (stored && Number(stored.at) > at) {
        stale = true;
        return;
      }
      if (body?.keepImages) images = Array.isArray(stored?.images) ? stored.images : []; // only the text changed
      const json = JSON.stringify({ text, images, at });
      if (json.length > MAX_TOTAL) throw new HttpError(413, "draft too large");
      // An emptied box is written too (a few bytes), so a late older save cannot bring the old text back.
      if (!text.trim() && !images.length) images = [];
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, json, "utf8");
      await rename(`${path}.tmp`, path);
    });
    writes.set(params[0], next.catch(() => {}));
    await next;
    return { ok: true, at, stale };
  });
}
