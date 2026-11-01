// Cancun stack-effect table shared by every engine (C-17, F-15, F-16,
// F-33). Single source of truth for opcode pops/pushes; null means the
// opcode is undefined in Cancun and behaves as INVALID (halts).
export type StackEffect = {
  readonly pops: number;
  readonly pushes: number;
  readonly halts: boolean;
};

function effect(pops: number, pushes: number, halts = false): StackEffect {
  return Object.freeze({ pops, pushes, halts });
}

const STOP = effect(0, 0, true);
const INVALID = effect(0, 0, true);

export function stackEffectOf(opcode: number): StackEffect | null {
  if (!Number.isInteger(opcode) || opcode < 0x00 || opcode > 0xff) {
    return null;
  }
  if (opcode === 0x00) {
    return STOP;
  }
  if (opcode >= 0x01 && opcode <= 0x07) {
    return effect(2, 1);
  }
  if (opcode === 0x08 || opcode === 0x09) {
    return effect(3, 1);
  }
  if (opcode === 0x0a || opcode === 0x0b) {
    return effect(2, 1);
  }
  if (opcode >= 0x10 && opcode <= 0x14) {
    return effect(2, 1);
  }
  if (opcode === 0x15) {
    return effect(1, 1);
  }
  if (opcode >= 0x16 && opcode <= 0x18) {
    return effect(2, 1);
  }
  if (opcode === 0x19) {
    return effect(1, 1);
  }
  if (opcode >= 0x1a && opcode <= 0x1d) {
    return effect(2, 1);
  }
  if (opcode === 0x20) {
    return effect(2, 1);
  }
  if (opcode === 0x30) {
    return effect(0, 1);
  }
  if (opcode === 0x31) {
    return effect(1, 1);
  }
  if (opcode === 0x32 || opcode === 0x33 || opcode === 0x34) {
    return effect(0, 1);
  }
  if (opcode === 0x35) {
    return effect(1, 1);
  }
  if (opcode === 0x36) {
    return effect(0, 1);
  }
  if (opcode === 0x37) {
    return effect(3, 0);
  }
  if (opcode === 0x38) {
    return effect(0, 1);
  }
  if (opcode === 0x39) {
    return effect(3, 0);
  }
  if (opcode === 0x3a) {
    return effect(0, 1);
  }
  if (opcode === 0x3b) {
    return effect(1, 1);
  }
  if (opcode === 0x3c) {
    return effect(4, 0);
  }
  if (opcode === 0x3d) {
    return effect(0, 1);
  }
  if (opcode === 0x3e) {
    return effect(3, 0);
  }
  if (opcode === 0x3f) {
    return effect(1, 1);
  }
  if (opcode === 0x40) {
    return effect(1, 1);
  }
  if (opcode >= 0x41 && opcode <= 0x48) {
    return effect(0, 1);
  }
  if (opcode === 0x49) {
    return effect(1, 1);
  }
  if (opcode === 0x4a) {
    return effect(0, 1);
  }
  if (opcode === 0x50) {
    return effect(1, 0);
  }
  if (opcode === 0x51) {
    return effect(1, 1);
  }
  if (opcode === 0x52 || opcode === 0x53) {
    return effect(2, 0);
  }
  if (opcode === 0x54) {
    return effect(1, 1);
  }
  if (opcode === 0x55) {
    return effect(2, 0);
  }
  if (opcode === 0x56) {
    return effect(1, 0);
  }
  if (opcode === 0x57) {
    return effect(2, 0);
  }
  if (opcode === 0x58 || opcode === 0x59 || opcode === 0x5a) {
    return effect(0, 1);
  }
  if (opcode === 0x5b) {
    return effect(0, 0);
  }
  if (opcode === 0x5c) {
    return effect(1, 1);
  }
  if (opcode === 0x5d) {
    return effect(2, 0);
  }
  if (opcode === 0x5e) {
    return effect(3, 0);
  }
  if (opcode === 0x5f) {
    return effect(0, 1);
  }
  if (opcode >= 0x60 && opcode <= 0x7f) {
    return effect(0, 1);
  }
  if (opcode >= 0x80 && opcode <= 0x8f) {
    const n = opcode - 0x80 + 1;
    return effect(n, n + 1);
  }
  if (opcode >= 0x90 && opcode <= 0x9f) {
    const n = opcode - 0x90 + 1;
    return effect(n + 1, n + 1);
  }
  if (opcode >= 0xa0 && opcode <= 0xa4) {
    return effect(2 + (opcode - 0xa0), 0);
  }
  if (opcode === 0xf0) {
    return effect(3, 1);
  }
  if (opcode === 0xf1 || opcode === 0xf2) {
    return effect(7, 1);
  }
  if (opcode === 0xf3) {
    return effect(2, 0, true);
  }
  if (opcode === 0xf4) {
    return effect(6, 1);
  }
  if (opcode === 0xf5) {
    return effect(4, 1);
  }
  if (opcode === 0xfa) {
    return effect(6, 1);
  }
  if (opcode === 0xfd) {
    return effect(2, 0, true);
  }
  if (opcode === 0xfe) {
    return INVALID;
  }
  if (opcode === 0xff) {
    return effect(1, 0, true);
  }
  return null;
}
