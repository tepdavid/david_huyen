# Repair black / audio-only videos

Some MOV/MP4 files use HEVC/H.265 or another codec that a browser/webview can decode only partially (for example, audio plays while the picture is black). The app now prefers a browser-compatible H.264/AAC copy when one exists.

For videos that are already in R2, run this locally on a computer with **FFmpeg** installed:

```bash
node repair-videos.js
```

Set these environment variables first:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`

The script does **not** replace or delete originals. It creates `compatible-v2/<original-name>.mp4`. The app automatically prefers that copy for playback and still supports the legacy `compatible/` path.

New videos imported with `bulk-upload.js` also get a compatible copy automatically when FFmpeg is available.
