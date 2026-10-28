# Brandklipparen

**The question:** how far do you get with bytecode alone?

Brandklipparen scores the risk of new Ethereum tokens directly from the contract bytecode:
rug pull, honeypot and bot-pump. Out come calibrated probabilities with evidence,
that is which patterns in the bytecode raised or lowered the risk.

## Parts
- Decompilation of unverified contracts (e.g. extdecomp)
- Pattern recognition in bytecode: function selectors, proxies, owner and mint controls, fees, blacklist/pause
- Later: pool events and early wallets as extra evidence
- Muse explains the findings in plain English
- Interface: web UI, MCP server and REST API with key

## Demo
Paste a contract address, get a risk profile + explanation in seconds.

## Two focuses
1. **The model:** as accurate as possible with bytecode alone, with calibrated probabilities and evidence for every signal. Thresholds and weights are derived anew here.
2. **UX and UI:** fantastic. Paste an address and understand the risk in seconds, with plain-text explanations.

## UI direction
Inspiration: DEXTools (https://www.dextools.io), but considerably better. Token page with a clear risk score on top,
probabilities for rug pull, honeypot and bot-pump, and every signal with evidence (which function in the bytecode) and
a plain-text explanation. Fast, dark theme, understandable in seconds.

## The name
Brandklipparen was Charles XII's horse: fast, vigilant and reliable.
