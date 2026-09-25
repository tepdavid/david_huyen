# Our Memories: private Telegram Mini App + web app

Use a NEW bot and a NEW Vercel project. Don't reuse the coffee shop bot.

## 1. Bot
In @BotFather: `/newbot`, then `/newapp` and set the URL to your new Vercel domain. Keep the token secret.

## 2. Find both Telegram ids
Each of you messages @userinfobot. It replies with a numeric id.

## 3. Storage (Cloudflare R2)
1. Cloudflare dashboard, R2, Create bucket (keep it private, no public access).
2. R2, Manage API tokens, create a token with Object Read & Write on that bucket. Save the Access Key ID and Secret.
3. Bucket, Settings, CORS policy:
```
[{
  "AllowedOrigins": ["https://YOUR-PROJECT.vercel.app"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3600
}]
```

## 4. Vercel
Import this folder as a project (Framework: Other), then add these Environment Variables:
`BOT_TOKEN`, `ALLOWED_USER_IDS` (e.g. `111111,222222`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
Deploy, then open `t.me/YOUR_BOT/APP_NAME` and send that link only to her.

## Access: Telegram or web browser
There are two ways to open the same private memories:

1. **Telegram:** open the Mini App from `t.me/YOUR_BOT/APP_NAME`. Telegram signature validation and `ALLOWED_USER_IDS` protect the account.
2. **Web browser:** open the Vercel project URL directly in Chrome, Safari, Edge, etc. The browser uses the `ALBUM_PIN` passcode to create a one-hour private web session.

The Telegram and browser paths use the same private R2 storage and the same photos/videos. Telegram is not required for browser access.

## Privacy
- Telegram access is limited to the ids in `ALLOWED_USER_IDS`.
- Browser access requires the `ALBUM_PIN`; five wrong attempts lock the shared passcode for 15 minutes.
- The browser session expires after 1 hour and is separate from Telegram sessions.
- The bucket is private. Photos load through signed links that expire after 1 hour.
- Files are stored on Cloudflare, not end-to-end encrypted. Don't put anything there you wouldn't trust a cloud provider with.
- Keep backups of originals. Deleting in the app deletes for everyone using the same storage.

## Passcode (4 digits)
Set `ALBUM_PIN` in Vercel to exactly four digits, for example `4826`, then redeploy.
- It is used for browser access and as an additional lock inside Telegram.
- The app asks for it when opening and after it has been in the background for a minute.
- The server checks it, so it cannot be skipped by editing the web page.
- To change it, edit `ALBUM_PIN` and redeploy; existing sessions are invalidated by the new signature.
- Browser access requires `ALBUM_PIN` to be configured. Telegram can still work without it, using Telegram authentication alone.
