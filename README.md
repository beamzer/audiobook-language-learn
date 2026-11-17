# Voix — learn a language with audiobooks

A web app for learning a language by listening to a book and reading along. You choose a book, hear it
read aloud sentence by sentence, see each word light up and get its meaning in your own language right
below it.

![Voix in use: a French sentence with the Dutch meaning below each word and the conjugations of "faire" on mouse-over](voix-in-action.png)

- Word-by-word highlighting, in sync with the voice
- The meaning of each word in your language, plus a translation of the whole sentence
- Pause after each sentence (on by default), replay silently (speak along yourself) or listen again
- Adjustable reading speed (0.6× to 1.15×), without changing the pitch of the voice
- Any language ElevenLabs can read aloud, translated into one or more languages of your choice
- Verb conjugations on mouse-over (French and Spanish for now)
- A library of books: visitors read what has already been converted, at no cost to you
- A separate password-protected admin page where you add and convert new books
- A cache per book: each sentence is fetched and paid for only once (see [Caching](#caching))
- Interface in Dutch (default) and English

## Languages

**Book language.** A book can be in any of the 29 languages of the ElevenLabs `eleven_multilingual_v2`
model: Arabic, Bulgarian, Chinese, Croatian, Czech, Danish, Dutch, English, Filipino, Finnish, French,
German, Greek, Hindi, Indonesian, Italian, Japanese, Korean, Malay, Polish, Portuguese, Romanian, Russian,
Slovak, Spanish, Swedish, Tamil, Turkish and Ukrainian. For Chinese and Japanese, which have no spaces
between words, word segmentation (`Intl.Segmenter`) determines the words.

**Translation languages.** When you add a book, you choose which languages it is translated into, for
example Dutch and English. Each translation language costs extra Claude tokens when processing, but no
extra ElevenLabs characters. Visitors see the translation in the language of the interface if the book
has it, and otherwise in the book's first translation language.

**Verb conjugations.** The conjugation card on mouse-over is available for French and Spanish. It comes
from data files, not from AI. Other languages work fully, just without that card; the app itself is not
limited to these two languages.

**Interface.** The pages are in Dutch by default; the NL/EN switch at the top right changes the language
and the choice is remembered.

## What you need

- Node.js 22.9 or newer
- An API key from [ElevenLabs](https://elevenlabs.io) (voice and timestamps per word)
- An API key from [Anthropic](https://console.anthropic.com) (translation, with Claude Haiku)

## Installation

```bash
git clone https://github.com/beamzer/audiobook-language-learn.git
cd audiobook-language-learn
npm install
cp .env.example .env
```

Then fill in your two keys and an `ADMIN_PASSWORD` in `.env` and start the server:

```bash
npm start
```

Open http://localhost:3000.

## Two pages

| Page | For whom | What it costs |
| --- | --- | --- |
| `/` | Everyone: choose a book and read | Nothing. Visitors only get what is already in the cache. |
| `/admin` | You, with a password: add and process books | Processing costs characters at ElevenLabs and tokens at Claude. |

On `/admin` you add a book: a title, the language of the book, the translation languages, and the text
(pasted or as a .txt file). That costs nothing yet. **Process** converts the book sentence by sentence
into speech and translations; the page shows the progress and how many characters are still to go to
ElevenLabs. You can stop in between and continue later. Visitors see a book as soon as the first
sentences are done, and always only the part that has been converted.

The password is `ADMIN_PASSWORD` from `.env`; the user name does not matter. Without `ADMIN_PASSWORD` the
admin page is disabled. The public page never calls ElevenLabs or Claude.

## Updating

```bash
git pull
npm install
```

Then restart the server.

## On a web server

The server only listens on `127.0.0.1`; put a reverse proxy with https in front of it. The main page is
public and costs nothing; only `/admin` is behind the password from `.env`. Choose a long password and
always use https, otherwise the password travels over the internet in readable form.

You set the port with `PORT` in `.env`.

### Apache in front (with https)

Use a subdomain of its own, for example `voix.yourdomain.com`: the pages use absolute paths (`/api/...`,
`/audio/...`), so it does not work under a sub-path. The commands are for Debian/Ubuntu.

1. Modules:

   ```bash
   sudo a2enmod proxy proxy_http ssl headers
   ```

2. Virtual host. Start with a plain http host on port 80; certbot turns it into the https host itself
   (with the certificate lines) and copies the rest. If you add SSL lines pointing to certificate files
   that do not exist yet, Apache will not start and certbot fails.

   ```apache
   <VirtualHost *:80>
       ServerName voix.yourdomain.com

       ProxyPreserveHost On
       ProxyTimeout 120
       ProxyPass        / http://127.0.0.1:3000/
       ProxyPassReverse / http://127.0.0.1:3000/
   </VirtualHost>
   ```

   Do not add a password of your own in Apache (`AuthType Basic`) on this host: visitors must be able to
   open the main page, and the app protects the admin page itself.

   Load the config and request the certificate. When certbot asks about redirecting, choose a redirect
   to https; https is required, otherwise the admin password travels over the internet in readable form.
   The domain must already point to the server and port 80 must be reachable.

   ```bash
   sudo apache2ctl configtest && sudo systemctl reload apache2
   sudo certbot --apache -d voix.yourdomain.com
   ```

3. Keep the app running with systemd, in `/etc/systemd/system/voix.service`:

   ```ini
   [Unit]
   Description=Voix
   After=network.target

   [Service]
   WorkingDirectory=/path/to/audiobook-language-learn
   ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
   Restart=on-failure
   User=youruser

   [Install]
   WantedBy=multi-user.target
   ```

   Check with `which node` that the path is right and that it is Node 22.9 or newer. Start it:

   ```bash
   sudo systemctl enable --now voix
   ```

   After a `git pull`, restart with `sudo systemctl restart voix`.

## How it works

| Part | Source |
| --- | --- |
| Audio and timestamps per word | ElevenLabs text-to-speech (`with-timestamps`, `eleven_multilingual_v2`) |
| Translation per word and verb detection | Claude Haiku 5.5 |
| French conjugations | Data file [french-verbs-lefff](https://www.npmjs.com/package/french-verbs-lefff) |
| Spanish conjugations | Rule-based, via [spanish-verbs](https://www.npmjs.com/package/spanish-verbs) |

## Caching

Each book has a folder of its own, `books/<name>/`, containing `book.json` (title, language, translation
languages, voice and the sentences) and, per sentence, the audio, the word timings, and for each
translation language the translation and the detected verbs. A sentence is therefore **fetched and paid
for only once**; after that it comes from disk.

Why that is an advantage:

- **Cheap:** ElevenLabs charges per character and Claude per token. You pay once to convert a book.
  After that, reading, rereading and repeating cost nothing, for you and for every visitor.
- **No surprises:** visitors cannot cause costs, because the public page only reads from the cache.
  Only processing on the admin page costs money.
- **Fast:** a sentence from the cache is there instantly.
- **Always the same voice and translation:** pronunciation and meaning stay the same on every repeat,
  also after restarting or moving the server.
- **Portable:** a book is one folder. Copy `books/<name>/` to another server and the book is available
  there right away, without paying again.

How the cache works:

- A sentence is cached by its text and the voice of the book. The voice is fixed when the book is
  added; a different `ELEVENLABS_VOICE_ID` only applies to books you add afterwards.
- Processing skips sentences that are already done, and after a stop or an error it continues where it
  left off.
- The conjugations on mouse-over come from data files and never cost anything.
- One hour of audio is about 55 MB.
- To delete a book, delete its folder `books/<name>/`.
- `books/` and `.env` are not in git.

If you have a book from an earlier version (`data/book.json` and `cache/`), the server converts it to a
book folder on first start, with Dutch as the translation language. Then click **Continue processing** on
the admin page to finish it.

## Files

- `server.js` — the server: books, processing, ElevenLabs, Claude, conjugations, cache
- `public/index.html` — the page for visitors: choose a book and read
- `public/admin.html` — the admin page: add and process books
