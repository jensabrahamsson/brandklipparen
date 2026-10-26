# Brandklipparen

**Frågan:** hur långt kommer man med bara bytecode?

Brandklipparen bedömer risken för nya Ethereum-tokens direkt från kontraktets bytecode:
rug pull, honeypot och bot-pump. Ut kommer kalibrerade sannolikheter med bevis,
alltså vilka mönster i bytecoden som drog upp eller ner risken.

## Delar
- Dekompilering av overifierade kontrakt (t.ex. extdecomp)
- Mönsterigenkänning i bytecode: funktionsselektorer, proxyer, ägar- och mintkontroller, avgifter, blacklist/pause
- Senare: pool-händelser och tidiga plånböcker som extra bevis
- Muse förklarar fynden på vanlig engelska
- Gränssnitt: webb-UI, MCP-server och REST-API med nyckel

## Demo
Klistra in en kontraktsadress, få riskprofil + förklaring på några sekunder.

## Två fokus
1. **Modellen:** så träffsäker som möjligt med bara bytecode, med kalibrerade sannolikheter och bevis för varje signal. Trösklar och vikter tas fram nya här.
2. **UX och UI:** fantastiskt. Klistra in en adress och förstå risken på några sekunder, med förklaringar i klartext.

## UI-riktning
Inspiration: DEXTools (https://www.dextools.io), fast betydligt bättre. Tokensida med tydligt riskbetyg överst,
sannolikheter för rug pull, honeypot och bot-pump, och varje signal med bevis (vilken funktion i bytecoden) och
en förklaring i klartext. Snabbt, mörkt tema, går att förstå på några sekunder.

## Namnet
Brandklipparen var Karl XII:s häst: snabb, vaksam och pålitlig.
