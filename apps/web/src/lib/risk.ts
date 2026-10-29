import type { RiskBand, RiskKind, RiskWord } from "../types.ts";

// Risk bands per design/README.md: 0-29 Low (green), 30-59 Elevated
// (orange), 60-100 High (red). Badges always carry number and word
// together (K-103); color never carries the meaning alone.
export const LOW_BAND: RiskBand = Object.freeze({ word: "Low", min: 0, max: 29 });
export const ELEVATED_BAND: RiskBand = Object.freeze({ word: "Elevated", min: 30, max: 59 });
export const HIGH_BAND: RiskBand = Object.freeze({ word: "High", min: 60, max: 100 });

export function riskBand(score: number): RiskBand {
  if (score < 30) {
    return LOW_BAND;
  }
  if (score < 60) {
    return ELEVATED_BAND;
  }
  return HIGH_BAND;
}

export function riskWord(score: number): RiskWord {
  return riskBand(score).word;
}

// Short risk labels for compact bars and strips (S-131): Rug, Honey,
// Bot. Single source so the token page and the recent rows agree.
export const RISK_SHORT: Record<RiskKind, string> = Object.freeze({
  "rug-pull": "Rug",
  honeypot: "Honey",
  "bot-pump": "Bot",
});
