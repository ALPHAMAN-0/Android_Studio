// In-memory stand-in for @capacitor/preferences (same async API, no WebView needed).
export const store = new Map();

export const Preferences = {
  async get({ key }) {
    return { value: store.has(key) ? store.get(key) : null };
  },
  async set({ key, value }) {
    store.set(key, value);
  },
  async remove({ key }) {
    store.delete(key);
  },
  async clear() {
    store.clear();
  },
  async keys() {
    return { keys: [...store.keys()] };
  },
};
