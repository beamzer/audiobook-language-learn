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
toegangsbeveiliging voor. Zonder beveiliging kan iedereen die het adres kent audio en vertalingen
laten genereren op kosten van jouw API-sleutels.

De poort stel je in met `PORT` in `.env`.

### Apache als voorkant (met wachtwoord en https)

Gebruik een eigen subdomein, bijvoorbeeld `voix.jouwdomein.nl`: de pagina gebruikt absolute paden
(`/api/...`, `/audio/...`), dus onder een subpad werkt het niet. De commando's gelden voor Debian/Ubuntu.

1. Modules en wachtwoordbestand:

   ```bash
   sudo a2enmod proxy proxy_http ssl headers
   sudo htpasswd -c /etc/apache2/voix.htpasswd jouwnaam
   ```

2. Virtual host (https is verplicht, anders gaat het wachtwoord leesbaar over het internet; een
   certificaat haal je met `sudo certbot --apache -d voix.jouwdomein.nl`):

   ```apache
   <VirtualHost *:443>
       ServerName voix.jouwdomein.nl

       SSLEngine on
       SSLCertificateFile    /etc/letsencrypt/live/voix.jouwdomein.nl/fullchain.pem
       SSLCertificateKeyFile /etc/letsencrypt/live/voix.jouwdomein.nl/privkey.pem

       <Location />
           AuthType Basic
           AuthName "Voix"
           AuthUserFile /etc/apache2/voix.htpasswd
           Require valid-user
       </Location>

       ProxyPreserveHost On
       ProxyTimeout 120
       ProxyPass        / http://127.0.0.1:3000/
       ProxyPassReverse / http://127.0.0.1:3000/
   </VirtualHost>
   ```

   `ProxyTimeout 120` is nodig omdat een zin die voor het eerst wordt opgehaald (ElevenLabs en Claude)
   enkele seconden kan duren.

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

Audio en vertalingen worden per zin opgehaald en bewaard in `cache/`, zodat elke zin maar één keer
geld kost. Het geladen boek staat in `data/book.json`. Beide mappen en `.env` staan niet in git.

Er kan één boek tegelijk geladen zijn; een nieuw boek vervangt het vorige.

## Bestanden

- `server.js` — de server: boek opknippen in zinnen, ElevenLabs, Claude, vervoegingen, cache
- `public/index.html` — de hele pagina (opmaak en script)
