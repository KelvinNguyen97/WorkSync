import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    // Native files can't load from inside the archive.
    asar: { unpack: '**/*.node' },
    // A folder of Electron zips downloaded and checked beforehand, so the build
    // does not download Electron itself. The GitHub builds fill it with
    // .github/scripts/get-electron.sh; locally it can be ~/.cache/electron/<hash>.
    ...(process.env.WORKSYNC_ELECTRON_ZIP_DIR
      ? { electronZipDir: path.resolve(process.env.WORKSYNC_ELECTRON_ZIP_DIR) }
      : {}),
    name: 'WorkSync',
    executableName: 'worksync',
    // The app icon (.ico on Windows, .icns on macOS); made by
    // build/icon/make-icons.mjs.
    icon: 'build/icon/icon',
    // Also as a file of its own: the Windows taskbar is pointed at it, so a
    // cached old icon of the .exe does not show (windowChrome.ts).
    extraResource: ['build/icon/icon.ico'],
    appBundleId: 'com.worksync.desktop',
    // Code signing and notarization (required to distribute on macOS and to
    // avoid SmartScreen warnings on Windows) will be configured here later
    // via `osxSign`, `osxNotarize` and the Windows signing options.
  },
  rebuildConfig: {},
  hooks: {
    // Vite bundles the JavaScript, but koffi (used to call Everything's DLL)
    // carries a native binary, so it is copied into the app with the one for
    // this system. Everything itself ships with the Windows build only.
    packageAfterCopy: async (_config, buildPath, _electron, platform, arch) => {
      const copy = (from: string, to: string) =>
        fs.cpSync(from, to, { recursive: true, dereference: true });
      const modules = path.join(buildPath, 'node_modules');
      copy('node_modules/koffi', path.join(modules, 'koffi'));
      const native = `node_modules/@koromix/koffi-${platform}-${arch}`;
      if (fs.existsSync(native))
        copy(
          native,
          path.join(modules, '@koromix', `koffi-${platform}-${arch}`),
        );
      if (platform === 'win32')
        copy('vendor/everything', path.join(buildPath, '..', 'everything'));
    },
  },
  makers: [
    // Windows and macOS: a zip that runs without installing. On Windows the
    // owner unzips it and runs worksync.exe, with no administrator rights.
    // Linux also gets a zip: unzip and run, with nothing to install.
    new MakerZIP({}, ['win32', 'darwin', 'linux']),
    // Linux packages. The rpm uses our own spec (build/rpm.spec.ejs), which
    // works with rpm 4.20, where the default one no longer finds its files.
    new MakerRpm({
      // specTemplate is passed to electron-installer-redhat; Forge's types omit it.
      options: {
        specTemplate: path.resolve('build/rpm.spec.ejs'),
        icon: 'build/icon/icon.png',
      } as ConstructorParameters<typeof MakerRpm>[0] extends {
        options?: infer O;
      }
        ? O
        : never,
    }),
    new MakerDeb({ options: { icon: 'build/icon/icon.png' } }),
  ],
  plugins: [
    new VitePlugin({
      // `build` lists the Node-side entry points: the main process and preload.
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses enable/disable Electron functionality at package time,
    // before code signing the application.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
