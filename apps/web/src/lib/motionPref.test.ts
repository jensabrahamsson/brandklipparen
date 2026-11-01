// Motion on/off storage (UI v2 §5.6, W-10). The preference is
// presentation state only: one `localStorage` key holding the closed
// union `on | off`. Any other stored value is ignored and motion stays
// on; the value never leaves the device.
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyMotionPref, MOTION_KEY, parseStoredMotion, readStoredMotion, writeStoredMotion } from "./motionPref.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("motion_pref_defaults_to_on", () => {
  test("missing storage gives on", () => {
    expect(readStoredMotion(memoryStorage())).toBe("on");
    expect(readStoredMotion(null)).toBe("on");
  });

  test("crafted and markup-bearing values give on", () => {
    for (const raw of [" off", "OFF", "On", "auto", "<script>alert(1)</script>", "on\0off", ""]) {
      expect(parseStoredMotion(raw)).toBe("on");
    }
  });

  test("the versioned key round-trips both values", () => {
    const storage = memoryStorage();
    writeStoredMotion("off", storage);
    expect(storage.getItem(MOTION_KEY)).toBe("off");
    expect(readStoredMotion(storage)).toBe("off");
    writeStoredMotion("on", storage);
    expect(readStoredMotion(storage)).toBe("on");
  });
});

describe("motion_pref_applies_data_attribute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("off pins data-motion and on removes it", () => {
    const dataset: Record<string, string | undefined> = {};
    vi.stubGlobal("document", { documentElement: { dataset } });
    applyMotionPref("off");
    expect(dataset["motion"]).toBe("off");
    applyMotionPref("on");
    expect(dataset["motion"]).toBeUndefined();
  });

  test("applying without a document is a no-op", () => {
    expect(() => applyMotionPref("off")).not.toThrow();
  });
});
