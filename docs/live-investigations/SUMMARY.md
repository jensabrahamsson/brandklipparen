# Live investigation runs

Generated 2026-11-03T21:40:42.177Z against Ethereum mainnet, 20 tokens run one after another with a pause between them.

| Token | Status | Steps used | Model calls | Verdict | Sentences kept / dropped | Score | Score identical with and without Muse | Provider tokens | 8000-limit units | Time | Log |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| USDT (earlier run) | done | 5 | 6 | The owner can stop chosen wallets from sending tokens. [E:dev.brandklipparen.blacklist:blacklist-extended] An owner account controls priv... | 4 / 0 | 60 | yes | 49546 | 907 | 48.6 s | [json](0xdAC17F958D2ee523a2206206994597C13D831ec7.json) |
| USDC (earlier run) | done | 1 | 2 | An owner account controls privileged functions. [E:signal:0xcc0a6bf4ceb3aa391e1bd2ec001ea8dfb16e4e76a75fb910f8c61f2aba790da3] The owner c... | 4 / 0 | 60 | yes | 16269 | 608 | 21.1 s | [json](0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48.json) |
| DAI (earlier run) | done | 2 | 3 | The owner can stop chosen wallets from sending tokens. [E:dev.brandklipparen.blacklist:blacklist-extended] The contract can write storage... | 3 / 0 | 60 | yes | 19002 | 525 | 24.1 s | [json](0x6B175474E89094C44Da98b954EedeAC495271d0F.json) |
| LINK | done | 1 | 2 | The contract exposes standard ERC-20 transfer and transferFrom functions. [E:dev.brandklipparen.decompiler:0xa9059cbb] [E:dev.brandklippa... | 4 / 0 | 60 | yes | 9503 | 640 | 15.1 s | [json](0x514910771AF9Ca656af840dff83E8264EcF986CA.json) |
| UNI | done | 7 | 8 | A function matching the mint selector was found in the bytecode. [E:dev.brandklipparen.decompiler:0x40c10f19] Standard token functions fo... | 3 / 0 | 30 | yes | 58273 | 1072 | 57.7 s | [json](0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984.json) |
| PEPE | done | 5 | 6 | The code includes an owner-controlled setRule function which raises medium rug-pull risk, but no controlling account is proven and the co... | 3 / 0 | 24 | yes | 41110 | 1127 | 42.0 s | [json](0x6982508145454Ce325dDbE47a25d4ec3d2311933.json) |
| SHIB | done | 1 | 2 | The bytecode exposes standard ERC-20 functions including name, symbol, decimals, totalSupply, balanceOf, allowance, transfer, transferFro... | 3 / 0 | 20 | yes | 9025 | 1093 | 13.9 s | [json](0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE.json) |
| ZIPCAT | done | 3 | 4 | The owner can stop chosen wallets from sending tokens. [E:dev.brandklipparen.blacklist:blacklist-extended] An owner account controls priv... | 4 / 0 | 60 | yes | 33114 | 864 | 29.4 s | [json](0x4c5fc2efd7f9fba2c6a9227abd9d1c3eefd6bdd7.json) |
| NEW01 | done | 1 | 2 | The contract implements standard ERC-20 metadata getters for name, symbol and decimals. [E:dev.brandklipparen.decompiler:0x06fdde03] [E:d... | 3 / 0 | 19 | yes | 6795 | 694 | 12.0 s | [json](0xb8587843e247c9ede533edec32e64354eebb5470.json) |
| NEW02 | done | 2 | 3 | The owner can stop chosen wallets from sending tokens. [E:dev.brandklipparen.blacklist:blacklist-extended] The transfer function was deco... | 2 / 0 | 60 | yes | 15569 | 377 | 17.2 s | [json](0xeb1c9afe0c5d4237f4bb148a81faed2e4fabfbe3.json) |
| NEW03 | done | 1 | 2 | The owner can stop chosen wallets from sending tokens. [E:dev.brandklipparen.blacklist:blacklist-extended] The blacklist gate was found i... | 4 / 0 | 60 | yes | 11378 | 589 | 11.5 s | [json](0x6bd4c81b1633b6b2d7bf500214b6cfad256c8bdd.json) |
| NEW04 | done | 1 | 2 | The bytecode exposes standard ERC-20 views name, symbol, decimals, totalSupply, balanceOf and allowance. [E:dev.brandklipparen.decompiler... | 3 / 0 | 19 | yes | 8844 | 1043 | 11.8 s | [json](0x2de7ad079d532e92a2083280e5b24ac3629b076a.json) |
| NEW05 | done | 7 | 8 | The bytecode exposes standard token entry points including name, approve, totalSupply, transferFrom, decimals and balanceOf. [E:dev.brand... | 3 / 0 | 20 | yes | 45613 | 1302 | 45.3 s | [json](0xc3dfa2d7e82e3416a85a5542a229d9bedb6d04f2.json) |
| NEW06 | done | 4 | 5 | An owner account controls privileged functions which raises rug-pull risk. [E:signal:0x8cdfe2bb9abffe04465ccc3f859b4f423b09af4af1d5a2ecb6... | 4 / 0 | 60 | yes | 39993 | 1047 | 37.5 s | [json](0x27c1ba4f85b8dc1c150157816623a6ce80b7f187.json) |
| NEW07 | done | 7 | 8 | The contract exposes ERC20 metadata functions name, symbol and decimals. [E:dev.brandklipparen.decompiler:0x06fdde03] [E:dev.brandklippar... | 3 / 0 | 19 | yes | 28597 | 1058 | 41.5 s | [json](0x8bb6aa42be6551d9843ce3f4ec5297b6c0d9179c.json) |
| NEW08 | done | 2 | 3 | The owner can stop chosen wallets from sending tokens affecting transferFrom and burn. [E:dev.brandklipparen.blacklist:blacklist-extended... | 4 / 0 | 60 | yes | 16076 | 961 | 25.2 s | [json](0x36e8dbaeeecd88273917232238e10623ff4b479f.json) |
| NEW09 | done | 2 | 3 | The contract exposes a standard ERC-20 interface with name, symbol, decimals, totalSupply, balanceOf, allowance, transfer, approve and tr... | 5 / 0 | 19 | yes | 13265 | 1295 | 19.9 s | [json](0xc96aa65f31e41b4ca6924b86d93e25686019e59c.json) |
| NEW10 | done | 7 | 8 | The code includes a burn capability via burn(uint256) and function 0x79ba5097 that can change state later with no controlling account pro... | 4 / 0 | 23 | yes | 50723 | 1379 | 47.5 s | [json](0x9a0af943fcad097f276c4b10fa4f497afa3629d6.json) |
| NEW11 | done | 3 | 4 | An owner account controls privileged functions, which raises rug-pull risk at medium severity and can change later with no controlling ac... | 4 / 0 | 29 | yes | 27498 | 1326 | 31.8 s | [json](0x798d1be841a82a273720ce31c822c61a67a601c3.json) |
| NEW12 | done | 2 | 3 | The bytecode exposes standard ERC-20 metadata and supply views for name, symbol, decimals and totalSupply. [E:dev.brandklipparen.decompil... | 2 / 0 | 19 | yes | 9919 | 742 | 12.5 s | [json](0x8ebc5b9cc678aa85953a1481163bca5e8f30629f.json) |

Rows marked (earlier run) come from an earlier run of the same script and limits; they were not re-run, so their JSON has "reused": false.

## Totals and averages

- Tokens run: 20. Finished with a cited conclusion: 20. Failed or not finished: 0.
- Model calls: 84. Muse tokens (provider usage): 510112.
- Estimated cost: not computed (no price given).
- Score identical with and without Muse: 20 of 20.
- Averages over finished runs: 3.2 steps, 25505.6 tokens, 28.3 s per token.
- Total time for all runs: 565.7 s.

## Failures

None. Every token finished with a cited conclusion.

## Method

- Analysis: the deterministic analysis runs once per token through the REST route's application service. The score envelope is serialized before and after the Muse loop; a matching hash means the loop left the score and evidence untouched.
- Steps: the investigation trace (tool, reason, evidence ids). Model calls include the conclude call.
- Sentences: the conclude draft is split with the app's splitter and each sentence is checked against the collected evidence with the app's citation check. Dropped sentences are listed in each JSON log.
- Tokens: the provider's own usage figures per call, summed. Shown as n/a when the provider reports none.
- Limits used: 8 steps, 8000 units and 60 s per investigation, plus a 5 s per-tool limit. Set explicitly in the script.
- The 8000 limit is not a provider token count. The app charges each accepted decision its text length (rationale for a tool step, draft for the conclusion) plus 10, and stops at 8000 units. The column 8000-limit units shows that sum. Prompt tokens and model reasoning tokens are not counted against it. The Provider tokens column is the provider's own usage figure, summed over every call of the run, and is not capped by 8000.
- The completion request asks the provider for at most min(8192, units left), so late in a run the allowance can be small.

## Known limitations

- Known false positives: LINK and DAI score 60 (High) because the blacklist detector flags them, but neither token lets an owner block holders. LINK's cited function is `transferAndCall`. Muse repeated the finding instead of catching it; the citation check only proves a claim cites evidence, not that the evidence is right.
