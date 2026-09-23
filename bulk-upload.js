// Bulk-upload a folder of photos and videos from your PC into the album's R2 bucket.
// Usage:  node bulk-upload.js "C:\Users\YourName\Pictures\Us"
// Env:    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Photo dates come from the EXIF "date taken" when present, otherwise the file's modified date,
// so they land in the right month of the timeline. Safe to re-run: finished files are skipped.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const sharp = require("sharp"), exifr = require("exifr");

const E = process.env, root = process.argv[2];
if (!root || !fs.existsSync(root)) { console.error('Give an existing folder, e.g. node bulk-upload.js "C:\\Users\\me\\Pictures\\Us"'); process.exit(1); }
for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) if (!E[k]) { console.error("Missing env var " + k); process.exit(1); }

const s3 = new S3Client({
  region: "auto", endpoint: `https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: E.R2_ACCESS_KEY_ID, secretAccessKey: E.R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
});
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", "3gp": "video/3gpp", mkv: "video/x-matroska", avi: "video/x-msvideo" };
const logFile = path.join(__dirname, ".uploaded.json");
const done = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : {};

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const send = (Key, Body, ContentType) => new Upload({ client: s3, params: { Bucket: E.R2_BUCKET, Key, Body, ContentType } }).done();

async function thumb(file, video) {
  try {
    if (!video) return await sharp(file).rotate().resize(400).jpeg({ quality: 80 }).toBuffer();
    const tmp = path.join(require("os").tmpdir(), "us-thumb.jpg");
    execFileSync("ffmpeg", ["-y", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale=400:-2", tmp], { stdio: "ignore" });
    return fs.readFileSync(tmp);
  } catch { return null; } // no thumbnail (HEIC, or ffmpeg not installed): the app still works
}

(async () => {
  const files = walk(root).filter(f => TYPES[path.extname(f).slice(1).toLowerCase()]);
  console.log(`Found ${files.length} photos and videos`);
  let ok = 0, skipped = 0, failed = 0;
  for (const [n, f] of files.entries()) {
    const st = fs.statSync(f), sig = `${f}|${st.size}|${st.mtimeMs}`;
    if (done[sig]) { skipped++; continue; }
    const type = TYPES[path.extname(f).slice(1).toLowerCase()], video = type.startsWith("video");
    try {
      let ts = st.mtimeMs;
      if (!video) { try { const x = await exifr.parse(f, ["DateTimeOriginal"]); if (x && x.DateTimeOriginal) ts = +x.DateTimeOriginal; } catch {} }
      const base = `${Math.round(ts)}-${crypto.randomBytes(4).toString("hex")}-${path.basename(f).replace(/[^\w.-]+/g, "_").slice(-60)}`;
      await send("media/" + base, fs.createReadStream(f), type);
      const t = await thumb(f, video);
      if (t) await send(`thumbs/${base}.jpg`, t, "image/jpeg");
      done[sig] = true; fs.writeFileSync(logFile, JSON.stringify(done)); ok++;
      console.log(`[${n + 1}/${files.length}] ${path.basename(f)}`);
    } catch (e) { failed++; console.error(`Failed: ${f} (${e.message})`); }
  }
  console.log(`Done. Uploaded ${ok}, skipped ${skipped}, failed ${failed}.`);
})();
