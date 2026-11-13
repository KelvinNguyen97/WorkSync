import fs from 'node:fs';
import path from 'node:path';

/**
 * A plain log in the data folder (spec 06), one file a month, kept for six
 * months. It records errors and important steps such as backups and
 * restores, never task content.
 */
let folder: string | null = null;
const KEEP = 6;

export function startLog(logFolder: string): void {
  folder = logFolder;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const old = fs
      .readdirSync(folder)
      .filter((f) => /^worksync-\d{4}-\d{2}\.log$/.test(f))
      .sort()
      .slice(0, -KEEP);
    for (const f of old) fs.rmSync(path.join(folder, f));
  } catch {
    // Logging never stops the app.
  }
}

export const logFolder = () => folder;

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  if (!folder) return;
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  try {
    fs.appendFileSync(
      path.join(folder, `worksync-${month}.log`),
      `${now.toISOString()} ${level.toUpperCase()} ${message.replace(/\s+/g, ' ')}\n`,
    );
  } catch {
    // Logging never stops the app.
  }
}
