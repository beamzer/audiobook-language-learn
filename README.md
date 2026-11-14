# Voix — luisterboek leren

Webapp om Frans of Spaans te leren met een voorgelezen boek. Je plakt een tekst, hoort die zin voor zin
voorgelezen, ziet elk woord oplichten en krijgt de Nederlandse betekenis er direct onder.

- Woord-voor-woord highlighting, gelijk met de stem
- Nederlandse betekenis per woord, plus een vertaling van de hele zin
- Per zin pauzeren, stil herhalen (zelf meespreken) of opnieuw beluisteren
- Vervoegingen van werkwoorden bij mouse-over

## Wat je nodig hebt

- Node.js 22.9 of nieuwer
- Een API-sleutel van [ElevenLabs](https://elevenlabs.io) (stem en tijdstempels per woord)
- Een API-sleutel van [Anthropic](https://console.anthropic.com) (vertaling, met Claude Haiku)

## Installeren

```bash
git clone git@github.com:beamzer/audiobook-language-learn.git
cd audiobook-language-learn
npm install
cp .env.example .env
```

Vul daarna je twee sleutels in `.env` in en start de server:

```bash
npm start
```

Open http://localhost:3000.

## Bijwerken

```bash
git pull
npm install
```

Herstart daarna de server.

## Op een webserver

De server luistert alleen op `127.0.0.1` en heeft **geen inlog**. Zet er een reverse proxy met
toegangsbeveiliging voor (bijvoorbeeld nginx of Caddy met basic auth). Zonder beveiliging kan iedereen
die het adres kent audio en vertalingen laten genereren op kosten van jouw API-sleutels.

De poort stel je in met `PORT` in `.env`.

## Hoe het werkt

| Onderdeel | Bron |
| --- | --- |
| Audio en tijdstempels per woord | ElevenLabs text-to-speech (`with-timestamps`) |
| Vertaling per woord en herkenning van werkwoorden | Claude Haiku 5.5 |
| Franse vervoegingen | Databestand [french-verbs-lefff](https://www.npmjs.com/package/french-verbs-lefff) |
| Spaanse vervoegingen | Regelgebaseerd, via [spanish-verbs](https://www.npmjs.com/package/spanish-verbs) |

Audio en vertalingen worden per zin opgehaald en bewaard in `cache/`, zodat elke zin maar één keer
geld kost. Het geladen boek staat in `data/book.json`. Beide mappen en `.env` staan niet in git.

Er kan één boek tegelijk geladen zijn; een nieuw boek vervangt het vorige.

## Bestanden

- `server.js` — de server: boek opknippen in zinnen, ElevenLabs, Claude, vervoegingen, cache
- `public/index.html` — de hele pagina (opmaak en script)
