import { useEffect, useState } from 'react';
import { LANGUAGES, type LanguageCode } from '../shared/model';
import type { BackupInfo, BackupKind, StorageInfo } from '../shared/settings';
import { useApp } from './appState';
import { Icon } from './Icon';
import { Modal } from './parts';
import {
  acceleratorFor,
  shortcutLabel,
  type EverythingState,
} from '../shared/catalog';
import { tr } from './i18n';
import {
  UI_LANGUAGES,
  resolveUiLanguage,
  type UiLanguageChoice,
} from '../shared/i18n';

const KIND_NAME: Record<BackupKind, string> = {
  daily: 'Daily',
  start: 'At start',
  upgrade: 'Before an upgrade',
  restore: 'Before a restore',
  delete: 'Before deleting a project',
  manual: 'Made by you',
};

const size = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

const when = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Settings (spec 03): defaults for new projects, where the data and the
 * backups are, and restoring a backup (spec 06).
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, setSettings, attempt, toast } = useApp();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [days, setDays] = useState(String(settings.dueSoonDays));
  const [restoring, setRestoring] = useState<{
    file: string;
    name: string;
    at: string;
    projects: number;
    tasks: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const r = await attempt(() => window.worksync.storageInfo());
    if (r) setInfo(r);
  };
  useEffect(() => {
    void reload();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (
    patch: Parameters<typeof window.worksync.updateSettings>[0],
  ) => {
    const s = await attempt(() => window.worksync.updateSettings(patch));
    if (s) {
      setSettings(s);
      return true;
    }
    return false;
  };

  const chooseFolder = async () => {
    const folder = await attempt(() => window.worksync.chooseBackupFolder());
    if (!folder) return;
    if (await save({ backupFolder: folder })) {
      await reload();
      toast(tr('Backups now go to the folder you chose.'));
    }
  };

  const backupNow = async () => {
    setBusy(true);
    const r = await attempt(() => window.worksync.backupNow());
    setBusy(false);
    if (r) {
      setInfo(r);
      toast(tr('Backup made.'));
    }
  };

  const askRestore = async (b: Pick<BackupInfo, 'file' | 'name' | 'at'>) => {
    const r = await attempt(() => window.worksync.inspectBackup(b.file));
    if (r) setRestoring({ ...b, ...r });
  };

  const fromFile = async () => {
    const file = await attempt(() => window.worksync.chooseBackupFile());
    if (file)
      await askRestore({
        file,
        name: file.split(/[\\/]/).pop() ?? file,
        at: '',
      });
  };

  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    // The app restarts with the restored data, so nothing comes back on success.
    await attempt(() => window.worksync.restoreBackup(restoring.file));
    setBusy(false);
  };

  if (restoring)
    return (
      <Modal
        title={tr('Restore this backup?')}
        subtitle={restoring.name}
        onClose={() => setRestoring(null)}
        narrow
        footer={
          <>
            <button className="btn" onClick={() => setRestoring(null)}>
              {tr('Cancel')}
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void restore()}
            >
              <Icon name="refresh" />
              {busy ? tr('Restoring…') : tr('Restore and restart')}
            </button>
          </>
        }
      >
        <p>
          {tr('The backup')}
          {restoring.at ? ` from ${when(restoring.at)}` : ''} holds{' '}
          <b>
            {restoring.projects} project{restoring.projects === 1 ? '' : 's'}
          </b>{' '}
          and{' '}
          <b>
            {restoring.tasks} task{restoring.tasks === 1 ? '' : 's'}
          </b>
          .
        </p>
        <p className="muted">
          {tr(
            'Everything changed since then is replaced. Your data as it is now is backed up first, as “Before a restore”, so you can go back. WorkSync then restarts with the restored data.',
          )}
        </p>
      </Modal>
    );

  return (
    <Modal
      title={tr('Settings')}
      subtitle={tr(
        'For the whole app. Each project keeps its own settings too.',
      )}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {tr('Done')}
        </button>
      }
    >
      <div className="form settings">
        <fieldset>
          <legend>{tr('Appearance')}</legend>
          <div className="set-row">
            <span>
              <b>{tr('App language')}</b>
              <small>
                {tr(
                  'Menus, buttons and messages. A project’s languages, translations and reports don’t change.',
                )}
              </small>
            </span>
            <select
              className="inp set-select"
              aria-label={tr('App language')}
              value={settings.uiLanguage}
              onChange={(e) =>
                void save({ uiLanguage: e.target.value as UiLanguageChoice })
              }
            >
              <option value="system">
                {tr('Same as the computer ({lang})', {
                  lang: UI_LANGUAGES[
                    resolveUiLanguage('system', navigator.language)
                  ],
                })}
              </option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </div>
          <div className="set-row">
            <span>
              <b>{tr('Theme')}</b>
              <small>
                {tr('System follows your computer’s light or dark setting.')}
              </small>
            </span>
            <div className="seg-ctl" role="group" aria-label={tr('Theme')}>
              {(
                [
                  ['system', 'System'],
                  ['light', 'Light'],
                  ['dark', 'Dark'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  aria-pressed={settings.theme === k}
                  onClick={() => void save({ theme: k })}
                >
                  {tr(l)}
                </button>
              ))}
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>{tr('Running in the background')}</legend>
          <div className="set-row">
            <span>
              <b>{tr('Keep running in the tray when I close the window')}</b>
              <small>
                {tr(
                  'Reminders and the quick-search shortcut work only while WorkSync runs. Open it again or quit from the tray icon. WorkSync doesn’t start with your computer and writes nothing to the system.',
                )}
              </small>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={settings.keepInTray}
              aria-label={tr('Keep running in the tray')}
              onClick={() => void save({ keepInTray: !settings.keepInTray })}
            >
              <span />
            </button>
          </div>
          <div className="set-row">
            <span>
              <b>{tr('Reminders for My tasks')}</b>
              <small>
                {tr(
                  'Notifications by each task’s status and priority. Turn one task’s bell off in My tasks.',
                )}
              </small>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={settings.reminders}
              aria-label={tr('Reminders for My tasks')}
              onClick={() => void save({ reminders: !settings.reminders })}
            >
              <span />
            </button>
          </div>
        </fieldset>

        <QuickSearchSettings save={save} />

        <fieldset>
          <legend>{tr('New projects')}</legend>
          <div className="two">
            <label>
              {tr('Working language')}
              <select
                className="inp"
                value={settings.workingLanguage}
                onChange={(e) =>
                  void save({
                    workingLanguage: e.target.value as LanguageCode,
                  })
                }
              >
                {(Object.keys(LANGUAGES) as LanguageCode[]).map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGES[l]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr('Due soon, in days')}
              <input
                className="inp"
                type="number"
                min={1}
                max={60}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                onBlur={() => {
                  const n = Number(days);
                  if (n !== settings.dueSoonDays)
                    void save({ dueSoonDays: n }).then(
                      (ok) => ok || setDays(String(settings.dueSoonDays)),
                    );
                }}
              />
            </label>
          </div>
          <span className="hint-text">
            {tr(
              'A new project starts with these. Change them for one project in its Project settings.',
            )}
          </span>
        </fieldset>

        <fieldset>
          <legend>{tr('Data')}</legend>
          <div className="set-row">
            <span>
              <b>{tr('Data folder')}</b>
              <code title={info?.dataFolder}>{info?.dataFolder ?? '…'}</code>
              <small>
                {tr(
                  'A new version of WorkSync never touches it. On Windows it sits beside the app folder: to move it, move the WorkSync folder and its WorkSync-data folder together.',
                )}
              </small>
            </span>
            <button
              className="btn sm"
              onClick={() =>
                void attempt(() => window.worksync.openFolder('data'))
              }
            >
              <Icon name="folder" />
              {tr('Open')}
            </button>
          </div>
          <div className="set-row">
            <span>
              <b>{tr('Log files')}</b>
              <code title={info?.logFolder}>{info?.logFolder ?? '…'}</code>
              <small>
                {tr('Errors and steps such as backups, never task text.')}
              </small>
            </span>
            <button
              className="btn sm"
              onClick={() =>
                void attempt(() => window.worksync.openFolder('logs'))
              }
            >
              <Icon name="folder" />
              {tr('Open')}
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend>{tr('Backups')}</legend>
          <div className="set-row">
            <span>
              <b>{tr('Backup folder')}</b>
              <code title={info?.backupFolder}>
                {info?.backupFolder ?? '…'}
              </code>
              <small>
                {info?.defaultBackupFolder
                  ? tr(
                      'In the data folder. A second drive or a USB drive is safer, because it survives a disk failure.',
                    )
                  : tr(
                      'WorkSync backs up when it starts and once a day, and keeps the last 14 days.',
                    )}
              </small>
            </span>
            <span className="set-actions">
              <button className="btn sm" onClick={() => void chooseFolder()}>
                <Icon name="folder" />
                {tr('Change')}
              </button>
              {info && !info.defaultBackupFolder && (
                <button
                  className="btn sm"
                  onClick={() =>
                    void save({ backupFolder: null }).then(async (ok) => {
                      if (ok) await reload();
                    })
                  }
                >
                  {tr('Use the data folder')}
                </button>
              )}
            </span>
          </div>
          {info?.backupWarning && (
            <p className="set-warn" role="alert">
              <Icon name="alert" />
              {info.backupWarning}
            </p>
          )}
          <div className="set-head">
            <b>
              {info
                ? tr(info.backups.length === 1 ? '{n} backup' : '{n} backups', {
                    n: info.backups.length,
                  })
                : tr('Backups')}
            </b>
            <span className="set-actions">
              <button className="btn sm" onClick={() => void fromFile()}>
                {tr('Restore from a file…')}
              </button>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => void backupNow()}
              >
                <Icon name="save" />
                {tr('Back up now')}
              </button>
            </span>
          </div>
          <div className="backup-list">
            {info?.backups.map((b) => (
              <div key={b.file} className="backup-row">
                <span className="mono">{when(b.at)}</span>
                <span>{KIND_NAME[b.kind]}</span>
                <span className="muted">{size(b.size)}</span>
                <button
                  className="btn sm"
                  onClick={() => void askRestore(b)}
                  aria-label={`Restore the backup from ${when(b.at)}`}
                >
                  {tr('Restore')}
                </button>
              </div>
            ))}
            {info && !info.backups.length && (
              <p className="muted">
                {tr(
                  'No backups yet. The first one is made the next time WorkSync starts, or now with Back up now.',
                )}
              </p>
            )}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

