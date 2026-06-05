# Plate — your cross-device food log

Snap a photo of a meal, Claude breaks it into its parts with calories for each,
you confirm, and it's saved to a log that syncs live across your phone and
computer. Photos are used only for the estimate and then discarded.

This is a real app you host yourself. Day-to-day it's effortless; the one-time
setup below takes about 20–30 minutes and uses two free services plus your own
Anthropic API key (a few cents of usage per day for personal use).

## What's in this folder

```
index.html              The whole app (no build step)
api/estimate.js         Tiny server function that holds your API key + runs estimates
schema.sql              Database tables to paste into Supabase
manifest.webmanifest    Makes it installable on your phone
sw.js  icon.svg         PWA support
vercel.json  .env.example
```

## Step 1 — Create the database (Supabase, free)

1. Go to https://supabase.com, sign up, and create a new project. Pick any
   name and a database password (you won't need the password again).
2. When it's ready, open **SQL Editor → New query**, paste the entire contents
   of `schema.sql`, and click **Run**. You should see "Success".
3. Open **Authentication → Sign In / Providers** and make sure **Email** is
   enabled. For the fastest start, turn **Confirm email** OFF (you can turn it
   back on later). If you leave it on, you'll get a confirmation email on signup.
4. Open **Project Settings → API** and copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string)

## Step 2 — Get an Anthropic API key

1. Go to https://console.anthropic.com → **API Keys → Create Key**, and copy it.
2. Add a little credit under **Billing** (a few dollars lasts a long time for
   personal use). Keep this key secret — it goes on the server only, never in
   `index.html`.

## Step 3 — Put your Supabase keys into the app

Open `index.html`, find the `CONFIG` block near the top of the `<script>`, and
paste in your two Supabase values:

```js
const CONFIG = {
  SUPABASE_URL: "https://abcd1234.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...your anon key...",
  ESTIMATE_URL: "/api/estimate",
};
```

(The anon key is meant to be public — your data is still protected because the
database only lets each user read their own rows.)

## Step 4 — Deploy (Vercel, free)

The easiest path uses a GitHub repo:

1. Create a free account at https://github.com and a new **empty** repository.
2. Upload this whole folder to it (GitHub's web UI has **Add file → Upload
   files** — drag everything in, including the `api` folder).
3. Go to https://vercel.com, sign up with GitHub, click **Add New → Project**,
   and import that repository. Framework preset: **Other**. Click **Deploy**.
4. In the Vercel project, open **Settings → Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_ANON_KEY` = your Supabase anon key
   Then **Redeploy** (Deployments → ⋯ → Redeploy) so the keys take effect.

Vercel gives you a URL like `https://plate-xxxx.vercel.app`. That's your app.

> Prefer no GitHub? Install Node, run `npm i -g vercel`, then run `vercel` inside
> this folder and follow the prompts. Add the env vars with
> `vercel env add ANTHROPIC_API_KEY` (etc.), then `vercel --prod`.

## Step 5 — Use it on both devices

1. Open your Vercel URL on your **computer**, create an account, set your
   profile on the **You** tab, and log a meal.
2. Open the same URL on your **phone's** browser and sign in with the same
   email/password. Your log is already there, and new entries sync live.
3. Install it like a native app:
   - **iPhone (Safari):** Share → **Add to Home Screen**.
   - **Android (Chrome):** menu → **Install app** / **Add to Home screen**.

If you turned email confirmation ON in Step 1.3, also set
**Authentication → URL Configuration → Site URL** in Supabase to your Vercel URL
so the confirmation link returns to your app.

## Notes

- **Costs:** Supabase and Vercel free tiers are plenty for personal use. You
  only pay Anthropic per estimate — typically pennies a day.
- **Estimates:** the model breaks each meal into components with calories and
  macros; you can edit any line or add/remove parts before saving. Swap models
  with the `ESTIMATE_MODEL` env var (`claude-haiku-4-5-20251001` is cheaper).
- **Backups:** the **You** tab has Export/Import (a JSON file) if you ever want
  a copy or to move accounts.
- **Privacy/security:** the API key lives only on Vercel. The function checks
  that requests come from a signed-in user before spending credits.
- **Updating the app:** edit the files, push to GitHub (or re-run `vercel`),
  and it redeploys. Your data is in Supabase, so it's untouched by redeploys —
  no data loss, unlike the published-artifact approach.
