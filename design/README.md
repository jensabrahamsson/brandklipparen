# Brandklipparen: design

Designskisser inför hackathonet. Inget här är kod. Bilderna är statiska SVG-filer som öppnas direkt i en webbläsare.
All data i skisserna är påhittad: tokens, adresser, selektorer och statistik.

```
design/
├── README.md
├── logo/
│   ├── a-vakt.svg            förslag A (rekommenderas)
│   ├── b-springaren.svg      förslag B
│   ├── c-bytemanke.svg       förslag C
│   └── oversikt.svg          alla tre, lockup, ljus variant, små storlekar
└── skisser/
    ├── 00-palett-och-komponenter.svg
    ├── 01-startsida.svg
    ├── 02-tokensida.svg
    └── 03-tidslinje.svg
```

## Identitet

Brandklipparen var Karl XII:s häst. Vi lånar hästens egenskaper, inte historien: **snabb, vaksam, pålitlig**.
En springare som bär dig genom farlig terräng och känner faran innan du ser den. Det är exakt vad produkten gör
vid deploy: den läser bytecoden innan marknaden har hunnit reagera.

Inga kronor, ingen kunglig pompa, inga flaggor. Det svenska ligger i enkelheten, i den dämpade fjällblå tonen och i
en enda detalj i kornguld (hästens öga).

### Logoförslag

| | Förslag | Idé | Styrka | Svaghet |
|---|---|---|---|---|
| A | **Vakt** | Fasetterat hästhuvud i profil, rest öra, två blå toner, öga i kornguld | Lugnast, tidlöst, håller ner till 16 px | Minst berättande |
| B | **Springaren** | Schackets häst, som heter *springare* på svenska | Dubbel betydelse: springaren hoppar över hinder, du hoppar över fällor | Schackpjäser är ett vanligt motiv i krypto |
| C | **Bytemanke** | Samma huvud som A, men manen är rader av bytecode | Säger vad produkten gör | Detaljrik, manen försvinner under 24 px |

**Rekommendation: A.** Det är tydligast i favicon, i Telegram-notiser och i Muse-svaren där märket blir litet.
C kan användas som illustration på startsidan eller i pitchen. Alla märken vänder sig åt höger, framåt i tiden,
i samma riktning som tidslinjen.

Ordbilden skrivs `brandklipparen` i gemener, Inter 600, med lätt negativ spärrning. Gemener känns modernare och mindre
skrikigt än versaler, och det långa svenska ordet blir lättare att läsa.

### Tagline (engelska)

1. **Senses the rug before you see it.** (rekommenderas, knyter an till hästen som känner faran)
2. Read the bytecode. Ride clear.
3. Risk, straight from the bytecode.
4. Know before you ape.
5. Steady footing in rough markets.

## Färgpalett

Mörk bas, en lugn blå för varumärket och riskfärger som bara används för risk.

| Roll | Namn | Hex |
|---|---|---|
| Bakgrund | Natt | `#0E1116` |
| Kort, ytor | Yta | `#161B22` |
| Kanter, avdelare | Kant | `#262D38` |
| Primär text | Text | `#E6EAF0` |
| Sekundär text | Text 2 | `#8B95A3` |
| Tyst text, axlar | Text 3 | `#5E6876` |
| Varumärke, länkar, fokus | Fjällblå | `#7E9CC2` |
| Varumärke, skugg-ton | Fjällblå djup | `#4E6A8F` |
| Svensk detalj | Kornguld | `#D4B36A` |
| Låg risk (0–29) | Grön | `#3FB97F` (bakgrund `#16291F`) |
| Förhöjd risk (30–59) | Orange | `#E5A13A` (bakgrund `#2E2414`) |
| Hög risk (60–100) | Röd | `#E5534B` (bakgrund `#321A1B`) |
| Går inte att avgöra | Streckat grått | `#3A4250` (diagonal skraffering) |

Regler:
- Riskfärg följer alltid poängen och betyder aldrig något annat. Knappar och länkar är fjällblå, aldrig gröna.
- Kornguld finns bara i loggan och i enstaka detaljer, aldrig i data. Annars kan det förväxlas med orange risk.
- Färg är aldrig ensam bärare av information: badges har både siffra och ord (`84 High`).
- Ljus variant av loggan: fjällblå djup `#4E6A8F` / `#2E4566` och mörkare guld `#B8913A` på `#F4F2EC`.

## Typografi och ton

- **Inter** (600 rubriker, 400 brödtext) för allt som ska läsas. Tabulära siffror överallt så att poäng och procent
  står still när de uppdateras.
- **JetBrains Mono** för allt som ska kopieras: adresser, selektorer, PC-offset och dekompilerad kod.
- Storlekar: 40 hero, 22–28 sidrubrik, 17–20 sektion, 15 brödtext, 12–13 metadata.

