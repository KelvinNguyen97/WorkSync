import {
  nativeImage,
  nativeTheme,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { TRAY_ICON, TRAY_TEMPLATE, WINDOW_ICON } from './iconData';

/**
 * The window's own title bar: WorkSync draws it (see .titlebar in the page)
 * instead of the system, so it no longer takes the Windows accent color. The
 * system still draws its window buttons (minimize, maximize, close) on top.
 *
 * Glass:
 * - Windows 11 (22H2 and later): the system's acrylic blur behind the window
 *   edge and title bar.
 * - macOS: the system's vibrancy behind them, with the usual traffic lights.
 * - Windows 10 and Linux: a frosted look drawn by the page.
 */
export const TITLEBAR_HEIGHT = 40;

export type Glass = 'acrylic' | 'vibrancy' | 'drawn';

export function glassKind(): Glass {
  if (process.platform === 'darwin') return 'vibrancy';
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    if (build >= 22621) return 'acrylic';
  }
  return 'drawn';
}

const png = (b64: string) =>
  nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));

/** The app icon for the window (the taskbar on Windows and Linux). */
export const windowIcon = () => png(WINDOW_ICON);

/** The tray icon at 1x and 2x; a template image on macOS, which recolors it. */
export function trayImage() {
  const [one, two] = process.platform === 'darwin' ? TRAY_TEMPLATE : TRAY_ICON;
  const img = png(one);
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(two, 'base64') });
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

/** Colors for the system's window buttons, to match the theme. */
const buttons = () => ({
  // Clear, so the page's own title bar shows through.
  color: '#00000000',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#e7ebf2' : '#182030',
  height: TITLEBAR_HEIGHT,
});

/** Window options for the title bar and glass. */
export function chromeOptions(glass: Glass): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin')
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    };
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: buttons(),
    icon: windowIcon(),
    ...(glass === 'acrylic'
      ? { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
      : {}),
  };
}

/**
 * Windows: the taskbar takes the icon from the app's own .ico file, not only
 * from the .exe, whose old icon Windows may have cached (for example after a
 * new version was unzipped over the old one, or when WorkSync is pinned).
 */
export function taskbarIcon(win: BrowserWindow): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    win.setAppDetails({
      appId: 'com.worksync.desktop',
      appIconPath: path.join(process.resourcesPath, 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: 'WorkSync',
    });
  } catch {
    // The window icon set at creation still applies.
  }
}

/** Keeps the window buttons readable when the theme changes. */
export function followTheme(win: BrowserWindow): void {
  if (process.platform === 'darwin') return;
  const update = () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(buttons());
  };
  nativeTheme.on('updated', update);
  win.on('closed', () => nativeTheme.off('updated', update));
}
