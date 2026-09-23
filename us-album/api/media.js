// POST /api/media?action=list|upload|delete
// Env: BOT_TOKEN, ALLOWED_USER_IDS (comma-separated Telegram ids), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
const crypto = require("crypto");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const E = process.env, Bucket = E.R2_BUCKET;
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED", // keeps presigned PUTs compatible with R2
});

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
const put = (Key, ContentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 900 });

module.exports = async (req, res) => {
  if (req.query.action === "ping") { // open /api/media?action=ping in a browser to confirm what is deployed
    const tk = (E.BOT_TOKEN || "").trim().replace(/^["']+|["']+$/g, "");
    return res.json({ version: 3, hasToken: !!tk, botId: tk.split(":")[0] || null, tokenLength: tk.length,
      allowedIds: (E.ALLOWED_USER_IDS || "").split(",").filter((s) => s.trim()).length,
      hasStorage: !!(E.R2_ACCOUNT_ID && E.R2_ACCESS_KEY_ID && E.R2_SECRET_ACCESS_KEY && E.R2_BUCKET) });
  }
  if (req.method !== "POST") return res.status(405).end();
  const h = req.headers.authorization || "";
  const v = h.startsWith("tma ") ? verify(h.slice(4)) : { reason: "no_initdata" };
  if (!v.user) return res.status(401).json({ error: "unauthorized", reason: v.reason, age: v.age });
  const user = v.user;
  const allowed = (E.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  if (!allowed.includes(String(user.id))) return res.status(403).json({ error: "private" });

  const b = req.body || {};
  try {
    if (req.query.action === "check") { // reports which settings are missing and whether storage is reachable
      const env = Object.fromEntries(["BOT_TOKEN", "ALLOWED_USER_IDS", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map((k) => [k, !!E[k]]));
      let storage = "ok";
      try { await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 })); } catch (e) { storage = `${e.name}: ${e.message}`; }
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
      const items = await Promise.all(all.filter((o) => o.Key.startsWith("media/")).map(async (o) => {
        const base = o.Key.slice(6), tk = `thumbs/${base}.jpg`;
        return {
          key: o.Key, size: o.Size, date: Number(base.split("-")[0]) || 0,
          type: /\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpe?g)$/i.test(base) ? "video" : "image",
          url: await sign(o.Key), thumb: have.has(tk) ? await sign(tk) : null,
        };
      }));
      items.sort((x, y) => y.date - x.date);
      return res.json({ items });
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

    if (req.query.action === "delete") {
      if (!/^media\/[\w.-]+$/.test(String(b.key))) return res.status(400).json({ error: "bad key" });
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: b.key }, { Key: `thumbs/${b.key.slice(6)}.jpg` }] } }));
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "bad action" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server" });
  }
};
