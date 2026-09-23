# Our Album: private Telegram Mini App

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

## Privacy
- Only the Telegram ids in `ALLOWED_USER_IDS` can list, view, upload or delete. Everyone else sees "This album is private."
- The bucket is private. Photos load through links that expire after 1 hour.
- Files are stored on Cloudflare, not end-to-end encrypted. Don't put anything there you wouldn't trust a cloud provider with.
- Keep backups of originals. Deleting in the app deletes for both of you.
