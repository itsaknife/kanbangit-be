import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export function mentionUserIds(content: string) {
  return [
    ...new Set(
      [
        ...content.matchAll(
          /\[@[^\]\r\n]{1,100}\]\(mention:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi,
        ),
      ].map((m) => m[1].toLowerCase()),
    ),
  ];
}
const textExtensions = new Set([
  '.md',
  '.txt',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.csv',
  '.sql',
  '.py',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.sh',
  '.bat',
  '.ps1',
  '.vue',
  '.svelte',
  '.kt',
  '.swift',
  '.log',
  '.graphql',
  '.dockerfile',
]);
export interface UploadFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}
export function validateAttachment(file?: UploadFile) {
  if (!file?.buffer?.length) throw new BadRequestException('Chọn một tệp không rỗng');
  const bytes = file.buffer;
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new BadRequestException('Tệp tối đa 2 MB');
  const fileName = [...(file.originalname.replaceAll('\\', '/').split('/').pop() || 'attachment')]
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 180);
  const ext = extname(fileName).toLowerCase();
  let mimeType: string | undefined;
  if (
    ext === '.png' &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    mimeType = 'image/png';
  if (
    ['.jpg', '.jpeg'].includes(ext) &&
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    mimeType = 'image/jpeg';
  if (
    ext === '.webp' &&
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    mimeType = 'image/webp';
  if (
    ext === '.gif' &&
    bytes.length >= 13 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  )
    mimeType = 'image/gif';
  if (textExtensions.has(ext) || fileName.toLowerCase() === 'dockerfile') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BadRequestException('Tệp văn bản phải là UTF-8 hợp lệ');
    }
    if (
      [...text].some((c) => {
        const n = c.charCodeAt(0);
        return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
      })
    )
      throw new BadRequestException('Nội dung tệp không phải văn bản');
    mimeType = 'text/plain; charset=utf-8';
  }
  if (!mimeType)
    throw new BadRequestException(
      'Chỉ hỗ trợ ảnh PNG/JPEG/WebP/GIF hoặc tệp văn bản/mã nguồn hợp lệ',
    );
  return { fileName, mimeType, fileSize: bytes.length };
}