const EVERYTHING_TEXT: Record<EverythingState, string> = {
  ok: 'Everything is running.',
  starting: 'Everything starts the first time you search.',
  unavailable: 'Everything was not found next to WorkSync.',
  off: 'Off: only the Catalog is searched.',
  unsupported: 'Everything is for Windows only.',
};

/** The quick-search shortcut and Everything (FileManagement's Catalog search). */
function QuickSearchSettings({
  save,
}: {
  save: (
    patch: Parameters<typeof window.worksync.updateSettings>[0],
  ) => Promise<boolean>;
}) {
  const { settings } = useApp();
  const [recording, setRecording] = useState(false);
  const [state, setState] = useState<EverythingState | null>(null);
  const mac = navigator.userAgent.includes('Mac');
  const win = navigator.userAgent.includes('Windows');
  useEffect(() => {
    void window.worksync.everythingStatus().then(setState, () => {});
  }, [settings.everything]);
  return (
    <fieldset>
      <legend>{tr('Quick search')}</legend>
      <div className="set-row">
        <span>
          <b>{tr('Shortcut')}</b>
          <small>
            {tr('Opens Catalog search from any app, while WorkSync runs.')}
            {recording
              ? tr(' Press the keys you want, with Ctrl or Alt. Esc cancels.')
              : ''}
          </small>
        </span>
        <span className="set-actions">
          {recording ? (
            <button
              className="btn sm shortcut-rec"
              autoFocus
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setRecording(false);
                  return;
                }
                const accel = acceleratorFor(e);
                if (!accel) return;
                setRecording(false);
                void save({ quickSearchKey: accel });
              }}
            >
              {tr('Press the keys…')}
            </button>
          ) : (
            <>
              <span className="cat-kbd shortcut-now">
                {shortcutLabel(settings.quickSearchKey, mac)}
              </span>
              <button className="btn sm" onClick={() => setRecording(true)}>
                {tr('Change')}
              </button>
              {settings.quickSearchKey && (
                <button
                  className="btn sm"
                  onClick={() => void save({ quickSearchKey: null })}
                >
                  {tr('Turn off')}
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {win && (
        <div className="set-row">
          <span>
            <b>{tr('Search files with Everything')}</b>
            <small>
              {tr('Files on this PC appear under the Catalog results.')}{' '}
              {state ? EVERYTHING_TEXT[state] : ''}
            </small>
          </span>
          <button
            className="switch"
            role="switch"
            aria-checked={settings.everything}
            aria-label={tr('Search files with Everything')}
            onClick={() => void save({ everything: !settings.everything })}
          >
            <span />
          </button>
        </div>
      )}
    </fieldset>
  );
}
