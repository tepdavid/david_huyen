// POST /api/media?action=list|upload|delete
// Env: BOT_TOKEN, ALLOWED_USER_IDS (comma-separated Telegram ids), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
const crypto = require("crypto");
const { S3Client, ListObjectsV2Command, CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
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
  if (age > 604800) return { reason: "expired", age }; // 7 days: only the two allowed accounts can pass anyway
  try { return { user: JSON.parse(p.get("user")) }; } catch { return { reason: "no_initdata" }; }
}

const sign = (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
const enc = (k) => encodeURIComponent(k).replace(/%2F/g, "/");
// Copy first, delete the original only if the copy worked, so a failure never loses a file
const move = async (from, to) => {
  await s3.send(new CopyObjectCommand({ Bucket, CopySource: `${Bucket}/${enc(from)}`, Key: to }));
  await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: from }] } }));
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
const getFavs = async () => {
  try { const r = await s3.send(new GetObjectCommand({ Bucket, Key: FAVS })); const j = JSON.parse(await r.Body.transformToString()); return Array.isArray(j) ? j : []; }
  catch (e) { if (e.name === "NoSuchKey" || (e.$metadata && e.$metadata.httpStatusCode === 404)) return []; throw e; } // never treat a failed read as "no favorites"
};
const putFavs = (a) => s3.send(new PutObjectCommand({ Bucket, Key: FAVS, Body: JSON.stringify(a), ContentType: "application/json" }));
const dropFavs = async (bases) => { // forget favorites of files that were erased for good
  const gone = new Set(bases.map((b) => `media/${b}`)), cur = await getFavs(), keep = cur.filter((k) => !gone.has(k));
  if (keep.length !== cur.length) await putFavs(keep);
};

const put = (Key, ContentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 900 });

