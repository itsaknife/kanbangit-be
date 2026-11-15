import { describe, it, expect } from 'vitest';
import { MAX_ATTACHMENT_BYTES, mentionUserIds, validateAttachment } from './comment.rules.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const file = (name: string, buffer: Buffer) => ({
  originalname: name,
  buffer,
  size: buffer.length,
  mimetype: 'application/octet-stream',
});
describe('M4 comment rules', () => {
  it('stores stable user IDs and deduplicates repeats', () =>
    expect(mentionUserIds(`[@first](mention:${id}) [@renamed](mention:${id}) @plain`)).toEqual([
      id,
    ]));
  it('ignores plain usernames and invalid IDs', () =>
    expect(mentionUserIds('@someone [@x](mention:123)')).toEqual([]));
  it.each(['readme.md', 'source.ts', 'code.py', 'notes.txt', 'Dockerfile'])(
    'accepts UTF-8 text regardless of claimed MIME: %s',
    (name) =>
      expect(
        validateAttachment(file(name, Buffer.from('Tiếng Việt\nconst x=1;'))).mimeType,
      ).toContain('text/plain'),
  );
  it('strips paths and control characters from filenames', () =>
    expect(validateAttachment(file('../folder/note.txt', Buffer.from('text'))).fileName).toBe(
      'note.txt',
    ));
  it('accepts a PNG signature with IHDR', () => {
    const b = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
    b.write('IHDR', 12);
    expect(validateAttachment(file('image.png', b)).mimeType).toBe('image/png');
  });
  it('rejects disguised binary', () =>
    expect(() => validateAttachment(file('fake.ts', Buffer.from([77, 90, 0, 0])))).toThrow());
  it('rejects non UTF-8', () =>
    expect(() => validateAttachment(file('text.txt', Buffer.from([255, 254, 255])))).toThrow());
  it('rejects executable extension', () =>
    expect(() => validateAttachment(file('script.exe', Buffer.from('text')))).toThrow());
  it('rejects SVG active content', () =>
    expect(() =>
      validateAttachment(file('icon.svg', Buffer.from('<svg onload="alert(1)"/>'))),
    ).toThrow());
  it('rejects fake images despite extension/MIME', () =>
    expect(() =>
      validateAttachment({
        ...file('image.png', Buffer.from('not an image')),
        mimetype: 'image/png',
      }),
    ).toThrow());
  it('rejects empty files', () =>
    expect(() => validateAttachment(file('a.txt', Buffer.alloc(0)))).toThrow());
  it('rejects oversized files', () =>
    expect(() =>
      validateAttachment(file('a.txt', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 65))),
    ).toThrow());
});
