import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where WorkSync keeps its data.
 *
 * On Windows the app is unzipped into a folder such as D:\Tools\WorkSync, and
 * its data lives in a folder beside it, WorkSync-data, so replacing the app
 * folder with a new version never touches the data.
 *
 * macOS apps sit in Applications (or run from a read-only copy macOS makes of
 * a downloaded app), and the Linux packages install into system folders, so
 * there the data goes into the user's app-data folder. A WorkSync-data folder
 * an earlier version made beside the app is still used.
 *
 * During development the data goes into the user's app-data folder.
 */
export function dataFolderPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getPath('userData'), 'WorkSync-data-dev');
  }
  const beside = path.join(
    path.dirname(path.dirname(process.execPath)),
    'WorkSync-data',
  );
  if (process.platform === 'win32') return beside;
  // Earlier versions put it beside the folder that holds WorkSync.app.
  const earlier =
    process.platform === 'darwin'
      ? path.join(
          path.dirname(
            path.resolve(path.dirname(process.execPath), '..', '..', '..'),
          ),
          'WorkSync-data',
        )
      : beside;
  if (fs.existsSync(earlier)) return earlier;
  return path.join(app.getPath('userData'), 'WorkSync-data');
}

/** True for a path on a network share, such as \\server\share. */
export const isNetworkPath = (p: string): boolean =>
  p.startsWith('\\\\') || p.startsWith('//');
