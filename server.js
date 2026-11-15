import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import frVerbs from "french-verbs-lefff/dist/conjugations.json" with { type: "json" };
import esVerbs from "spanish-verbs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOKS = path.join(here, "books"); // per boek een map: book.json plus de cache van elke zin
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const VOICE = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const TTS_MODEL = "eleven_multilingual_v2";
const LANGS = { fr: "Frans", es: "Spaans" };

const hash = (voice, text) =>
  crypto.createHash("sha1").update(`${voice}|${TTS_MODEL}|${text}`).digest("hex");

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

// Eerst naar een tijdelijk bestand: een half geschreven bestand komt zo nooit in de cache.
async function writeFile(file, data) {
  await fs.writeFile(`${file}.tmp`, data);
  await fs.rename(`${file}.tmp`, file);
}

function splitSentences(text, lang) {
  const flat = text.replace(/\s+/g, " ").trim();
  const seg = new Intl.Segmenter(lang, { granularity: "sentence" });
  return [...seg.segment(flat)].map((s) => s.segment.trim()).filter(Boolean);
}

// --- ElevenLabs: audio + tijdstempels per woord -----------------------------

async function getTts(dir, h, voice, text, prev, next) {
  const file = path.join(dir, `${h}.tts.json`);
  const cached = await readJson(file);
  if (cached) return cached;

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY ontbreekt in .env");

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      // previous_text/next_text houden de intonatie tussen zinnen natuurlijk.
      body: JSON.stringify({ text, model_id: TTS_MODEL, previous_text: prev, next_text: next }),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const { audio_base64, alignment } = await res.json();

  // Tekens samenvoegen tot woorden (gesplitst op spaties).
  const words = [];
  let cur = null;
  alignment.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      cur = null;
      return;
    }
    if (!cur) words.push((cur = { t: "", start: alignment.character_start_times_seconds[i] }));
    cur.t += ch;
    cur.end = alignment.character_end_times_seconds[i];
  });

  const data = { words };
  await writeFile(path.join(dir, `${h}.mp3`), Buffer.from(audio_base64, "base64"));
  await writeFile(file, JSON.stringify(data));
  return data;
}

// --- Vervoegingen: uit een databestand (Frans) of op regels (Spaans), zonder AI

const FR_TENSES = [["présent", "P"], ["imparfait", "I"], ["passé simple", "J"],
                   ["futur", "F"], ["conditionnel", "C"], ["subjonctif", "S"]];
const ES_TENSES = [["presente", "INDICATIVE_PRESENT"], ["imperfecto", "INDICATIVE_IMPERFECT"],
                   ["indefinido", "INDICATIVE_PRETERITE"], ["futuro", "INDICATIVE_FUTURE"],
                   ["condicional", "CONDITIONAL_PRESENT"], ["subjuntivo", "SUBJUNCTIVE_PRESENT"]];

