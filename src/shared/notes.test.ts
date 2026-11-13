import { describe, expect, it } from 'vitest';
import {
  filterNotes,
  imageLine,
  imageType,
  joinBlocks,
  linkAt,
  noteBlocks,
  noteImageIds,
  noteLinks,
  noteText,
  parseTags,
  type Note,
} from './notes';

const n = (o: Partial<Note>): Note => ({
  id: 'x',
  projectId: null,
  title: '',
  body: '',
  tags: [],
  favorite: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  viewedAt: null,
  ...o,
});

describe('notes', () => {
  it('finds web addresses, without the full stop after them', () => {
    const body =
      'Spec: https://example.com/spec-v2. Also (http://intra/wbs) and mail.';
    expect(noteLinks(body)).toEqual([
      'https://example.com/spec-v2',
      'http://intra/wbs',
    ]);
    expect(linkAt(body, body.indexOf('example'))).toBe(
      'https://example.com/spec-v2',
    );
    expect(linkAt(body, 2)).toBeNull();
  });
  it('reads tags typed with commas, spaces or #', () => {
    expect(parseTags('#meeting, q4  Meeting、ideas')).toEqual([
      'meeting',
      'q4',
      'ideas',
    ]);
  });
  it('filters favorites, tagged and recent, and searches text and tags', () => {
    const now = new Date('2026-11-06T00:00:00Z');
    const list = [
      n({ id: 'fav', favorite: true, updatedAt: '2026-11-05T00:00:00Z' }),
      n({ id: 'tag', tags: ['visit'], viewedAt: '2026-11-05T00:00:00Z' }),
      n({ id: 'old', body: 'Warehouse', viewedAt: '2026-09-01T00:00:00Z' }),
    ];
    expect(filterNotes(list, 'all', '', now).map((x) => x.id)).toEqual([
      'fav',
      'tag',
      'old',
    ]);
    expect(filterNotes(list, 'favorites', '', now).map((x) => x.id)).toEqual([
      'fav',
    ]);
    expect(filterNotes(list, 'tagged', '', now).map((x) => x.id)).toEqual([
      'tag',
    ]);
    expect(filterNotes(list, 'recent', '', now).map((x) => x.id)).toEqual([
      'tag',
    ]);
    expect(filterNotes(list, 'all', 'warehouse', now).map((x) => x.id)).toEqual(
      ['old'],
    );
    expect(filterNotes(list, 'all', 'visit', now).map((x) => x.id)).toEqual([
      'tag',
    ]);
  });
});

describe('images in notes', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  it('reads a note as text and images, and writes it back the same', () => {
    for (const body of [
      'just text',
      '',
      `before\n${imageLine(A)}\nafter`,
      `${imageLine(A)}`,
      `${imageLine(A)}\n\n${imageLine(B)}\nend`,
      `a\n\nb\n${imageLine(B)}`,
    ])
      expect(joinBlocks(noteBlocks(body))).toBe(body);
    // Writing it again changes nothing.
    const once = joinBlocks(noteBlocks(`\n${imageLine(A)}\n`));
    expect(joinBlocks(noteBlocks(once))).toBe(once);
    expect(noteBlocks(`x\n${imageLine(A)}\ny`)).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'image', id: A },
      { kind: 'text', text: 'y' },
    ]);
  });
  it('lists the images and leaves them out of previews and search', () => {
    const body = `Report\n${imageLine(A)}\nDone\n${imageLine(B)}`;
    expect(noteImageIds(body)).toEqual([A, B]);
    expect(noteText(body)).toBe('Report\nDone');
    const n = {
      id: 'n',
      projectId: null,
      title: 't',
      body,
      tags: [],
      favorite: false,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      viewedAt: null,
    };
    expect(filterNotes([n], 'all', 'image', new Date())).toHaveLength(0);
    expect(filterNotes([n], 'all', 'done', new Date())).toHaveLength(1);
  });
  it('knows an image by its first bytes', () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]))).toBe(
      'image/png',
    );
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
    expect(imageType(new TextEncoder().encode('hello'))).toBeNull();
  });
});
