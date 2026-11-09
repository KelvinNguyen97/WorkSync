import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * The icon of an app or file in the Catalog and quick search: the app's own
 * icon (or, for a document, the icon of the app that opens it), as the
 * system shows it. Until it is known, or when there is none, WorkSync's own
 * icon for the kind shows instead.
 */
const known = new Map<string, Promise<string | null>>();
let waiting: { path: string; done: (url: string | null) => void }[] = [];

/** Asks for all icons wanted in the same moment at once. */
function iconUrl(path: string): Promise<string | null> {
  let p = known.get(path);
  if (!p) {
    p = new Promise((done) => {
      waiting.push({ path, done });
      if (waiting.length === 1)
        queueMicrotask(() => {
          const batch = waiting;
          waiting = [];
          window.worksync.getFileIcons(batch.map((w) => w.path)).then(
            (icons) => batch.forEach((w) => w.done(icons[w.path] ?? null)),
            () => batch.forEach((w) => w.done(null)),
          );
        });
    });
    known.set(path, p);
  }
  return p;
}

export function FileIcon({
  path,
  kind,
  fallback,
}: {
  path: string;
  /** The box color: as before, by kind. */
  kind: 'app' | 'file' | 'folder' | 'found';
  fallback: IconName;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (kind !== 'folder') void iconUrl(path).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [path, kind]);
  return (
    <span className={`qs-ico ${kind} ${url ? 'own' : ''}`}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <Icon name={fallback} />
      )}
    </span>
  );
}
