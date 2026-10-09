// Storage seam for the canvas document.
//
// In AwwO this module (canvasStorage.ts) scoped every key to the signed-in user, tenant and canvas
// and compacted baselines under quota pressure. The open-source canvas has no accounts, so the
// seam is reduced to its contract: one Storage-like object for the canvas and one for
// workspace-wide preferences. Browsers get localStorage; anything else (Node, tests, a worker)
// gets an in-memory map, so the pure modules never touch an undefined global.

export type CanvasStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { keys(): string[] };

function memoryStorage(): CanvasStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    keys: () => [...data.keys()],
  };
}

function wrap(storage: Storage): CanvasStorage {
  return {
    getItem: key => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: key => storage.removeItem(key),
    keys: () => Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null),
  };
}

let override: CanvasStorage | null = null;
let fallback: CanvasStorage | null = null;

/** Replace the backing store (tests, an embedding host, a server-side renderer). */
export function configureCanvasStorage(storage: CanvasStorage | null): void {
  override = storage;
}

export function canvasStorage(): CanvasStorage {
  if (override) return override;
  const local = (globalThis as { localStorage?: Storage }).localStorage;
  if (local) return wrap(local);
  return (fallback ??= memoryStorage());
}

/** Workspace-wide preferences share the canvas store in the open-source edition. */
export function workspaceStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  return canvasStorage();
}

/** AwwO namespaced keys per account; here a key is its own name. */
export function canvasStorageKey(key: string): string {
  return key;
}

export function userStorageKey(key: string): string | null {
  return key;
}
