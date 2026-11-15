# Voix — luisterboek leren

Webapp om Frans of Spaans te leren met een voorgelezen boek. Je kiest een boek, hoort het zin voor zin
voorgelezen, ziet elk woord oplichten en krijgt de Nederlandse betekenis er direct onder.

![Voix in gebruik: een Franse zin met de Nederlandse betekenis onder elk woord en de vervoegingen van "faire" bij mouse-over](voix-in-action.png)

- Woord-voor-woord highlighting, gelijk met de stem
- Nederlandse betekenis per woord, plus een vertaling van de hele zin
- Per zin pauzeren (standaard aan), stil herhalen (zelf meespreken) of opnieuw beluisteren
- Instelbare leessnelheid (0,6× tot 1,15×), zonder dat de stem hoger of lager gaat klinken
- Vervoegingen van werkwoorden bij mouse-over
- Een bibliotheek met boeken: bezoekers lezen wat al is omgezet, zonder dat het jou iets kost
- Een aparte beheerpagina met wachtwoord, waar je nieuwe boeken toevoegt en laat omzetten
- Een cache per boek: elke zin wordt maar één keer opgehaald en betaald (zie [Caching](#caching))

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

Vul daarna in `.env` je twee sleutels en een `ADMIN_PASSWORD` in en start de server:

```bash
npm start
```

Open http://localhost:3000.

## Twee pagina's

| Pagina | Voor wie | Wat het kost |
| --- | --- | --- |
| `/` | Iedereen: boek kiezen en lezen | Niets. Bezoekers krijgen alleen wat al in de cache staat. |
| `/admin` | Jij, met wachtwoord: boeken toevoegen en verwerken | Verwerken kost tekens bij ElevenLabs en tokens bij Claude. |

Op `/admin` voeg je een boek toe (titel, taal en tekst plakken of een .txt-bestand). Dat kost nog niets.
Met **Verwerken** wordt het boek zin voor zin omgezet naar spraak en vertaling; de pagina toont de
voortgang en hoeveel tekens er nog naar ElevenLabs gaan. Je kunt tussentijds stoppen en later verdergaan.
Bezoekers zien een boek zodra de eerste zinnen klaar zijn, en altijd alleen het deel dat al is omgezet.

Het wachtwoord is `ADMIN_PASSWORD` uit `.env`; de gebruikersnaam maakt niet uit. Zonder `ADMIN_PASSWORD`
staat het beheer uit. De publieke pagina roept nooit ElevenLabs of Claude aan.

## Bijwerken

```bash
git pull
npm install
```

Herstart daarna de server.

## Op een webserver

De server luistert alleen op `127.0.0.1`; zet er een reverse proxy met https voor. De hoofdpagina is
openbaar en kost niets; alleen `/admin` zit achter het wachtwoord uit `.env`. Kies een lang wachtwoord
en gebruik altijd https, anders gaat het wachtwoord leesbaar over het internet.

De poort stel je in met `PORT` in `.env`.

### Apache als voorkant (met https)

Gebruik een eigen subdomein, bijvoorbeeld `voix.jouwdomein.nl`: de pagina gebruikt absolute paden
(`/api/...`, `/audio/...`), dus onder een subpad werkt het niet. De commando's gelden voor Debian/Ubuntu.

1. Modules:

   ```bash
   sudo a2enmod proxy proxy_http ssl headers
   ```

2. Virtual host. Begin met een gewone http-host op poort 80; certbot maakt daar zelf de https-host
   van (met de certificaatregels) en neemt de rest over. Zet je meteen SSL-regels met nog niet
   bestaande certificaatbestanden in de config, dan start Apache niet en lukt certbot niet.

   ```apache
   <VirtualHost *:80>
       ServerName voix.jouwdomein.nl

       ProxyPreserveHost On
       ProxyTimeout 120
       ProxyPass        / http://127.0.0.1:3000/
       ProxyPassReverse / http://127.0.0.1:3000/
   </VirtualHost>
   ```

   Zet in Apache geen eigen wachtwoord (`AuthType Basic`) op deze host: bezoekers moeten de hoofdpagina
   kunnen openen, en het beheer beveiligt de app zelf.

   Laad de config en vraag het certificaat aan. Kies bij de vraag over doorsturen voor een redirect
   naar https; https is verplicht, anders gaat het beheerwachtwoord leesbaar over het internet. Het domein
   moet dan al naar de server wijzen en poort 80 moet bereikbaar zijn.

   ```bash
   sudo apache2ctl configtest && sudo systemctl reload apache2
   sudo certbot --apache -d voix.jouwdomein.nl
   ```

3. De app laten draaien met systemd, in `/etc/systemd/system/voix.service`:

   ```ini
   [Unit]
   Description=Voix
   After=network.target

   [Service]
   WorkingDirectory=/pad/naar/audiobook-language-learn
   ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
   Restart=on-failure
   User=jouwgebruiker

   [Install]
   WantedBy=multi-user.target
   ```

   Controleer met `which node` of het pad klopt en of het Node 22.9 of nieuwer is. Starten:

   ```bash
   sudo systemctl enable --now voix
   ```

   Na een `git pull` herstart je met `sudo systemctl restart voix`.

## Hoe het werkt

| Onderdeel | Bron |
| --- | --- |
| Audio en tijdstempels per woord | ElevenLabs text-to-speech (`with-timestamps`) |
| Vertaling per woord en herkenning van werkwoorden | Claude Haiku 5.5 |
| Franse vervoegingen | Databestand [french-verbs-lefff](https://www.npmjs.com/package/french-verbs-lefff) |
| Spaanse vervoegingen | Regelgebaseerd, via [spanish-verbs](https://www.npmjs.com/package/spanish-verbs) |

## Caching

Elk boek heeft een eigen map `books/<naam>/` met daarin `book.json` (titel, taal, stem en de zinnen) en
per zin de audio, de woordtijden, de Nederlandse vertaling en de herkende werkwoorden. Een zin wordt dus
**maar één keer opgehaald en betaald**; daarna komt hij van schijf.

Waarom dat een voordeel is:

- **Goedkoop:** ElevenLabs rekent per teken en Claude per token. Je betaalt één keer voor het omzetten
  van een boek. Daarna kost lezen, herlezen en herhalen niets, voor jou en voor elke bezoeker.
- **Geen verrassingen:** bezoekers kunnen geen kosten maken, want de publieke pagina leest alleen uit de
  cache. Alleen verwerken op de beheerpagina kost geld.
- **Snel:** een zin uit de cache is er direct.
- **Altijd dezelfde stem en vertaling:** de uitspraak en betekenis blijven bij herhaling gelijk, ook na
  herstarten of verhuizen van de server.
- **Verplaatsbaar:** een boek is één map. Kopieer `books/<naam>/` naar een andere server en het boek is
  daar direct beschikbaar, zonder opnieuw te betalen.

Hoe de cache werkt:

- Een zin staat in de cache op basis van zijn tekst en de stem van het boek. De stem wordt bij het
  toevoegen vastgelegd; een andere `ELEVENLABS_VOICE_ID` geldt alleen voor boeken die je daarna toevoegt.
- Verwerken slaat zinnen over die er al zijn, en gaat na stoppen of een fout verder waar het was.
- De vervoegingen bij mouse-over komen uit een bestand en kosten nooit iets.
- Een uur audio is ongeveer 55 MB.
- Een boek verwijderen doe je door de map `books/<naam>/` te verwijderen.
- `books/` en `.env` staan niet in git.

Had je al een boek uit een eerdere versie (`data/book.json` en `cache/`), dan zet de server dat bij de
eerste start om naar een boekmap. Klik daarna op de beheerpagina op **Verder verwerken** om het af te maken.

## Bestanden

- `server.js` — de server: boeken, verwerken, ElevenLabs, Claude, vervoegingen, cache
- `public/index.html` — de pagina voor bezoekers: boek kiezen en lezen
- `public/admin.html` — de beheerpagina: boeken toevoegen en verwerken