function conjugate(lang, inf) {
  if (!inf) return null;
  if (lang === "fr") {
    const v = frVerbs[inf.toLowerCase().replace(/^(se |s['’])/, "")]; // s'enfuir -> enfuir
    if (!v) return null;
    return {
      inf,
      tenses: FR_TENSES.map(([name, k]) => ({ name, forms: v[k] })),
      extra: [["participe passé", v.K[0]], ["participe présent", v.G[0]]],
    };
  }
  const base = inf.toLowerCase().replace(/se$/, ""); // levantarse -> levantar
  if (!/(ar|er|ir|ír)$/.test(base)) return null;
  try {
    return {
      inf,
      tenses: ES_TENSES.map(([name, t]) => ({
        name,
        forms: [0, 1, 2, 3, 4, 5].map((p) => esVerbs.getConjugation(base, t, p)),
      })),
      extra: [],
    };
  } catch {
    return null;
  }
}

// --- Claude: Nederlandse vertaling per woord --------------------------------

let anthropic;

async function getNl(dir, h, text, lang) {
  const file = path.join(dir, `${h}.nl.json`);
  const cached = await readJson(file);
  if (cached) return cached;

  const words = text.split(" ");
  anthropic ??= new Anthropic();

  let res;
  try {
    res = await anthropic.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 16000,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              // Het bronwoord herhalen houdt de vertalingen één-op-één uitgelijnd.
              words: {
                type: "array",
                items: {
                  type: "object",
                  properties: { src: { type: "string" }, nl: { type: "string" }, inf: { type: "string" } },
                  required: ["src", "nl", "inf"],
                  additionalProperties: false,
                },
              },
              sentence: { type: "string" },
            },
            required: ["words", "sentence"],
            additionalProperties: false,
          },
        },
      },
      system:
        `Je helpt een Nederlandstalige die ${LANGS[lang]} leert met een luisterboek. ` +
        `Je krijgt een zin en dezelfde zin opgesplitst in woorden. Geef in "words" voor elk invoerwoord ` +
        `één item: "src" is het invoerwoord letterlijk overgenomen, "nl" de Nederlandse betekenis zoals ` +
        `het woord in déze zin gebruikt wordt: kort (1-3 woorden), zonder leestekens. Een samengetrokken ` +
        `vorm zoals "l'homme" of "du" vertaal je als geheel in één item ("de man", "van de"). ` +
        `"inf" is de infinitief als het woord een werkwoordsvorm is of bevat (vervoegd, deelwoord of ` +
        `infinitief; "s'élança" -> "s'élancer", "qu'il vit" -> "voir"), en anders een lege string. ` +
        `"words" bevat precies evenveel items als de invoer, in dezelfde volgorde. ` +
        `Geef in "sentence" een natuurlijke Nederlandse vertaling van de hele zin.`,
      messages: [{ role: "user", content: JSON.stringify({ sentence: text, words }) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError)
      throw new Error("Anthropic API-sleutel ontbreekt of is ongeldig (ANTHROPIC_API_KEY in .env)");
    if (e instanceof Anthropic.RateLimitError)
      throw new Error("Anthropic rate limit bereikt, probeer het zo opnieuw");
    if (e instanceof Anthropic.APIError) throw new Error(`Anthropic ${e.status}: ${e.message}`);
    throw e;
  }

  if (res.stop_reason !== "end_turn") throw new Error(`Vertaling mislukt (${res.stop_reason})`);
  const out = JSON.parse(res.content.find((b) => b.type === "text").text);
  if (out.words.length !== words.length || out.words.some((w, k) => w.src !== words[k]))
    throw new Error("Vertaling loopt niet gelijk met de woorden van de zin, probeer het opnieuw");
  const data = {
    words: out.words.map((w) => w.nl),
    inf: out.words.map((w) => w.inf),
    sentence: out.sentence,
  };
  await writeFile(file, JSON.stringify(data));
  return data;
}

// --- Boeken: elk boek heeft een eigen map met book.json en zijn cache --------

const bookDir = (id) => path.join(BOOKS, id);
const readBook = (id) => readJson(path.join(bookDir(id), "book.json"));

async function listBooks() {
  const entries = await fs.readdir(BOOKS, { withFileTypes: true });
  const books = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => readBook(e.name)));
  return books.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
}

// done: aantal zinnen in de cache. ready: aantal vanaf het begin zonder gat; zoveel zien bezoekers.
// todoChars: tekens die nog naar ElevenLabs moeten (ElevenLabs rekent per teken).
async function progress(book) {
  const files = new Set(await fs.readdir(bookDir(book.id)));
  let done = 0, ready = 0, todoChars = 0;
  book.sentences.forEach((s, i) => {
    const h = hash(book.voice, s);
    const audio = files.has(`${h}.mp3`) && files.has(`${h}.tts.json`);
    if (audio && files.has(`${h}.nl.json`)) {
      if (ready === i) ready++;
      done++;
    }
    if (!audio) todoChars += s.length;
  });
  return { done, ready, todoChars };
}

