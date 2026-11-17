# Reminder server

Sends phone notifications for the Navy Separation Planner: 7 days before and on the
day each belled checklist item is due, at 9 a.m. in the sailor's time zone.

It runs on Cloudflare Workers' free plan:

- **Storage:** a SQLite-backed Durable Object.
- **Schedule:** an hourly cron trigger.

It stores only what's needed to send a notification:

- the browser's push address and keys
- the time zone
- the titles and dates of belled items

It stores no names, bases or notes. Records are deleted when a sailor turns
notifications off, when the phone's push address stops working, or after
800 days without an update.

## Deploy (one time)

1. Create a free account at dash.cloudflare.com.
2. Go to **Workers & Pages → Create → Import a repository**. Connect GitHub and pick
   `navy-separation-planner`.
3. Leave the build command empty. The deploy command is `npx wrangler deploy`.
   The `wrangler.toml` at the top of the project points Cloudflare at this folder, so
   the root directory can be left blank or set to `worker`; both work.
4. Deploy. Cloudflare shows the Worker's address, for example
   `https://navy-separation-planner.<your-subdomain>.workers.dev`.
5. Put that address in `REMINDER_API` near the top of the script in `index.html`, and
   push. The bells and the "Phone notifications" card appear once it's set.

After that, every push to `worker/` redeploys automatically.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/key` | Public key the app uses to subscribe. The key pair is created on first use and kept in storage. |
| POST | `/subscribe` | `{subscription, tz, reminders: [{id, title, date}]}`. Saves or replaces this device's reminders. |
| POST | `/unsubscribe` | `{endpoint}`. Deletes this device's record. |
| POST | `/test` | `{endpoint}`. Sends a test notification. |

Only `https://tnepalmer.github.io` may call it from a browser (`ALLOWED_ORIGINS` in
`wrangler.toml`).
