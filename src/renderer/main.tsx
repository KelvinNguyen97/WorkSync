import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/figtree';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App';
import { QuickSearch } from './quick';
import { TitleBar } from './titlebar';
import { OverflowHint } from './overflowHint';
import { ConfirmHost } from './parts';
import './styles/base.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// The quick-search box is the same page in a small window of its own.
const quick = location.hash === '#quick';
if (quick) document.documentElement.classList.add('quick');

// The main window has WorkSync's own title bar; the glass under it depends on
// the system (see windowChrome.ts).
const params = new URLSearchParams(location.search);
const glass = quick ? null : params.get('glass');
if (glass) {
  document.documentElement.dataset.glass = glass;
  document.documentElement.dataset.platform = params.get('platform') ?? '';
}

createRoot(container).render(
  <StrictMode>
    {quick ? (
      <QuickSearch />
    ) : (
      <>
        {glass && <TitleBar />}
        <App />
      </>
    )}
    <OverflowHint />
    {!quick && <ConfirmHost />}
  </StrictMode>,
);
