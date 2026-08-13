import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type OpenFileHandler = (file: File) => Promise<void>;

const isEpubPath = (path: string) => path.toLowerCase().split('?')[0].endsWith('.epub');

const fileNameFromPath = (path: string) => {
  const cleaned = decodeURIComponent(path.replace(/^file:\/\//, '')).split(/[\\/]/).pop();
  return cleaned || 'book.epub';
};

const readOpenedFile = async (path: string) => {
  const bytes = await invoke<number[]>('read_epub_file', { path });
  return new File([new Uint8Array(bytes)], fileNameFromPath(path), {
    type: 'application/epub+zip',
    lastModified: Date.now(),
  });
};

const openPaths = async (paths: string[], handler: OpenFileHandler) => {
  const epubPath = paths.find(isEpubPath);
  if (!epubPath) return;

  const file = await readOpenedFile(epubPath);
  await handler(file);
};

export const setupDesktopOpenFiles = async (handler: OpenFileHandler) => {
  const initial = await invoke<string[]>('opened_urls');
  await openPaths(initial, handler);

  return listen<string[]>('opened', (event) => {
    openPaths(event.payload, handler).catch((reason) => console.error(reason));
  });
};

export const storeBookFile = async (fileName: string, bookId: string, blob: Blob) => {
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  return invoke<string>('store_epub_file', { fileName, bookId, bytes });
};

export const readStoredBook = (path: string) => readOpenedFile(path);

export const revealStoredBook = (path: string) =>
  invoke<void>('reveal_epub_file', { path });

export const deleteStoredBookFile = (path: string) =>
  invoke<void>('delete_epub_file', { path });