module.exports = async (req, res) => {
  if (req.query.action === "ping") { // open /api/media?action=ping in a browser to confirm what is deployed
    const tk = (E.BOT_TOKEN || "").trim().replace(/^["']+|["']+$/g, "");
    return res.json({ version: 7, pinSet: /^\d{4}$/.test(R("ALBUM_PIN")), problem: configProblem() || "none", hasToken: !!tk, botId: tk.split(":")[0] || null, tokenLength: tk.length,
      allowedIds: (E.ALLOWED_USER_IDS || "").split(",").filter((s) => s.trim()).length,
      hasStorage: !!(R("R2_ACCOUNT_ID") && R("R2_ACCESS_KEY_ID") && R("R2_SECRET_ACCESS_KEY") && R("R2_BUCKET")),
      bucket: Bucket, accountIdOk: /^[0-9a-f]{32}$/i.test(ACCT),
      lengths: { accountId: ACCT.length, accessKeyId: R("R2_ACCESS_KEY_ID").length, secret: R("R2_SECRET_ACCESS_KEY").length } });
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
      const [kind, exp, sig = ""] = raw.split(".");
      good = kind === "web" && Number(exp) > Date.now() && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac(exp, "web")));
    } else if (pinOn) {
      const [kind, id, exp, sig = ""] = raw.split(".");
      good = kind === "tg" && id === String(user.id) && Number(exp) > Date.now() && sig.length === 64 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac(exp, String(user.id))));
    } else good = true;
    if (!good) return res.status(401).json({ error: "locked", reason: "locked" });

    if (req.query.action === "check") { // reports which settings are missing and whether storage is reachable
      const env = Object.fromEntries(["BOT_TOKEN", "ALLOWED_USER_IDS", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map((k) => [k, !!E[k]]));
      let storage = configProblem() || "ok";
      if (storage === "ok") { try { await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })); } catch (e) { storage = `${e.name}: ${e.message}`; } }
      return res.json({ env, storage });
    }

    if (req.query.action === "list") {
      const all = []; let tok;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken: tok }));
        all.push(...(r.Contents || []));
        tok = r.NextContinuationToken;
      } while (tok);
      const have = new Set(all.map((o) => o.Key));
      const kindOf = (base) => (/\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image");
      const items = await Promise.all(all.filter((o) => o.Key.startsWith("media/")).map(async (o) => {
        const base = o.Key.slice(6), tk = `thumbs/${base}.jpg`, compatible = `compatible/${base}.mp4`;
        const type = kindOf(base);
        // Prefer a browser-friendly H.264/AAC MP4 when a compatible copy has been created.
        const playKey = type === "video" && have.has(compatible) ? compatible : o.Key;
        return { key: o.Key, size: o.Size, date: Number(base.split("-")[0]) || 0, type, url: await sign(playKey), thumb: have.has(tk) ? await sign(tk) : null, compatible: playKey !== o.Key };
      }));
      items.sort((x, y) => y.date - x.date);
      // Recently deleted lives under trash/<deletedAt>~<name>. Anything older than 30 days is erased here.
      const now = Date.now(), stale = [], staleBases = [], trash = [];
      for (const o of all.filter((o) => o.Key.startsWith("trash/"))) {
        const rest = o.Key.slice(6), cut = rest.indexOf("~"), at = Number(rest.slice(0, cut)), base = rest.slice(cut + 1), tk = `trash-thumbs/${rest}.jpg`;
        if (!(at > 0)) continue;
        if (now - at > 30 * 864e5) { stale.push(o.Key, tk); staleBases.push(base); continue; }
        trash.push({ key: o.Key, deletedAt: at, date: Number(base.split("-")[0]) || 0, type: kindOf(base), url: await sign(o.Key), thumb: have.has(tk) ? await sign(tk) : null });
      }
      for (let i = 0; i < stale.length; i += 500) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: stale.slice(i, i + 500).map((Key) => ({ Key })) } }));
      if (staleBases.length) await dropFavs(staleBases).catch(() => {});
      trash.sort((x, y) => y.deletedAt - x.deletedAt);
      const favs = (await getFavs().catch(() => [])).filter((k) => have.has(k));
      return res.json({ items, trash, favs });
    }

    if (req.query.action === "upload") {
      const type = String(b.type || "");
      if (!/^(image|video)\//.test(type) || !(b.size > 0 && b.size <= 2e9)) return res.status(400).json({ error: "bad file" });
      const name = String(b.name || "file").replace(/[^\w.-]+/g, "_").slice(-60);
      const base = `${Number(b.lastModified) || Date.now()}-${crypto.randomBytes(4).toString("hex")}-${name}`;
      return res.json({
        key: `media/${base}`,
        url: await put(`media/${base}`, type),
        thumbUrl: b.thumb ? await put(`thumbs/${base}.jpg`, "image/jpeg") : null,
      });
    }

    const okMedia = (k) => /^media\/[\w.-]+$/.test(String(k));
    const okTrash = (k) => /^trash\/\d+~[\w.-]+$/.test(String(k));
    const keysOf = (ok) => (Array.isArray(b.keys) ? b.keys : [b.key]).filter(ok).slice(0, 300);

    if (req.query.action === "download") {
      const key = String(b.key || "");
      if (!/^media\/[\w.-]+$/.test(key)) return res.status(400).json({ error: "bad key" });
      const base = key.slice(6);
      const type = /\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image";
      const contentType = type === "video" ? ({mp4:"video/mp4",mov:"video/quicktime",m4v:"video/x-m4v",webm:"video/webm",3gp:"video/3gpp",mkv:"video/x-matroska",avi:"video/x-msvideo",mpg:"video/mpeg",mpeg:"video/mpeg"}[(base.match(/\.([^.]+)$/)||[])[1]?.toLowerCase()] || "application/octet-stream") : ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",heic:"image/heic",heif:"image/heif"}[(base.match(/\.([^.]+)$/)||[])[1]?.toLowerCase()] || "application/octet-stream");
      const safeName = base.replace(/[^\w.-]+/g, "_").slice(-120);
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 900 });
      return res.json({ url, name: safeName });
    }

    if (req.query.action === "favorite") { // b.on true adds hearts, false removes them
      const keys = keysOf(okMedia);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const cur = new Set(await getFavs());
      keys.forEach((k) => (b.on ? cur.add(k) : cur.delete(k)));
      await putFavs([...cur]);
      return res.json({ done: keys.length });
    }

    if (req.query.action === "delete") { // moves to Recently deleted, kept for 30 days
      const keys = keysOf(okMedia);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const at = Date.now();
      const r = await each(keys, async (k) => {
        const base = k.slice(6);
        await move(k, `trash/${at}~${base}`);
        await move(`thumbs/${base}.jpg`, `trash-thumbs/${at}~${base}.jpg`).catch(() => {}); // a missing thumbnail is fine
        return 1;
      });
      return res.json({ done: r.filter(Boolean).length });
    }

    if (req.query.action === "restore") {
      const keys = keysOf(okTrash);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      const r = await each(keys, async (k) => {
        const rest = k.slice(6), base = rest.slice(rest.indexOf("~") + 1);
        await move(k, `media/${base}`);
        await move(`trash-thumbs/${rest}.jpg`, `thumbs/${base}.jpg`).catch(() => {});
        return 1;
      });
      return res.json({ done: r.filter(Boolean).length });
    }

    if (req.query.action === "erase") { // delete forever
      const keys = keysOf(okTrash);
      if (!keys.length) return res.status(400).json({ error: "bad key" });
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.flatMap((k) => [{ Key: k }, { Key: `trash-thumbs/${k.slice(6)}.jpg` }]) } }));
      await dropFavs(keys.map((k) => k.slice(6).slice(k.slice(6).indexOf("~") + 1))).catch(() => {});
      return res.json({ done: keys.length });
    }
    res.status(400).json({ error: "bad action" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server" });
  }
};
