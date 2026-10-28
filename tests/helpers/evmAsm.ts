// Minimal test-only EVM assembler for hand-built fixtures: emits bytes
// with label fixups for PUSH2 destinations, so fixtures carry proven
// jump targets without hand-counted PCs. Production code never
// assembles; this helper lives in the test tree only.
export class Asm {
  private bytes: number[] = [];
  private labels = new Map<string, number>();
  private fixups: { pos: number; label: string; width: number }[] = [];

  get pc(): number {
    return this.bytes.length;
  }

  label(name: string): this {
    this.labels.set(name, this.bytes.length);
    return this;
  }

  op(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  push1(value: number): this {
    return this.op(0x60, value & 0xff);
  }

  push2(value: number): this {
    return this.op(0x61, (value >> 8) & 0xff, value & 0xff);
  }

  push4(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = [0x63];
    for (let index = 0; index < 8; index += 2) {
      out.push(parseInt(clean.slice(index, index + 2), 16));
    }
    return this.op(...out);
  }

  pushLabel2(label: string): this {
    return this.pushLabel(2, label);
  }

  pushLabel(width: 1 | 2 | 3 | 4, label: string): this {
    const opcode = [0x60, 0x61, 0x62, 0x63][width - 1] ?? 0x61;
    this.fixups.push({ pos: this.bytes.length + 1, label, width });
    this.bytes.push(opcode);
    for (let index = 0; index < width; index += 1) {
      this.bytes.push(0x00);
    }
    return this;
  }

  build(): string {
    const out = this.bytes.slice();
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) {
        throw new Error(`unknown label ${fixup.label}`);
      }
      for (let index = 0; index < fixup.width; index += 1) {
        out[fixup.pos + fixup.width - 1 - index] = (target >> (8 * index)) & 0xff;
      }
    }
    return `0x${out.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}
