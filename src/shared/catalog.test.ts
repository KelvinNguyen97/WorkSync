import { describe, expect, it } from 'vitest';
import {
  acceleratorFor,
  everythingQueries,
  matchesEntry,
  passesFilter,
  shortcutLabel,
  sortEntries,
  type CatalogEntry,
} from './catalog';

const e = (o: Partial<CatalogEntry>): CatalogEntry => ({
  id: 'x',
  kind: 'file',
  name: 'x',
  path: 'D:\\x.txt',
  tags: [],
  note: '',
  favorite: false,
  addedAt: '2026-11-01T00:00:00Z',
  lastOpened: null,
  missing: false,
  ...o,
});

describe('Catalog', () => {
  it('searches the name, file name, path, tags and note', () => {
    const x = e({
      name: 'WBS copy',
      path: 'D:\\Work\\Portal\\WBS_copy.xlsx',
      tags: ['customer'],
      note: 'The copy WorkSync writes',
    });
    for (const q of ['wbs', 'portal', 'CUSTOMER', 'writes', 'wbs_copy'])
      expect(matchesEntry(x, q)).toBe(true);
    expect(matchesEntry(x, 'teraterm')).toBe(false);
  });
  it('tells apps, files and folders apart, and favorites come first', () => {
    const app = e({
      id: 'a',
      name: 'Excel',
      path: 'C:\\Office\\EXCEL.EXE',
      lastOpened: '2026-11-05T00:00:00Z',
    });
    const file = e({
      id: 'f',
      name: 'Spec',
      path: 'D:\\spec.pdf',
      favorite: true,
    });
    const folder = e({
      id: 'd',
      kind: 'folder',
      name: 'Minutes',
      path: 'D:\\Minutes',
      lastOpened: '2026-11-06T00:00:00Z',
    });
    expect(
      [app, file, folder]
        .filter((x) => passesFilter(x, 'apps'))
        .map((x) => x.id),
    ).toEqual(['a']);
    expect(
      [app, file, folder]
        .filter((x) => passesFilter(x, 'files'))
        .map((x) => x.id),
    ).toEqual(['f']);
    expect(
      sortEntries([app, file, folder], 'lastOpened').map((x) => x.id),
    ).toEqual(['f', 'd', 'a']);
    expect(sortEntries([app, file, folder], 'name').map((x) => x.id)).toEqual([
      'f',
      'a',
      'd',
    ]);
    expect(sortEntries([app, file, folder], 'kind').map((x) => x.id)).toEqual([
      'f',
      'a',
      'd',
    ]);
  });
  it('sends Everything the same searches as FileManagement', () => {
    expect(everythingQueries('portal')).toEqual(['portal']);
    expect(everythingQueries('wbs-2026v2')).toEqual([
      'wbs-2026v2',
      'wbs2026v2',
      'wbs 2026 v 2',
      'wbs*2026*v*2',
    ]);
  });
  it('reads a shortcut from a key press, and needs Ctrl or Alt', () => {
    const k = (o: Partial<Parameters<typeof acceleratorFor>[0]>) =>
      acceleratorFor({
        key: 'f',
        code: 'KeyF',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ...o,
      });
    expect(k({ ctrlKey: true, shiftKey: true })).toBe(
      'CommandOrControl+Shift+F',
    );
    expect(k({ altKey: true, code: 'Space', key: ' ' })).toBe('Alt+Space');
    expect(k({ shiftKey: true })).toBeNull();
    expect(
      k({ ctrlKey: true, key: 'Control', code: 'ControlLeft' }),
    ).toBeNull();
    expect(shortcutLabel('CommandOrControl+Shift+F')).toBe('Ctrl + Shift + F');
    expect(shortcutLabel(null)).toBe('Off');
  });
});