Ton: lugn, saklig och professionell, som en erfaren kollega som pekar på problemet utan att höja rösten.
- Svaret kommer först: `Likely honeypot: the owner can stop you from selling.` Detaljerna kommer sedan.
- Aktiv form och vardagsord: "the owner can", inte "privileged role detected".
- Högst två meningar per förklaring. Inga utropstecken, emojis eller skrämselord som "SCAM!!".
- Vi är ärliga om osäkerhet: sannolikheter är kalibrerade, och det vi inte kan veta står uttryckligen i ett eget fält.
- Produkttexten är på engelska, eftersom målgruppen är internationell.

## Komponentprinciper

1. **Svaret överst, beviset under.** Varje vy går från slutsats (poäng, en mening) till detalj (signal, selektor, kod).
   En trader ska förstå risken på tre sekunder och kunna verifiera den på trettio.
2. **Riskbadge**: rundad pill med tonad bakgrund, siffra i fetstil först och ord efter. Samma badge i lista, rubrik och API-svar.
3. **Mätare**: halvcirkel per risktyp (rug pull, honeypot, bot-pump). Procent i mitten och en rad som säger *varför*.
   Ingen nål, inga gradienter: bara en båge i riskfärgen.
4. **Signalrad**: färgad kantlinje till vänster (påverkans riktning), titel i klartext, risktyp som tagg och påverkan i
   poäng till höger (`+24`, `−5`). Utfälld visar den tre lager: selektorer → dekompilerad snutt med markerad rad →
   förklaring från Muse. Signaler som sänker risken visas också, så att betyget går att förstå åt båda hållen.
5. **"Can't tell"-panelen**: streckad ram och skraffering, aldrig grön eller röd. Den räknas inte in i betyget och säger det.
6. **Muse-attribution**: en liten fjällblå prick och ordet *Muse* vid varje genererad förklaring. Den skiljer
   maskinförklaring från fakta i bytecoden.
7. **Ytor**: inga skuggor, bara ytor i två nivåer och kanter på 1 px. Hörnradie 16 för kort, 14 för rader, 8–10 för
   knappar. Avstånd i steg om 4 px.
8. **Mono = kopierbart**: allt i monospace går att klicka för att kopiera.

## Skisserna

### 00 · Palett och komponenter
Referensblad för färger, badges, signalpåverkan och typskala, så att alla bygger med samma byggstenar.

### 01 · Startsida
DEXTools öppnar med ett myller av siffror. Vi öppnar med en enda fråga och ett sökfält, eftersom huvudflödet är
"klistra in en adress". Under det finns listan **Just deployed**, där nyaste token ligger överst med kort
markering. Varje rad visar samlat betyg, de tre sannolikheterna med minibar och den viktigaste signalen i klartext,
så att man kan skumma listan utan att klicka. Filterchips för hög och låg risk samt endast overifierade kontrakt.

### 02 · Tokensida
Kärnan i demon. Uppifrån och ned:
- **Samlat betyg** (ring 0–100) bredvid en mening som säger vad det betyder och två rader från Muse. Under det står
  analystid och en kalibreringsrad ("av tidigare tokens med 80–89 …"), så att siffran betyder något.
- **Tre mätare** för rug pull, honeypot och bot-pump, var och en med antal signaler och en orsak.
- **Signallistan**, sorterad efter påverkan. Den första är utfälld och visar hela beviskedjan: selektorer med
  PC-offset, dekompilerad kod med den avgörande raden markerad och en förklaring i klartext. Därefter finns
  knapparna "Copy evidence" och "Open in bytecode".
- **What bytecode alone can't tell you**: likviditetslås, vem som håller ägarnyckeln, avsikt, okända externa kontrakt,
  team och plånbokskluster. Panelen gör oss trovärdigare, eftersom den visar var modellens gräns går.
- Sidokolumnen innehåller kontraktsfakta, en minigraf som leder till tidslinjen, **liknande bytecode** (vad hände med
  tidigare kontrakt med samma layout) och API/MCP-anropet för den som vill använda resultatet i sin bot.

### 03 · Tidslinje
Visar hur risken har ändrats sedan deploy. Exemplet är en token som såg oskyldig ut vid deploy (41) och blev en
honeypot efter en proxy-uppgradering 11 minuter senare (78 → 91 → 84). Uppifrån och ned:
- **Steggraf** över betyget med riskzonerna som svaga band och numrerade händelsemarkörer. Steg i stället för en
  utjämnad kurva, eftersom risk ändras vid diskreta händelser.
- **Tre små grafer** för delsannolikheterna, så att man ser *vilken* risk som rörde sig.
- **Händelselogg** som är kopplad till markörerna. Varje rad visar källa (bytecode, storage eller pool event),
  förändring och nytt betyg. Den största förändringen har en förklaring från Muse.

Tidslinjen är också svaret på demofrågan "hur långt kommer man med bara bytecode?": vid deploy kommer man långt,
och när koden byts ut ser vi det direkt.
