// POST /api/media?action=list|upload|delete
// Env: BOT_TOKEN, ALLOWED_USER_IDS (comma-separated Telegram ids), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
const crypto = require("crypto");
const { S3Client, ListObjectsV2Command, CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const E = process.env;
const R = (k) => (E[k] || "").trim().replace(/^["']+|["']+$/g, ""); // ignore stray spaces, line breaks and quotes
const Bucket = R("R2_BUCKET");
// If a whole address was pasted instead of the plain Account ID, pull out the 32-character ID
const ACCT = (R("R2_ACCOUNT_ID").match(/[0-9a-f]{32}/i) || [R("R2_ACCOUNT_ID")])[0];
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCT}.r2.cloudflarestorage.com`,
  forcePathStyle: true, // keeps the bucket name out of the web address
  credentials: { accessKeyId: R("R2_ACCESS_KEY_ID"), secretAccessKey: R("R2_SECRET_ACCESS_KEY") },
  requestChecksumCalculation: "WHEN_REQUIRED", // keeps presigned PUTs compatible with R2
});

// Plain-language description of a wrong storage setting, or "" when the settings look right
const configProblem = () =>
  !/^[0-9a-f]{32}$/i.test(ACCT) ? "R2_ACCOUNT_ID isn't a valid Account ID. It must be exactly 32 letters and numbers, found on the main R2 page in Cloudflare."
  : !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(Bucket) ? "R2_BUCKET isn't a valid bucket name (3 to 63 lowercase letters, numbers and dashes). Copy it exactly from Cloudflare."
  : !R("R2_ACCESS_KEY_ID") || !R("R2_SECRET_ACCESS_KEY") ? "R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is empty." : "";

function verify(initData) {
  // Returns { user } when Telegram's signature is valid, otherwise { reason } so the app can explain what is wrong.
  const token = (E.BOT_TOKEN || "").trim().replace(/^["']+|["']+$/g, "");
  if (!token) return { reason: "no_token" };
  if (!initData) return { reason: "no_initdata" };
  const p = new URLSearchParams(initData), hash = p.get("hash");
  p.delete("hash");
  if (!hash) return { reason: "no_initdata" };
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { reason: "bad_signature" };
  const age = Date.now() / 1000 - Number(p.get("auth_date"));
  if (!Number.isFinite(age) || age < -300) return { reason: "invalid_auth_date", age };
  if (age > 86400) return { reason: "expired", age }; // Telegram initData should be reasonably fresh
  try { return { user: JSON.parse(p.get("user")) }; } catch { return { reason: "no_initdata" }; }
}

const sign = (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
const enc = (k) => encodeURIComponent(k); // CopySource must be URL-encoded, including slashes in the object key
// Copy first, delete the original only if the copy worked, so a failure never loses a file
const move = async (from, to) => {
  if (from === to) return;
  // Treat an already-copied destination as a successful move. This makes retries
  // safe after a copy succeeds but the source deletion fails.
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: to }));
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: from }] } }));
    return;
  } catch {}
  await s3.send(new CopyObjectCommand({ Bucket, CopySource: `${Bucket}/${enc(from)}`, Key: to }));
  // Verify the destination exists before deleting the only source copy.
  await s3.send(new HeadObjectCommand({ Bucket, Key: to }));
  await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: from }] } }));
};
// Optional companion objects (thumbnails/compatible copies) get a short retry window.
// This avoids leaving a source-side orphan when R2 has a transient copy/delete failure.
const moveOptional = async (from, to) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket, Key: from }));
    } catch {
      // Missing optional companion is normal; there is nothing to repair.
      return true;
    }
    try {
      await move(from, to);
      return true;
    } catch (e) {
      if (attempt === 2) return false;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  return false;
};
const each = async (arr, fn, n = 8) => { // run fn on every item, a few at a time; failures become null
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const j = i++; try { out[j] = await fn(arr[j]); } catch { out[j] = null; } } }));
  return out;
};
// Passcode lock: failed attempts are remembered in the bucket so the lockout survives between requests
const BOT = R("BOT_TOKEN"), STATE = "_meta/pin.json";
const getState = async () => {
  try { const r = await s3.send(new GetObjectCommand({ Bucket, Key: STATE })); return JSON.parse(await r.Body.transformToString()); }
  catch { return { fails: 0, lockedUntil: 0 }; }
};
const putState = (st) => s3.send(new PutObjectCommand({ Bucket, Key: STATE, Body: JSON.stringify(st), ContentType: "application/json" }));

// Favorites are one shared list of media keys, kept as a small file in the bucket
const FAVS = "_meta/favorites.json";
const FAVS_V2 = "_meta/favorites-v2/";
const FAVS_READY = FAVS_V2 + "_ready";
const favKey = (mediaKey) => FAVS_V2 + encodeURIComponent(mediaKey);

const legacyFavs = async () => {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key: FAVS }));
    const j = JSON.parse(await r.Body.transformToString());
    return Array.isArray(j) ? [...new Set(j.filter((x) => /^media\/[\w.-]+$/.test(x)))] : [];
  } catch { return []; }
};
const favoritesReady = async () => {
  try { await s3.send(new HeadObjectCommand({ Bucket, Key: FAVS_READY })); return true; }
  catch { return false; }
};
const listFavMarkers = async () => {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: FAVS_V2, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) {
      if (!o || typeof o.Key !== "string" || o.Key === FAVS_READY) continue;
      try {
        const key = decodeURIComponent(o.Key.slice(FAVS_V2.length));
        if (/^media\/[\w.-]+$/.test(key)) out.push(key);
      } catch {}
    }
    token = r.NextContinuationToken;
  } while (token);
  return out;
};
const getFavs = async () => favoritesReady() ? listFavMarkers() : legacyFavs();

const migrateFavs = async () => {
  if (await favoritesReady()) return;
  for (const key of await legacyFavs()) {
    await s3.send(new PutObjectCommand({ Bucket, Key: favKey(key), Body: "", ContentType: "application/octet-stream" }));
  }
  await s3.send(new PutObjectCommand({ Bucket, Key: FAVS_READY, Body: "1", ContentType: "text/plain" }));
};
const setFavs = async (keys, on) => {
  await migrateFavs();
  if (on) {
    await Promise.all(keys.map((key) => s3.send(new PutObjectCommand({ Bucket, Key: favKey(key), Body: "", ContentType: "application/octet-stream" }))));
  } else {
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((key) => ({ Key: favKey(key) })) } }));
  }
};
const dropFavs = async (bases) => {
  await migrateFavs();
  const objects = bases.map((b) => ({ Key: favKey(`media/${b}`) }));
  for (let i = 0; i < objects.length; i += 500) {
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects.slice(i, i + 500) } }));
  }
};

const put = (Key, ContentType, ContentLength) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType, ...(Number.isInteger(ContentLength) ? { ContentLength } : {}) }), { expiresIn: 900 });

module.exports = async (req, res) => {
  if (req.query.action === "ping") {
    return res.json({
      ok: !configProblem(),
      configured: {
        telegram: !!R("BOT_TOKEN") && (E.ALLOWED_USER_IDS || "").split(",").some(s => s.trim()),
        storage: !!(R("R2_ACCOUNT_ID") && R("R2_ACCESS_KEY_ID") && R("R2_SECRET_ACCESS_KEY") && R("R2_BUCKET")),
        browserPin: /^\d{4}$/.test(R("ALBUM_PIN"))
      }
    });
  }
  if (req.method !== "POST") return res.status(405).end();
  const h = req.headers.authorization || "";
  const isTelegram = h.startsWith("tma ");
  const v = isTelegram ? verify(h.slice(4)) : null;
  const user = v && v.user ? v.user : null;
  const browserMode = !isTelegram;
  const allowed = (E.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  if (isTelegram && !user) return res.status(401).json({ error: "unauthorized", reason: v.reason, age: v.age });
  if (isTelegram && !allowed.includes(String(user.id))) return res.status(403).json({ error: "private" });

  const b = req.body || {};
  const PIN = R("ALBUM_PIN"), pinOn = /^\d{4}$/.test(PIN);
  // Telegram sessions are tied to the Telegram account. Browser sessions use a separate subject.
  const subject = browserMode ? "web" : String(user.id);
  const mac = (exp, who = subject) => crypto.createHmac("sha256", `${BOT}:${PIN}`).update(`${who}:${exp}`).digest("hex");
  const makeSession = (exp) => browserMode ? `web.${exp}.${mac(exp, "web")}` : `tg.${user.id}.${exp}.${mac(exp, String(user.id))}`;
  try {
    if (req.query.action === "unlock") {
      if (!pinOn) return browserMode ? res.status(400).json({ error: "browser_password_not_configured" }) : res.json({ session: "", ttl: 0 });
      const guess = String(b.pin || "");
      if (!/^\d{4}$/.test(guess)) return res.status(400).json({ error: "bad pin" });
      const now = Date.now(), st = await getState();
      if (st.lockedUntil > now) return res.status(429).json({ error: "locked_out", wait: Math.ceil((st.lockedUntil - now) / 1000) });
      if (crypto.timingSafeEqual(Buffer.from(guess), Buffer.from(PIN))) {
        if (st.fails) await putState({ fails: 0, lockedUntil: 0 }).catch(() => {});
        const exp = now + 3600 * 1000;
        return res.json({ session: makeSession(exp), ttl: 3600, mode: browserMode ? "web" : "telegram" });
      }
      st.fails = (st.fails || 0) + 1;
      const out = st.fails >= 5;
      await putState(out ? { fails: 0, lockedUntil: now + 15 * 60 * 1000 } : st);
      return out ? res.status(429).json({ error: "locked_out", wait: 900 }) : res.status(401).json({ error: "wrong_pin", left: 5 - st.fails });
    }
    // Telegram access can be authenticated by Telegram alone when no passcode is configured.
    // Browser access always requires a valid one-hour web session.
    const raw = String(req.headers["x-session"] || "");
    let good = false;
    if (browserMode) {
      const [kind, exp, sig = "", ...extra] = raw.split(".");
      if (extra.length === 0 && kind === "web" && /^\d+$/.test(exp) && Number(exp) > Date.now() && /^[0-9a-f]{64}$/.test(sig)) {
        const expected = mac(exp, "web");
        good = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
      }
    } else if (pinOn) {
      const [kind, id, exp, sig = "", ...extra] = raw.split(".");
      if (extra.length === 0 && kind === "tg" && id === String(user.id) && /^\d+$/.test(exp) && Number(exp) > Date.now() && /^[0-9a-f]{64}$/.test(sig)) {
        const expected = mac(exp, String(user.id));
        good = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
      }
    } else {
      // Never allow browser access without an explicitly configured four-digit passcode.
      return res.status(503).json({ error: "browser_password_not_configured", reason: "setup_required" });
    }
    if (!good) return res.status(401).json({ error: "locked", reason: "locked" });

    if (req.query.action === "check") { // reports which settings are missing and whether storage is reachable
      let storage = configProblem() || "ok";
      if (storage === "ok") { try { await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })); } catch { storage = "unreachable"; } }
      return res.json({ configured: {
        telegram: !!R("BOT_TOKEN") && (E.ALLOWED_USER_IDS || "").split(",").some(s => s.trim()),
        storage: !!(R("R2_ACCOUNT_ID") && R("R2_ACCESS_KEY_ID") && R("R2_SECRET_ACCESS_KEY") && R("R2_BUCKET")),
        browserPin: /^\d{4}$/.test(R("ALBUM_PIN"))
      }, storage });
    }

    if (req.query.action === "list") {
      // Paginate only the media namespace. R2 ListObjectsV2 supports opaque continuation
      // tokens, so the client can request the next page without rescanning the whole bucket.
      const pageSize = Math.max(60, Math.min(180, Number(req.query.limit) || 120));
      const cursor = typeof b.cursor === "string" && b.cursor.length <= 2048 ? b.cursor : undefined;
      const r = await s3.send(new ListObjectsV2Command({
        Bucket, Prefix: "media/", ContinuationToken: cursor, MaxKeys: pageSize
      }));
      const mediaObjects = (r.Contents || []).filter(o => o && typeof o.Key === "string" && o.Key.length > 6);

      const kindOf = (base) => (/\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image");
      const itemResults = await each(mediaObjects, async (o) => {
        const base = o.Key.slice(6), tk = `thumbs/${base}.jpg`;
        const type = kindOf(base);
        // Presign the expected thumbnail without a per-item HEAD request. Missing legacy thumbnails
        // fall back to the original only when the browser reports the thumbnail failed to load.
        const thumb = await sign(tk);
        // Video compatibility is resolved only when the user opens the video.
        const playKey = null, compatible = false;
        return {
          key: o.Key,
          playKey,
          size: Number(o.Size) || 0,
          date: (base.startsWith("other-") ? Number(base.split("-")[1]) : Number(base.split("-")[0])) || 0,
          type,
          url: null,
          sourceUrl: null,
          thumb,
          compatible,
          timeline: base.startsWith("other-") ? "other" : "date"
        };
      }, 20);
      const items = itemResults.filter(Boolean);
      items.sort((x, y) => y.date - x.date);

      // Trash/favorites are loaded only on the first page. This keeps subsequent page
      // requests focused on media metadata instead of repeating unrelated work.
      let trash = [], favs = [], storageBytes = 0;
      if (!cursor) {
        // Browser uploads are marked until the client finishes conversion/finalization.
        // If a tab is closed mid-upload, the marker becomes stale and its objects are reclaimed.
        const uploadNow = Date.now(), orphanUploads = [];
        let uploadCursor;
        do {
          const uploadPage = await s3.send(new ListObjectsV2Command({
            Bucket, Prefix: "_uploads/", ContinuationToken: uploadCursor, MaxKeys: 1000
          }));
          for (const o of uploadPage.Contents || []) {
            if (!o || typeof o.Key !== "string" || !o.Key.startsWith("_uploads/")) continue;
            const token = o.Key.slice(9), cut = token.indexOf("~"), at = Number(token.slice(0, cut)), base = cut >= 0 ? token.slice(cut + 1) : "";
            if (at > 0 && /^[\w.-]+$/.test(base) && uploadNow - at > 2 * 3600e3) orphanUploads.push({ token, base });
          }
          uploadCursor = uploadPage.NextContinuationToken;
        } while (uploadCursor);

        for (const upload of orphanUploads) {
          const { token, base } = upload;
          let marker = null;
          try {
            const mr = await s3.send(new GetObjectCommand({ Bucket, Key: "_uploads/" + token }));
            marker = JSON.parse(await mr.Body.transformToString());
          } catch {}
          const valid = marker && marker.key === "media/" + base && /^(image|video)\//.test(String(marker.type || ""));
          const required = valid ? ["media/" + base] : [];
          if (valid && marker.thumb) required.push("thumbs/" + base + ".jpg");
          if (valid && /^video\//.test(marker.type || "")) required.push("compatible-v2/" + base + ".mp4");

          let committed = valid && required.length > 0;
          for (const key of required) {
            try { await s3.send(new HeadObjectCommand({ Bucket, Key: key })); }
            catch { committed = false; break; }
          }

          const cleanup = [
            { Key: "_uploads/" + token },
            { Key: "_staging/" + token + "/media" },
            { Key: "_staging/" + token + "/thumb.jpg" },
            { Key: "_staging/" + token + "/compatible.mp4" }
          ];
          if (valid && !committed) {
            cleanup.push(
              { Key: "media/" + base },
              { Key: "thumbs/" + base + ".jpg" },
              { Key: "compatible-v2/" + base + ".mp4" }
            );
          }
          for (let i = 0; i < cleanup.length; i += 500) {
            await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: cleanup.slice(i, i + 500) } })).catch(() => {});
          }
        }

        const now = Date.now(), stale = [], staleBases = [];
        let trashCursor;
        do {
          const trashPage = await s3.send(new ListObjectsV2Command({
            Bucket, Prefix: "trash/", ContinuationToken: trashCursor, MaxKeys: 1000
          }));
          for (const o of trashPage.Contents || []) {
            if (!o || typeof o.Key !== "string") continue;
            const rest = o.Key.slice(6), cut = rest.indexOf("~"), at = Number(rest.slice(0, cut)), base = rest.slice(cut + 1), tk = `trash-thumbs/${rest}.jpg`;
            if (!(at > 0)) continue;
            if (now - at > 30 * 864e5) {
              stale.push(o.Key, tk, `trash-compatible-v2/${rest}.mp4`, `trash-compatible/${rest}.mp4`, );
              staleBases.push(base);
              continue;
            }
            if (trash.length < 1000) {
              try {
                const url = await sign(o.Key);
                let thumb = null;
                try { thumb = await sign(tk); } catch {}
                trash.push({ key: o.Key, deletedAt: at, date: Number(base.split("-")[0]) || 0, type: kindOf(base), url, thumb });
              } catch {}
            }
          }
          trashCursor = trashPage.NextContinuationToken;
        } while (trashCursor);
        for (let i = 0; i < stale.length; i += 500) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: stale.slice(i, i + 500).map(Key => ({ Key })) } }));
        if (staleBases.length) await dropFavs(staleBases).catch(() => {});
        trash.sort((x, y) => y.deletedAt - x.deletedAt);
        favs = await getFavs().catch(() => []);
      }

      storageBytes = mediaObjects.reduce((n, o) => n + (Number(o.Size) > 0 ? Number(o.Size) : 0), 0);
      return res.json({
        items,
        trash,
        favs,
        storageBytes,
        storagePage: true,
        nextCursor: r.NextContinuationToken || null
      });
    }
    if (req.query.action === "resolve") {
      const key = String(b.key || "");
      const requestedPlayKey = String(b.playKey || "");
      const base = key.slice(6);
      const validMedia = key.startsWith("media/") && /^[\w.-]+$/.test(base);
      const validPlay = !requestedPlayKey || requestedPlayKey === key || requestedPlayKey === "compatible-v2/" + base + ".mp4" || requestedPlayKey === "compatible/" + base + ".mp4";
      if (!validMedia || !validPlay) return res.status(400).json({ error: "bad key" });
      const type = /\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image";
      if (type === "image") return res.json({ url: await sign(key), sourceUrl: null });
      let playKey = key;
      let compatible = false;
      for (const candidate of [`compatible-v2/${base}.mp4`, `compatible/${base}.mp4`]) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket, Key: candidate }));
          playKey = candidate;
          compatible = true;
          break;
        } catch {}
      }
      const [url, sourceUrl] = await Promise.all([sign(playKey), sign(key)]);
      return res.json({ url, sourceUrl, playKey, compatible });
    }
    if (req.query.action === "cleanupUpload") {
      const key = String(b.key || ""), token = String(b.uploadToken || "");
      if (!/^media\/[\w.-]+$/.test(key) || !/^\d+~[\w.-]+$/.test(token) || token.slice(token.indexOf("~") + 1) !== key.slice(6)) return res.status(400).json({ error: "bad key" });
      let marker;
      try {
        const mr = await s3.send(new GetObjectCommand({ Bucket, Key: `_uploads/${token}` }));
        marker = JSON.parse(await mr.Body.transformToString());
      } catch {
        return res.status(409).json({ error: "upload_not_active" });
      }
      if (!marker || marker.key !== key || !/^(image|video)\//.test(String(marker.type || "")) ||
          !Number.isSafeInteger(Number(marker.size)) || Number(marker.size) <= 0) {
        return res.status(409).json({ error: "bad_upload_marker" });
      }
      const objects = [
        { Key: `_uploads/${token}` },
        { Key: `_staging/${token}/media` },
        { Key: `_staging/${token}/compatible.mp4` },
        { Key: `_staging/${token}/thumb.jpg` }
      ];
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects } }));
      return res.json({ done: true });
    }

    if (req.query.action === "upload") {
      const type = String(b.type || "");
      const size = Number(b.size);
      if (!/^(image|video)\//.test(type) || !Number.isSafeInteger(size) || size <= 0 || size > 2e9) return res.status(400).json({ error: "bad file" });
      const name = String(b.name || "file").replace(/[^\w.-]+/g, "_").slice(-60);
      const base = `${Number(b.lastModified) || Date.now()}-${crypto.randomBytes(4).toString("hex")}-${name}`;
      const key = `media/${base}`;
      const uploadToken = `${Date.now()}~${base}`;
      await s3.send(new PutObjectCommand({
        Bucket, Key: `_uploads/${uploadToken}`,
        Body: JSON.stringify({ key, type, size, createdAt: Date.now(), thumb: !!b.thumb }),
        ContentType: "application/json"
      }));
      return res.json({
        key,
        uploadToken,
        url: await put(`_staging/${uploadToken}/media`, type, size),
        thumbUrl: b.thumb ? await put(`_staging/${uploadToken}/thumb.jpg`, "image/jpeg") : null,
        compatibleUrl: /^video\//.test(type) ? await put(`_staging/${uploadToken}/compatible.mp4`, "video/mp4") : null,
      });
    }
    if (req.query.action === "finalizeUpload") {
      const key = String(b.key || ""), token = String(b.uploadToken || "");
      const base = key.slice(6);
      if (!/^media\/[\w.-]+$/.test(key) || !/^\d+~[\w.-]+$/.test(token) || token.slice(token.indexOf("~") + 1) !== base)
        return res.status(400).json({ error: "bad upload" });

      // Finalization is a commit point: require the marker and the original object
      // to agree before removing the recovery marker.
      let marker;
      try {
        const mr = await s3.send(new GetObjectCommand({ Bucket, Key: `_uploads/${token}` }));
        marker = JSON.parse(await mr.Body.transformToString());
      } catch {
        return res.status(409).json({ error: "upload_not_active" });
      }
      if (!marker || marker.key !== key || !/^(image|video)\//.test(String(marker.type || "")) ||
          !Number.isSafeInteger(Number(marker.size)) || Number(marker.size) <= 0) {
        return res.status(409).json({ error: "bad_upload_marker" });
      }

      let original;
      try {
        original = await s3.send(new HeadObjectCommand({ Bucket, Key: `_staging/${token}/media` }));
      } catch {
        return res.status(409).json({ error: "upload_incomplete" });
      }
      if (Number(original.ContentLength) !== Number(marker.size)) {
        return res.status(409).json({ error: "upload_size_mismatch" });
      }

      const markerCreatedAt = Number(marker.createdAt);
      if (!Number.isSafeInteger(markerCreatedAt) || markerCreatedAt <= 0 ||
          markerCreatedAt > Date.now() + 5 * 60e3 || Date.now() - markerCreatedAt > 2 * 3600e3) {
        return res.status(409).json({ error: "upload_expired" });
      }
      if (/^video\//.test(marker.type || "")) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket, Key: `_staging/${token}/compatible.mp4` }));
        } catch {
          return res.status(409).json({ error: "video_conversion_incomplete" });
        }
      }

      const stageMedia = "_staging/" + token + "/media";
      const stageThumb = "_staging/" + token + "/thumb.jpg";
      const stageCompatible = "_staging/" + token + "/compatible.mp4";
      const ensureCommitted = async (from, to, required = true) => {
        let source = true;
        try { await s3.send(new HeadObjectCommand({ Bucket, Key: from })); } catch { source = false; }
        let destination = null;
        try { destination = await s3.send(new HeadObjectCommand({ Bucket, Key: to })); } catch {}
        if (destination) {
          if (source) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: from }] } }));
          return true;
        }
        if (!source) return !required;
        await move(from, to);
        return true;
      };
      if (!await ensureCommitted(stageMedia, key, true)) return res.status(409).json({ error: "upload_incomplete" });
      if (marker.thumb && !await ensureCommitted(stageThumb, "thumbs/" + base + ".jpg", true))
        return res.status(409).json({ error: "thumbnail_incomplete" });
      if (/^video\//.test(marker.type || "") && !await ensureCommitted(stageCompatible, "compatible-v2/" + base + ".mp4", true))
        return res.status(409).json({ error: "video_conversion_incomplete" });
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: "_uploads/" + token }] } }));
      return res.json({ done: true });
    }
    const okMedia = (k) => /^media\/[\w.-]+$/.test(String(k));
    const okTrash = (k) => /^trash\/\d+~[\w.-]+$/.test(String(k));
    const keysOf = (ok) => (Array.isArray(b.keys) ? b.keys : [b.key]).filter(ok).slice(0, 300);

    if (req.query.action === "download") {
      const key = String(b.key || "");
      if (!/^media\/[\w.-]+$/.test(key)) return res.status(400).json({ error: "bad key" });
      const base = key.slice(6);
      const type = /\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image";
      const ext = ((base.match(/\.([^.]+)$/) || [])[1] || "").toLowerCase();
      const videoTypes = { mp4:"video/mp4", mov:"video/quicktime", m4v:"video/x-m4v", webm:"video/webm", "3gp":"video/3gpp", mkv:"video/x-matroska", avi:"video/x-msvideo", mpg:"video/mpeg", mpeg:"video/mpeg" };
      const imageTypes = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", gif:"image/gif", heic:"image/heic", heif:"image/heif" };
      const contentType = (type === "video" ? videoTypes[ext] : imageTypes[ext]) || "application/octet-stream";
      const safeName = base.replace(/[^\w.-]+/g, "_").slice(-120);
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 900 });
      return res.json({ url, name: safeName });
    }

    if (req.query.action === "favorite") { // b.on true adds hearts, false removes them
      const keys = keysOf(okMedia);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      await setFavs(keys, !!b.on);
      return res.json({ done: keys.length });
    }

    if (req.query.action === "delete") { // moves to Recently deleted, kept for 30 days
      const keys = keysOf(okMedia);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const at = Date.now();
      const r = await each(keys, async (k) => {
        const base = k.slice(6);
        await move(k, `trash/${at}~${base}`);
        const thumbMoved = await moveOptional(`thumbs/${base}.jpg`, `trash-thumbs/${at}~${base}.jpg`);
        // Keep generated playback copies with the deleted memory so restoring it restores the full memory.
        const compatibleV2Moved = await moveOptional(`compatible-v2/${base}.mp4`, `trash-compatible-v2/${at}~${base}.mp4`);
        const compatibleMoved = await moveOptional(`compatible/${base}.mp4`, `trash-compatible/${at}~${base}.mp4`);
        if (!thumbMoved || !compatibleV2Moved || !compatibleMoved) {
          console.warn("partial delete companions", { key: k, thumbMoved, compatibleV2Moved, compatibleMoved });
        }
        return { key: k, partial: !thumbMoved || !compatibleV2Moved || !compatibleMoved };
      });
      const results = r.filter(Boolean), partial = results.filter((x) => x.partial).map((x) => x.key);
      return res.json({ done: results.length, partial: partial.length, partialKeys: partial });
    }

    if (req.query.action === "restore") {
      const keys = keysOf(okTrash);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const r = await each(keys, async (k) => {
        const rest = k.slice(6), base = rest.slice(rest.indexOf("~") + 1);
        // Never overwrite an active object (or orphaned companion) during restore.
        const destinations = [`media/${base}`, `thumbs/${base}.jpg`, `compatible-v2/${base}.mp4`, `compatible/${base}.mp4`];
        for (const dest of destinations) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket, Key: dest }));
            throw new Error("restore_destination_exists");
          } catch (e) {
            if (e && e.message === "restore_destination_exists") throw e;
          }
        }
        await move(k, `media/${base}`);
        const thumbMoved = await moveOptional(`trash-thumbs/${rest}.jpg`, `thumbs/${base}.jpg`);
        const compatibleV2Moved = await moveOptional(`trash-compatible-v2/${rest}.mp4`, `compatible-v2/${base}.mp4`);
        const compatibleMoved = await moveOptional(`trash-compatible/${rest}.mp4`, `compatible/${base}.mp4`);
        if (!thumbMoved || !compatibleV2Moved || !compatibleMoved) {
          console.warn("partial restore companions", { key: k, thumbMoved, compatibleV2Moved, compatibleMoved });
        }
        return { key: k, partial: !thumbMoved || !compatibleV2Moved || !compatibleMoved };
      });
      const results = r.filter(Boolean), partial = results.filter((x) => x.partial).map((x) => x.key);
      return res.json({ done: results.length, partial: partial.length, partialKeys: partial });
    }

    if (req.query.action === "erase") { // delete forever
      const keys = keysOf(okTrash);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const eraseObjects = [];
      for (const k of keys) {
        const rest = k.slice(6), cut = rest.indexOf("~"), base = cut >= 0 ? rest.slice(cut + 1) : rest;
        eraseObjects.push(
          { Key: k },
          { Key: `trash-thumbs/${rest}.jpg` },
          { Key: `trash-compatible-v2/${rest}.mp4` },
          { Key: `trash-compatible/${rest}.mp4` }
        );
      }
      for (let i = 0; i < eraseObjects.length; i += 500) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: eraseObjects.slice(i, i + 500) } }));
      await dropFavs(keys.map((k) => k.slice(6).slice(k.slice(6).indexOf("~") + 1))).catch(() => {});
      return res.json({ done: keys.length });
    }
    res.status(400).json({ error: "bad action" });
  } catch (e) {
    console.error("media API error", req.query.action, e && e.stack || e);
    res.status(500).json({ error: "server", action: req.query.action || "unknown" });
  }
};
