# Secret Santa

**This deployment**

| | |
| --- | --- |
| Site | https://lukecamels.github.io/secret-santa/ |
| Run the draw | https://lukecamels.github.io/secret-santa/admin.html |
| API | https://secret-santa-api.secret-santa-api.workers.dev |

The API address is pre-filled on the setup page, so there's nothing to paste.
The doubled name is not a typo: Cloudflare took the account-wide `workers.dev`
subdomain from the first Worker deployed to it, and the Worker is also called
`secret-santa-api`. Changing it is cosmetic only, under Workers &rarr; Subdomain.

---

A public website that runs a family Secret Santa without ever revealing anything
to the public — or to the people running it. Names, assignments, wishlists and
messages are all encrypted in the browser. The published files and the API server
hold nothing but salts, hashes and ciphertext.

- **Site** — static, hosted on GitHub Pages.
- **API** — one small Cloudflare Worker, for the bits a static site can't do
  (saving a wishlist, sending a message).

---

## How the privacy works

Every participant gets a random 100-bit access token, shown once at setup and
never stored anywhere.

`data/santa.json` is published in your repo. For each person it holds one entry:

| Published | What it is |
| --- | --- |
| the key | `SHA-256(salt + token)` — meaningless without the token |
| the value | an AES-256-GCM blob, unlocked by a key derived from the token with PBKDF2 |

Inside a decrypted blob: your own name, the name of the person you're buying for,
and the keys to two **mailboxes** — your own, and theirs.

A mailbox holds one person's wishlist and the message thread with their Santa.
It's encrypted under a key held by exactly two people: the owner and their Santa.
So:

- Your Santa can read your wishlist and write to you. You can write back.
- You never learn who they are — the site simply never has that information on
  your side of the wall.
- The Worker stores the blobs and can't read any of them.
- Anyone who opens the repo, or the Worker's storage, sees random-looking strings.

No email addresses, no names, no assignment table is stored anywhere in the clear.

### What this does *not* protect against

Worth knowing before you rely on it:

- **The published file leaks the headcount.** Anyone can count the entries and
  know how many people are taking part. Nothing more.
- **Whoever runs the setup page could cheat.** The draw happens in their browser,
  so a determined organiser could inspect it. The page never shows the
  assignments, so it takes deliberate effort — but it isn't impossible. If that
  matters, have someone outside the draw run the setup.
- **Writing style gives people away.** The cryptography is airtight; "hey mate,
  what size are ya" is not.
- **Lose the token, lose the account.** There is no reset, by design. The fix is
  to re-run the draw, which changes everything for everyone.
- **A stolen token is that person's account.** Treat the slips like you'd treat a
  door key.

---

## Setup

### 1. Publish the site

1. Create a **new, empty GitHub repository** — public is fine, that's the point.
2. Copy the contents of this folder into it, commit and push.
3. In the repo: **Settings → Pages → Build and deployment**, source **Deploy from
   a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute, the site is live at
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

It'll say the Secret Santa hasn't been set up yet. That's correct — nothing has
been drawn.

### 2. Deploy the Worker

You need a free Cloudflare account. No card, no domain.

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create SANTA_KV
```

That last command prints an `id`. Open `wrangler.toml` and:

- paste the `id` over `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`
- set `DATA_URL` to `https://YOUR-USERNAME.github.io/YOUR-REPO/data/santa.json`
- set `ALLOWED_ORIGINS` to `https://YOUR-USERNAME.github.io`

Then set up the notification email and deploy:

```bash
npx wrangler secret put NOTIFY_EMAIL
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

`RESEND_API_KEY` comes from a free [resend.com](https://resend.com) account —
100 emails a day, far more than this needs. Without your own domain, Resend will
only deliver to the address you signed up with, which is exactly the setup you
want here: one address, yours.

Deploy prints a URL like `https://secret-santa-api.your-name.workers.dev`. Check
it works:

```bash
curl https://secret-santa-api.your-name.workers.dev/health
```

