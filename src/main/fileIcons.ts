import { app } from 'electron';
import fs from 'node:fs';

/**
 * The icon the system shows for an app or file, as in the old app: an .exe
 * gets its own icon, a document the icon of the app that opens it. Read
 * with the system's own call (Windows: the shell icon), kept while the app
 * runs, and read again when the file changes. Null when there is none, and
 * the page then shows WorkSync's own icon.
 */
const cache = new Map<string, { stamp: number; url: string | null }>();
const MAX_PATHS = 300;

async function iconOf(p: string): Promise<string | null> {
  let stamp: number;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return null;
    stamp = st.mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(p);
  if (hit && hit.stamp === stamp) return hit.url;
  let url: string | null = null;
  try {
    const img = await app.getFileIcon(p, { size: 'normal' });
    if (!img.isEmpty()) url = img.toDataURL();
  } catch {
    url = null;
  }
  cache.set(p, { stamp, url });
  return url;
}

/** Icons for many paths at once, by path. */
export async function fileIcons(
  paths: string[],
): Promise<Record<string, string | null>> {
  if (!Array.isArray(paths)) return {};
  const list = [...new Set(paths.filter((p) => typeof p === 'string'))].slice(
    0,
    MAX_PATHS,
  );
  const out: Record<string, string | null> = {};
  for (const p of list) out[p] = await iconOf(p);
  return out;
}
