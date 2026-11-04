/** Session storage can be blocked in an embedded page; a missing value is fine. */
export const session = {
  get(k: string): string | null {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  remove(k: string): void {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
