/** Notes: the owner's notes, on their own or attached to a project. */

export interface Note {
  id: string;
  /** The project it belongs to, or null for a note on its own. */
  projectId: string | null;
  title: string;
  body: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  /** When it was last opened, for Recent. */
  viewedAt: string | null;
}

export type NoteInput = Pick<
  Note,
  'projectId' | 'title' | 'body' | 'tags' | 'favorite'
>;

export type NoteFilter = 'all' | 'favorites' | 'recent' | 'tagged';

/** A note opened in the last two weeks counts as recent. */
export const RECENT_DAYS = 14;

const URL_RE = /\bhttps?:\/\/[^\s<>"'）」』】]+/gi;

/** The web addresses in a note's text, as they open with one click. */
export function noteLinks(body: string): string[] {
  const found = body.match(URL_RE) ?? [];
  // Trailing punctuation usually ends the sentence, not the address.
  const clean = found.map((u) => u.replace(/[.,;:!?)\]]+$/, ''));
  return [...new Set(clean)];
}

/** The address under a position in the text, for Ctrl+click in the editor. */
export function linkAt(body: string, index: number): string | null {
  for (const m of body.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const start = m.index ?? 0;
    if (index >= start && index <= start + url.length) return url;
  }
  return null;
}

/** Tags from what the owner typed: separated by commas or spaces, without #, each once. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\s、，]+/)) {
    const t = raw.replace(/^#+/, '').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** The notes a filter and a search show, newest change first (Recent: newest opened). */
export function filterNotes(
  notes: Note[],
  filter: NoteFilter,
  query: string,
  now: Date,
): Note[] {
  const q = query.trim().toLowerCase();
  const since = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString();
  const list = notes.filter(
    (n) =>
      (filter === 'all' ||
        (filter === 'favorites' && n.favorite) ||
        (filter === 'tagged' && n.tags.length > 0) ||
        (filter === 'recent' && !!n.viewedAt && n.viewedAt >= since)) &&
      (!q ||
        `${n.title}\n${noteText(n.body)}\n${n.tags.join(' ')}`
          .toLowerCase()
          .includes(q)),
  );
  return list.sort((a, b) =>
    filter === 'recent'
      ? (b.viewedAt ?? '').localeCompare(a.viewedAt ?? '')
      : b.updatedAt.localeCompare(a.updatedAt) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
  );
}

// ------------------------------------------------------------ Images
//
// An image in a note is a line of its own in the note text:
//   ![image](image:<id>)
// The image itself is kept in the database. Everything else in the note stays
// plain text, so search, tags and links work as before.

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_LINE = /^!\[image\]\(image:([0-9a-f-]{36})\)$/;

/** The text line that places an image in a note. */
export const imageLine = (id: string) => `![image](image:${id})`;

/** A piece of a note: some text, or an image. */
export type NoteBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; id: string };

/**
 * A note as text and images, in order. It always starts and ends with text,
 * and text sits between any two images (it may be empty), so there is always
 * somewhere to type.
 */
export function noteBlocks(body: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let lines: string[] = [];
  for (const line of body.split('\n')) {
    const m = IMAGE_LINE.exec(line.trim());
    if (m) {
      blocks.push({ kind: 'text', text: lines.join('\n') });
      blocks.push({ kind: 'image', id: m[1] });
      lines = [];
    } else lines.push(line);
  }
  blocks.push({ kind: 'text', text: lines.join('\n') });
  return blocks;
}

/**
 * The note text for blocks, the reverse of noteBlocks. Empty text before the
 * first image or after the last adds nothing, so a note can start or end
 * with an image.
 */
export const joinBlocks = (blocks: NoteBlock[]): string =>
  blocks
    .filter(
      (b, i) =>
        !(
          b.kind === 'text' &&
          !b.text &&
          blocks.length > 1 &&
          (i === 0 || i === blocks.length - 1)
        ),
    )
    .map((b) => (b.kind === 'text' ? b.text : imageLine(b.id)))
    .join('\n');

/** The images in a note, in order. */
export const noteImageIds = (body: string): string[] =>
  noteBlocks(body).flatMap((b) => (b.kind === 'image' ? [b.id] : []));

/** A note's text without its image lines, for previews and search. */
export const noteText = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !IMAGE_LINE.test(l.trim()))
    .join('\n');

/** The kind of image the bytes hold, from their first bytes, or null. */
export function imageType(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  if (at(0, 0x42, 0x4d)) return 'image/bmp';
  return null;
}
