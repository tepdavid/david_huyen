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
  if (!Number.isFinite(age) || age < -300) return { reason: "invalid_auth_date", age };
  if (age > 604800) return { reason: "expired", age }; // 7 days: only the two allowed accounts can pass anyway
  try { return { user: JSON.parse(p.get("user")) }; } catch { return { reason: "no_initdata" }; }
}

const sign = (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
const enc = (k) => encodeURIComponent(k); // CopySource must be URL-encoded, including slashes in the object key
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