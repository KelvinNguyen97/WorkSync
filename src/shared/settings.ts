/** App-wide settings (spec 03, Projects and settings) and backups (spec 06). */
import type { LanguageCode } from './model';
import type { UiLanguageChoice } from './i18n';

export interface AppSettings {
  /** The working language a new project starts with. */
  workingLanguage: LanguageCode;
  /** The Due soon days a new project starts with. */
  dueSoonDays: number;
  /** Where backups go; null means the backups folder in the data folder. */
  backupFolder: string | null;
  /** System follows the operating system's light or dark setting. */
  theme: ThemeChoice;
  /** Closing the window keeps WorkSync running in the tray. */
  keepInTray: boolean;
  /** Windows notifications for My tasks. */
  reminders: boolean;
  /**
   * The shortcut that opens Catalog search from any app, as an Electron
   * accelerator such as CommandOrControl+Shift+F; null turns it off.
   */
  quickSearchKey: string | null;
  /** Search files on this PC with Everything (Windows). */
  everything: boolean;
  /** The language of WorkSync's own screens; projects keep their own languages. */
  uiLanguage: UiLanguageChoice;
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export const DEFAULT_SETTINGS: AppSettings = {
  workingLanguage: 'en',
  dueSoonDays: 7,
  backupFolder: null,
  theme: 'system',
  keepInTray: true,
  reminders: true,
  quickSearchKey: 'CommandOrControl+Shift+F',
  everything: true,
  uiLanguage: 'system',
};

export type BackupKind =
  | 'daily'
  | 'start'
  | 'upgrade'
  | 'restore'
  | 'delete'
  | 'manual';

export interface BackupInfo {
  file: string;
  name: string;
  kind: BackupKind;
  /** When it was written, as an ISO time. */
  at: string;
  size: number;
}

/** What the Settings screen shows about where data and backups live. */
export interface StorageInfo {
  dataFolder: string;
  backupFolder: string;
  /** True when the backup folder is the default one in the data folder. */
  defaultBackupFolder: boolean;
  /** A warning about the backup folder, such as one on the shared drive. */
  backupWarning: string | null;
  logFolder: string;
  backups: BackupInfo[];
}

/**
 * A warning for a folder that a sync service or other people can reach. The
 * data folder must not be in one; a backup folder may be, with a warning.
 */
export function sharedFolderWarning(folder: string): string | null {
  if (folder.startsWith('\\\\') || folder.startsWith('//'))
    return 'This folder is on a network drive. Anyone in the company with access can read or delete files there.';
  const parts = folder.split(/[\\/]/);
  const synced = parts.find((p) =>
    /^(box|box drive|onedrive( - .*)?|dropbox|google ?drive|my drive|icloud ?drive)$/i.test(
      p,
    ),
  );
  if (synced)
    return `This folder is synced by ${synced.replace(/ - .*/, '')}. Others may be able to see it, and a database there can be damaged while it syncs.`;
  return null;
}
