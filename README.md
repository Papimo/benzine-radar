# Benzine-radar (regio Heerlen)

Vind de goedkoopste tankstations in de regio Heerlen (NL, BE en DE, tot ±50 km), inclusief wat de rit en je tijd kosten.

**Open de app:** via GitHub Pages van dit repo. Werkt ook op je telefoon: kies "Toevoegen aan beginscherm" of "App installeren".

## Hoe het werkt
- GitHub Actions haalt 3× per dag de prijzen op (ANWB voor NL/BE/DE en carbu.com voor BE) en zet ze in `data/prices.json`. De regiogemiddelden komen in `data/stats.json`; daarop is het advies "nu of later tanken" gebaseerd.
- De pagina rekent alles in je browser uit. Routes komen van OSRM, adressen van Photon en filemeldingen van de Autobahn-API.
- Je vertrekadres, vaste adressen, tankpas-korting, prijsalarm en tanklogboek blijven in je eigen browser (localStorage) en worden nergens naartoe gestuurd, behalve het adres naar de adreszoeker en de routeplanner.

## Bestanden
- `index.html`, `app.js`, `style.css`, `mapstyle.js`: de app
- `static-api.js`: rekenwerk in de browser (zoeken, ontdubbelen, netto besparing, ritopbouw)
- `sw.js`, `manifest.webmanifest`: installeerbaar en offline
- `app/`: ophaalcode (alleen de Python-standaardbibliotheek), `python -m app.export_static --out data`
- `.github/workflows/prices.yml`: het schema waarop wordt opgehaald

Prijzen zijn indicatief; controleer altijd de prijs aan de pomp.
