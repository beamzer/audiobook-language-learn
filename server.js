import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import frVerbs from "french-verbs-lefff/dist/conjugations.json" with { type: "json" };
import esVerbs from "spanish-verbs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, "cache");
const BOOK = path.join(here, "data", "book.json");
const PORT = process.env.PORT || 3000;

const VOICE = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const TTS_MODEL = "eleven_multilingual_v2";
const LANGS = { fr: "Frans", es: "Spaans" };

const hash = (text) =>
  crypto.createHash("sha1").update(`${VOICE}|${TTS_MODEL}|${text}`).digest("hex");

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

function splitSentences(text, lang) {
  const flat = text.replace(/\s+/g, " ").trim();
  const seg = new Intl.Segmenter(lang, { granularity: "sentence" });
  return [...seg.segment(flat)].map((s) => s.segment.trim()).filter(Boolean);
}

// --- ElevenLabs: audio + tijdstempels per woord -----------------------------

async function getTts(h, text, prev, next) {
  const file = path.join(CACHE, `${h}.tts.json`);
  const cached = await readJson(file);
  if (cached) return cached;

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY ontbreekt in .env");

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`,
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
  await fs.writeFile(path.join(CACHE, `${h}.mp3`), Buffer.from(audio_base64, "base64"));
  await fs.writeFile(file, JSON.stringify(data));
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

async function getNl(h, text, lang) {
  const file = path.join(CACHE, `${h}.nl.json`);
  const cached = await readJson(file);
  if (cached?.inf) return cached; // oudere cachebestanden zonder infinitieven worden opnieuw gemaakt

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
  await fs.writeFile(file, JSON.stringify(data));
  return data;
}

// --- Eén zin: audio en vertaling samen, met deduplicatie voor prefetch ------

const inflight = new Map();

function getSentence(book, i) {
  const text = book.sentences[i];
  const h = hash(text);
  if (!inflight.has(h)) {
    const p = Promise.all([
      getTts(h, text, book.sentences[i - 1], book.sentences[i + 1]),
      getNl(h, text, book.lang),
    ])
      .then(([tts, nl]) => ({
        words: tts.words.map((w, k) => ({
          ...w,
          nl: nl.words[k] ?? "",
          verb: conjugate(book.lang, nl.inf[k]),
        })),
        nl: nl.sentence,
        audio: `/audio/${h}.mp3`,
      }))
      .finally(() => inflight.delete(h));
    inflight.set(h, p);
  }
  return inflight.get(h);
}

// --- HTTP -------------------------------------------------------------------

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  let m;

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, await fs.readFile(path.join(here, "public", "index.html")), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/api/book") {
    return send(res, 200, await readJson(BOOK));
  }

  if (req.method === "POST" && url.pathname === "/api/book") {
    const { text, lang } = await readBody(req);
    if (!LANGS[lang]) return send(res, 400, { error: "Onbekende taal" });
    const sentences = splitSentences(String(text ?? ""), lang);
    if (!sentences.length) return send(res, 400, { error: "Geen tekst gevonden" });
    const book = { lang, sentences };
    await fs.writeFile(BOOK, JSON.stringify(book));
    return send(res, 200, book);
  }

  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/sentence\/(\d+)$/))) {
    const book = await readJson(BOOK);
    const i = Number(m[1]);
    if (!book || i >= book.sentences.length) return send(res, 404, { error: "Zin niet gevonden" });
    return send(res, 200, await getSentence(book, i));
  }

  if (req.method === "GET" && (m = url.pathname.match(/^\/audio\/([0-9a-f]{40})\.mp3$/))) {
    return send(res, 200, await fs.readFile(path.join(CACHE, `${m[1]}.mp3`)), "audio/mpeg");
  }

  send(res, 404, { error: "Niet gevonden" });
}

await fs.mkdir(CACHE, { recursive: true });
await fs.mkdir(path.dirname(BOOK), { recursive: true });

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      send(res, 500, { error: e.message });
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Luisterboek-app: http://localhost:${PORT}`));
