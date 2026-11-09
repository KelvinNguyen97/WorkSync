import { useEffect, useState } from 'react';
import { ICON_SVG } from '../shared/iconSvg';

/**
 * WorkSync's own title bar, in glass. The window is dragged by it, and a
 * double-click maximizes it, as with the system's. The system draws its
 * window buttons on top: on the right on Windows and Linux, and the traffic
 * lights on the left on macOS.
 *
 * It shows where you are, from the page title the app sets.
 */
export function TitleBar() {
  const [title, setTitle] = useState(document.title);
  useEffect(() => {
    const el = document.querySelector('title');
    if (!el) return;
    const watch = new MutationObserver(() => setTitle(document.title));
    watch.observe(el, { childList: true, characterData: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  const place = title.replace(/\s+—\s+WorkSync$/, '');
  return (
    <header className="titlebar">
      <span
        className="tb-icon"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: ICON_SVG }}
      />
      <span className="tb-name">WorkSync</span>
      {place && place !== 'WorkSync' && (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <span className="tb-place">{place}</span>
        </>
      )}
    </header>
  );
}
