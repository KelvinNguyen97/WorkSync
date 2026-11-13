#!/usr/bin/env bash
# Downloads the Electron zip for this runner from Electron's GitHub release,
# checks it against Electron's SHA-256 sums, and points the build at it.
#
# The build would otherwise download Electron itself from
# github.com/electron/electron/releases/download, which GitHub's runners are
# often refused (504) without a sign-in. `gh` downloads the same files through
# the GitHub API, signed in with the workflow's token.
set -euo pipefail

dir=electron-zips
version=$(node -p "require('electron/package.json').version")
name="electron-v$version-$(node -p process.platform)-$(node -p process.arch).zip"
mkdir -p "$dir"

if [ ! -f "$dir/$name" ] || [ ! -f "$dir/SHASUMS256.txt" ]; then
  for i in 1 2 3 4 5; do
    if gh release download "v$version" --repo electron/electron \
      --pattern "$name" --pattern SHASUMS256.txt --dir "$dir" --clobber; then
      break
    fi
    [ "$i" = 5 ] && { echo "Could not download $name"; exit 1; }
    echo "Download failed, try $i"
    sleep $((i * 20))
  done
fi

# Check the zip against the published sum.
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const [dir, name] = process.argv.slice(1);
  const sums = fs.readFileSync(dir + "/SHASUMS256.txt", "utf8");
  const line = sums.split("\n").find((l) => l.trim().endsWith(" *" + name) || l.trim().endsWith(" " + name));
  if (!line) throw new Error("No sum for " + name);
  const want = line.trim().split(/\s+/)[0];
  const got = crypto.createHash("sha256").update(fs.readFileSync(dir + "/" + name)).digest("hex");
  if (got !== want) { fs.rmSync(dir + "/" + name); throw new Error("Checksum mismatch for " + name); }
  console.log("Checked " + name);
' "$dir" "$name"

echo "WORKSYNC_ELECTRON_ZIP_DIR=$dir" >> "$GITHUB_ENV"
