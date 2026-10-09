// The upstream AwwO tests ran under jsdom, which provides localStorage. The core needs nothing
// else from a DOM, so a small spec-shaped Storage keeps these tests on the plain Node environment.
import { beforeEach } from 'vitest';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });

beforeEach(() => storage.clear());