async function createBook(title, lang, sentences) {
  const slug = title.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 60) || "boek";
  const taken = new Set(await fs.readdir(BOOKS));
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  // De stem hoort bij het boek: een andere stem in .env maakt bestaande boeken niet onbruikbaar.
  const book = { id, title, lang, voice: VOICE, sentences };
  await fs.mkdir(bookDir(id));
  await writeFile(path.join(bookDir(id), "book.json"), JSON.stringify(book));
  return book;
}

// --- Eén zin: audio en vertaling samen ---------------------------------------
// Haalt op wat nog niet in de cache staat. Alleen het verwerken in het beheer mag dat laten gebeuren;
// bezoekers krijgen alleen zinnen waarvan progress() zegt dat ze er al zijn.

const inflight = new Map();

function getSentence(book, i) {
  const text = book.sentences[i];
  const h = hash(book.voice, text);
  const key = `${book.id}/${h}`;
  if (!inflight.has(key)) {
    const dir = bookDir(book.id);
    const p = Promise.all([
      getTts(dir, h, book.voice, text, book.sentences[i - 1], book.sentences[i + 1]),
      getNl(dir, h, text, book.lang),
    ])
      .then(([tts, nl]) => ({
        words: tts.words.map((w, k) => ({
          ...w,
          nl: nl.words[k] ?? "",
          verb: conjugate(book.lang, nl.inf[k]),
        })),
        nl: nl.sentence,
        audio: `/audio/${book.id}/${h}.mp3`,
      }))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

// --- Verwerken: een heel boek omzetten naar spraak en vertaling --------------

const jobs = new Map(); // boek-id -> { running, stop, error }

async function processBook(book) {
  const job = { running: true, stop: false, error: null };
  jobs.set(book.id, job);
  let next = 0;
  const worker = async () => {
    while (!job.stop && next < book.sentences.length) {
      const i = next++;
      for (let attempt = 1; !job.stop; attempt++) {
        try {
          await getSentence(book, i);
          break;
        } catch (e) {
          // Een vertaling die niet gelijk loopt of een drukke dienst lukt meestal bij een nieuwe poging.
          if (attempt === 3) {
            job.error = `Zin ${i + 1}: ${e.message}`;
            job.stop = true;
          } else await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
  };
  await Promise.all([worker(), worker()]); // twee zinnen tegelijk
  job.running = false;
}

// --- HTTP -------------------------------------------------------------------

const send = (res, status, body, type = "application/json", headers = {}) => {
  res.writeHead(status, { "content-type": type, ...headers });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const page = async (res, name) =>
  send(res, 200, await fs.readFile(path.join(here, "public", name)), "text/html; charset=utf-8");

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isAdmin(req) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1], "base64").toString("utf8").replace(/^[^:]*:/, ""); // gebruikersnaam telt niet
  const sha = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(sha(given), sha(ADMIN_PASSWORD));
}

const ID = "([a-z0-9-]+)";

// Beheer: alles onder /admin kost geld of wijzigt boeken, en zit achter het wachtwoord.
async function handleAdmin(req, res, url) {
  if (!ADMIN_PASSWORD)
    return send(res, 503, "Het beheer staat uit: zet ADMIN_PASSWORD in .env en herstart.", "text/plain; charset=utf-8");
  if (!isAdmin(req))
    return send(res, 401, "Wachtwoord nodig", "text/plain; charset=utf-8",
      { "www-authenticate": 'Basic realm="Voix beheer", charset="UTF-8"' });
  let m;

  if (req.method === "GET" && url.pathname === "/admin") return page(res, "admin.html");

  if (req.method === "GET" && url.pathname === "/admin/api/books") {
    const books = await listBooks();
    return send(res, 200, await Promise.all(books.map(async (b) => {
      const job = jobs.get(b.id);
      return { id: b.id, title: b.title, lang: b.lang, total: b.sentences.length, ...(await progress(b)),
               running: !!job?.running, error: job?.error ?? null };
    })));
  }

  if (req.method === "POST" && url.pathname === "/admin/api/books") {
    const { title, text, lang } = await readBody(req);
    if (!LANGS[lang]) return send(res, 400, { error: "Onbekende taal" });
    if (!String(title ?? "").trim()) return send(res, 400, { error: "Geef het boek een titel" });
    const sentences = splitSentences(String(text ?? ""), lang);
    if (!sentences.length) return send(res, 400, { error: "Geen tekst gevonden" });
    const book = await createBook(String(title).trim(), lang, sentences);
    return send(res, 200, { id: book.id });
  }

  if (req.method === "POST" && (m = url.pathname.match(`^/admin/api/books/${ID}/(process|stop)$`))) {
    const book = await readBook(m[1]);
    if (!book) return send(res, 404, { error: "Boek niet gevonden" });
    const job = jobs.get(book.id);
    if (m[2] === "stop") {
      if (job) job.stop = true;
    } else if (!job?.running) {
      processBook(book).catch((e) => console.error(e));
    }
    return send(res, 200, {});
  }

  send(res, 404, { error: "Niet gevonden" });
}

// Bezoekers: alleen lezen wat al in de cache staat. Hier wordt nooit iets opgehaald bij ElevenLabs of Claude.
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  let m;

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(req, res, url);
  if (req.method !== "GET") return send(res, 404, { error: "Niet gevonden" });

  if (url.pathname === "/") return page(res, "index.html");

  if (url.pathname === "/api/books") {
    const out = [];
    for (const b of await listBooks()) {
      const { ready } = await progress(b);
      if (ready) out.push({ id: b.id, title: b.title, lang: b.lang, count: ready });
    }
    return send(res, 200, out);
  }

  if ((m = url.pathname.match(`^/api/books/${ID}(?:/sentence/(\\d+))?$`))) {
    const book = await readBook(m[1]);
    const ready = book ? (await progress(book)).ready : 0;
    if (!ready) return send(res, 404, { error: "Boek niet gevonden" });
    if (m[2] === undefined)
      return send(res, 200, { id: book.id, title: book.title, lang: book.lang, sentences: book.sentences.slice(0, ready) });
    if (Number(m[2]) >= ready) return send(res, 404, { error: "Deze zin is nog niet beschikbaar" });
    return send(res, 200, await getSentence(book, Number(m[2])));
  }

  if ((m = url.pathname.match(`^/audio/${ID}/([0-9a-f]{40})\\.mp3$`))) {
    try {
      return send(res, 200, await fs.readFile(path.join(bookDir(m[1]), `${m[2]}.mp3`)), "audio/mpeg");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  send(res, 404, { error: "Niet gevonden" });
}

// Eenmalig: het boek en de cache van de oude opzet (data/book.json en cache/) omzetten naar een boekmap.
async function migrate() {
  const oldBook = path.join(here, "data", "book.json");
  const old = await readJson(oldBook);
  if (!old) return;
  const book = await createBook(old.sentences[0].slice(0, 60), old.lang, old.sentences);
  for (const s of new Set(old.sentences)) {
    const h = hash(VOICE, s);
    // Oude vertalingen zonder infinitieven blijven achter en worden bij het verwerken opnieuw gemaakt.
    const nl = await readJson(path.join(here, "cache", `${h}.nl.json`));
    for (const ext of [".mp3", ".tts.json", ...(nl?.inf ? [".nl.json"] : [])]) {
      await fs.rename(path.join(here, "cache", h + ext), path.join(bookDir(book.id), h + ext))
        .catch((e) => { if (e.code !== "ENOENT") throw e; });
    }
  }
  await fs.rm(oldBook);
  console.log(`Bestaand boek overgezet naar books/${book.id}`);
}

await fs.mkdir(BOOKS, { recursive: true });
await migrate();

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      send(res, 500, { error: e.message });
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Luisterboek-app: http://localhost:${PORT}`));
