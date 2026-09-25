// Create browser-compatible copies for videos already stored in R2.
// Usage: node repair-videos.js
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
const fs = require("fs"), path = require("path"), crypto = require("crypto"), os = require("os"), { execFileSync } = require("child_process");
const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const E = process.env;
for (const k of ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"]) if (!E[k]) { console.error("Missing env var " + k); process.exit(1); }
const s3 = new S3Client({ region:"auto", endpoint:`https://${E.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials:{accessKeyId:E.R2_ACCESS_KEY_ID,secretAccessKey:E.R2_SECRET_ACCESS_KEY}, requestChecksumCalculation:"WHEN_REQUIRED" });
const send = (Key, Body) => s3.send(new PutObjectCommand({Bucket:E.R2_BUCKET,Key,Body,ContentType:"video/mp4"}));
const isVideo = k => /\.(mp4|mov|m4v|webm|3gp|mkv|avi|mpeg|mpg)$/i.test(k);
(async()=>{
  let token, n=0, fixed=0;
  do {
    const r=await s3.send(new ListObjectsV2Command({Bucket:E.R2_BUCKET,ContinuationToken:token})); token=r.NextContinuationToken;
    for(const o of r.Contents||[]) {
      if(!o.Key.startsWith("media/") || !isVideo(o.Key.slice(6))) continue;
      const base=o.Key.slice(6), out=`compatible/${base}.mp4`; n++;
      try { await s3.send(new HeadObjectCommand({Bucket:E.R2_BUCKET,Key:out})); console.log(`OK  ${base}`); continue; } catch {}
      const tmpIn=path.join(os.tmpdir(),`in-${crypto.randomBytes(5).toString("hex")}`), tmpOut=path.join(os.tmpdir(),`out-${crypto.randomBytes(5).toString("hex")}.mp4`);
      try {
        const r2=await s3.send(new GetObjectCommand({Bucket:E.R2_BUCKET,Key:o.Key}));
        const out=fs.createWriteStream(tmpIn);
        await new Promise((resolve,reject)=>{ r2.Body.pipe(out); out.on("finish",resolve); out.on("error",reject); r2.Body.on("error",reject); });
        execFileSync("ffmpeg",["-y","-i",tmpIn,"-map","0:v:0","-map","0:a?","-c:v","libx264","-preset","veryfast","-crf","22","-pix_fmt","yuv420p","-movflags","+faststart","-c:a","aac","-b:a","128k",tmpOut],{stdio:"ignore"});
        await send(out,fs.createReadStream(tmpOut)); fixed++; console.log(`FIX ${base}`);
      } catch(e) { console.error(`ERR ${base}: ${e.message}`); }
      finally { try{fs.unlinkSync(tmpIn)}catch{} try{fs.unlinkSync(tmpOut)}catch{} }
    }
  } while(token);
  console.log(`Done. Checked ${n} videos, created ${fixed} browser-compatible copies.`);
})().catch(e=>{console.error(e);process.exit(1)});