**Prefer no email at all?** Skip both secrets and set `NOTIFY_WEBHOOK_URL`
instead — a Discord or Slack webhook, or an [ntfy.sh](https://ntfy.sh) topic.
Same nudge, different channel. Or set nothing, and everyone just checks the site.

### 3. Run the draw

Open `https://YOUR-USERNAME.github.io/YOUR-REPO/admin.html`.

It's a public URL, but there's nothing to steal: it holds no data and does
nothing until someone types names in. Everything it computes stays in that tab.

1. Enter the event name and paste in the Worker URL.
2. Add everyone. You can paste a whole list, one name per line.
3. Link the pairs who mustn't get each other. Each link works both ways.
4. Leave **one single chain** ticked unless you have a reason not to — it stops
   two people being each other's Santa.
5. **Run the draw.**

Then, without closing the tab:

- **Download `santa.json`**, drop it into `data/` in your repo replacing the
  placeholder, commit and push.
- **Copy the links** (or the codes, or print the slips). This is the only time
  they are ever shown. They can't be recovered from the published file.

Send each person their own link and they're in on one tap.

Allow a couple of minutes between pushing `santa.json` and the first sign-in:
GitHub's CDN takes about thirty seconds to serve the new file and the Worker
caches the mailbox list for sixty seconds on top of that. A token that doesn't
work straight away usually just needs another minute.

### Sign-in links

A link looks like `https://…/secret-santa/#t=XXXXX-XXXXX-XXXXX-XXXXX`.

The token sits after the `#`, which matters: browsers never send the fragment to
the server. It stays out of GitHub's request logs, out of `Referer` headers, and
out of the preview fetch a messaging app makes when it renders the link. The page
wipes it from the address bar the moment it reads it, so it doesn't linger on
screen or in a screenshot.

A link is exactly as powerful as the code inside it &mdash; it *is* the code. Send
each person only their own, the same way you'd hand over a key. If the page is
already open, tapping a link still works; it switches accounts and cleans the
address bar just like a fresh visit.

Already ran the draw and only kept the codes? The bottom of the setup page turns
a pasted list of codes into links without re-drawing anything.

---

## Running it again next year

Run the draw again and publish the new `santa.json`. Old tokens stop working and
old wishlists become permanently unreadable, which is usually what you want.

To wipe last year's mailbox data from Cloudflare as well:

```bash
cd worker
npx wrangler kv key list --binding SANTA_KV
# then delete the ones you no longer want
```

---

## Notifications

When anyone saves a wishlist or sends a message, the Worker emails you:

> Someone has updated their Secret Santa wishlist or sent a message. Let everyone
> know to log in and check.

Deliberately vague — it names nobody and says nothing about what changed, so
forwarding it to the whole family gives nothing away.

`NOTIFY_MIN_MINUTES` caps how often one can arrive, **across the whole event**
rather than per person: `1440` is one a day, `360` one every six hours, `0` one
for every single update. The limit is global on purpose — every email says
exactly the same thing, so a per-person limit would just mean one identical
message per participant, which is seven a day for a family of seven.

The cap is best-effort. Cloudflare KV reads can be a little stale, so two people
saving at the very same moment might occasionally squeeze out a second email. It
will never be a flood.

`NOTIFY_INCLUDE_REF = "true"` adds a four-character mailbox reference if you'd
rather be able to tell separate conversations apart. It's opaque, but it does let
you see that the same mailbox is active repeatedly — leave it off if you'd rather
know nothing.

---

## Layout

```
index.html              the site everyone logs into
admin.html              setup: names, exclusions, the draw
data/santa.json         published, encrypted; replaced when you run a draw
assets/js/crypto.js     tokens, key derivation, AES-GCM
assets/js/draw.js       assignment solver (exclusions, single-chain mode)
assets/js/api.js        client for the Worker
assets/js/app.js        participant app
assets/js/admin.js      setup tool
assets/css/style.css    styling, light and dark
worker/src/index.js     the API
worker/wrangler.toml    Worker config — edit before deploying
```

## The API

Every call needs `x-santa-auth: <mailbox secret>`. The Worker checks it against
the SHA-256 published in `data/santa.json`, so it never holds a secret itself.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness check |
| `GET` | `/m/:id` | the mailbox: wishlist + messages, all ciphertext |
| `PUT` | `/m/:id/wishlist` | replace the wishlist, body `{"ct": "..."}` |
| `POST` | `/m/:id/messages` | append a message, body `{"ct": "..."}` |

Limits: 32 KB per wishlist, 8 KB per message, 500 messages per mailbox.

## Working on it locally

```bash
python -m http.server 8765
```

Then open `http://localhost:8765/`. Add `http://localhost:8765` to
`ALLOWED_ORIGINS` if you want the local site to talk to a deployed Worker, or run
`npx wrangler dev` in `worker/` for a local one.
