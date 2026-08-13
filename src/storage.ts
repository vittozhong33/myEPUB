export type StoredBook = {
  id: string;
  name: string;
  type: string;
  size: number;
  updatedAt: number;
  path?: string;
  blob?: Blob;
  title?: string;
  author?: string;
  cover?: Blob | null;
};

export type StoredLocation = {
  bookId: string;
  cfi: string | null;
  progress: number | null;
  tocLabel: string | null;
  updatedAt: number;
};

export type StoredHighlight = {
  id: string;
  bookId: string;
  cfi: string;
  excerpt: string;
  note: string;
  color: string;
  tocLabel: string | null;
  createdAt: number;
  updatedAt: number;
};

export type StoredFolder = {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: number;
};

export type StoredViewState = {
  view: 'reader' | 'library';
  folderId: string | null;
};

export type StoredBookFolder = {
  bookId: string;
  folderId: string;
};

const DB_NAME = 'local-epub-reader';
const DB_VERSION = 4;
const BOOK_STORE = 'books';
const BOOK_DETAILS_STORE = 'book-details';
const BOOK_COVER_STORE = 'book-covers';
const FOLDER_STORE = 'folders';
const BOOK_FOLDER_STORE = 'book-folders';
const LOCATION_STORE = 'locations';
const HIGHLIGHT_STORE = 'highlights';
const META_STORE = 'meta';
const LAST_BOOK_KEY = 'last-book-id';
const LAST_VIEW_KEY = 'last-view-state';
const LIBRARY_ORDER_KEY_PREFIX = 'library-order:';

let dbPromise: Promise<IDBDatabase> | null = null;

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const openDb = () => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        db.createObjectStore(BOOK_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(BOOK_DETAILS_STORE)) {
        db.createObjectStore(BOOK_DETAILS_STORE, { keyPath: 'bookId' });
      }

      if (!db.objectStoreNames.contains(BOOK_COVER_STORE)) {
        db.createObjectStore(BOOK_COVER_STORE);
      }

      if (!db.objectStoreNames.contains(FOLDER_STORE)) {
        db.createObjectStore(FOLDER_STORE, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(BOOK_FOLDER_STORE)) {
        const store = db.createObjectStore(BOOK_FOLDER_STORE, { keyPath: 'bookId' });
        store.createIndex('folderId', 'folderId', { unique: false });
      }

      if (!db.objectStoreNames.contains(LOCATION_STORE)) {
        db.createObjectStore(LOCATION_STORE, { keyPath: 'bookId' });
      }

      if (!db.objectStoreNames.contains(HIGHLIGHT_STORE)) {
        const store = db.createObjectStore(HIGHLIGHT_STORE, { keyPath: 'id' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
};

const transact = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  return requestToPromise(run(tx.objectStore(storeName)));
};

export const makeBookId = async (file: File) => {
  const raw = `${file.name}:${file.size}:${file.lastModified}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const saveBook = async (file: File, path?: string, id?: string) => {
  const bookId = id ?? await makeBookId(file);
  const stored: StoredBook = {
    id: bookId,
    name: file.name,
    type: file.type || 'application/epub+zip',
    size: file.size,
    updatedAt: Date.now(),
    ...(path ? { path } : { blob: file }),
  };

  await transact(BOOK_STORE, 'readwrite', (store) => store.put(stored));
  await setLastBookId(bookId);
  return stored;
};

export const setBookFilePath = async (bookId: string, path: string) => {
  const current = await transact<StoredBook | undefined>(
    BOOK_STORE,
    'readonly',
    (store) => store.get(bookId),
  );
  if (!current) throw new Error('Book metadata was not found');
  const migrated = { ...current, path };
  delete migrated.blob;
  await transact(BOOK_STORE, 'readwrite', (store) => store.put(migrated));
  return migrated;
};

type StoredBookDetails = {
  bookId: string;
  title?: string;
  author?: string;
  coverRemoved?: boolean;
};

const mergeBookDetails = (
  book: StoredBook,
  details: StoredBookDetails | undefined,
  cover: Blob | undefined,
): StoredBook => ({
  ...book,
  title: details?.title ?? book.title,
  author: details?.author ?? book.author,
  cover: details?.coverRemoved ? null : (cover ?? book.cover),
});

export const getBook = async (id: string) => {
  const [book, details, cover] = await Promise.all([
    transact<StoredBook | undefined>(BOOK_STORE, 'readonly', (store) => store.get(id)),
    transact<StoredBookDetails | undefined>(BOOK_DETAILS_STORE, 'readonly', (store) => store.get(id)),
    transact<Blob | undefined>(BOOK_COVER_STORE, 'readonly', (store) => store.get(id)),
  ]);
  return book ? mergeBookDetails(book, details, cover) : undefined;
};

export const listBooks = async () => {
  const [books, details] = await Promise.all([
    transact<StoredBook[]>(BOOK_STORE, 'readonly', (store) => store.getAll()),
    transact<StoredBookDetails[]>(BOOK_DETAILS_STORE, 'readonly', (store) => store.getAll()),
  ]);
  const covers = await Promise.all(
    books.map((book) => transact<Blob | undefined>(
      BOOK_COVER_STORE,
      'readonly',
      (store) => store.get(book.id),
    )),
  );
  const detailMap = new Map(details.map((item) => [item.bookId, item]));
  return books.map((book, index) => mergeBookDetails(book, detailMap.get(book.id), covers[index]));
};

export const updateBookDetails = async (
  bookId: string,
  details: Partial<Pick<StoredBook, 'title' | 'author' | 'cover'>>,
) => {
  const current = await transact<StoredBookDetails | undefined>(
    BOOK_DETAILS_STORE,
    'readonly',
    (store) => store.get(bookId),
  );
  const next: StoredBookDetails = {
    ...current,
    bookId,
    ...(details.title !== undefined ? { title: details.title } : {}),
    ...(details.author !== undefined ? { author: details.author } : {}),
    ...(details.cover !== undefined ? { coverRemoved: details.cover === null } : {}),
  };
  await transact(BOOK_DETAILS_STORE, 'readwrite', (store) => store.put(next));

  if (details.cover instanceof Blob) {
    const savedCover = await transact<Blob | undefined>(
      BOOK_COVER_STORE,
      'readonly',
      (store) => store.get(bookId),
    );
    if (!savedCover) {
      await transact(BOOK_COVER_STORE, 'readwrite', (store) => store.put(details.cover, bookId));
    }
  } else if (details.cover === null) {
    await transact(BOOK_COVER_STORE, 'readwrite', (store) => store.delete(bookId));
  }
};

export const saveLocation = (location: StoredLocation) =>
  transact(LOCATION_STORE, 'readwrite', (store) => store.put(location));

export const getLocation = (bookId: string) =>
  transact<StoredLocation | undefined>(LOCATION_STORE, 'readonly', (store) => store.get(bookId));

export const saveHighlight = (highlight: StoredHighlight) =>
  transact(HIGHLIGHT_STORE, 'readwrite', (store) => store.put(highlight));

export const getHighlight = (id: string) =>
  transact<StoredHighlight | undefined>(HIGHLIGHT_STORE, 'readonly', (store) => store.get(id));

export const listHighlights = (bookId: string) =>
  transact<StoredHighlight[]>(HIGHLIGHT_STORE, 'readonly', (store) => store.index('bookId').getAll(bookId));

export const removeHighlight = (id: string) =>
  transact(HIGHLIGHT_STORE, 'readwrite', (store) => store.delete(id));

export const listFolders = () =>
  transact<StoredFolder[]>(FOLDER_STORE, 'readonly', (store) => store.getAll());

export const createFolder = async (name: string, parentId: string | null = null) => {
  const folder: StoredFolder = {
    id: crypto.randomUUID?.() ?? `folder-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: name.trim(),
    parentId,
    createdAt: Date.now(),
  };
  await transact(FOLDER_STORE, 'readwrite', (store) => store.put(folder));
  return folder;
};

export const listBookFolders = () =>
  transact<StoredBookFolder[]>(BOOK_FOLDER_STORE, 'readonly', (store) => store.getAll());

export const assignBookToFolder = (bookId: string, folderId: string | null) => {
  if (folderId) {
    return transact<IDBValidKey>(
      BOOK_FOLDER_STORE,
      'readwrite',
      (store) => store.put({ bookId, folderId }),
    );
  }
  return transact<undefined>(
    BOOK_FOLDER_STORE,
    'readwrite',
    (store) => store.delete(bookId),
  );
};

export const removeFolder = async (folderId: string, parentId: string | null = null) => {
  const folders = await listFolders();
  const childIds = folders
    .filter((folder) => folder.parentId === folderId)
    .map((folder) => folder.id);
  const removedIds = new Set([folderId, ...childIds]);
  const db = await openDb();
  const tx = db.transaction([FOLDER_STORE, BOOK_FOLDER_STORE], 'readwrite');
  const folderStore = tx.objectStore(FOLDER_STORE);
  const assignmentStore = tx.objectStore(BOOK_FOLDER_STORE);
  for (const id of removedIds) folderStore.delete(id);

  const assignmentRequest = assignmentStore.openCursor();
  assignmentRequest.onsuccess = () => {
    const cursor = assignmentRequest.result;
    if (!cursor) return;
    const assignment = cursor.value as StoredBookFolder;
    if (removedIds.has(assignment.folderId)) {
      if (parentId) cursor.update({ ...assignment, folderId: parentId });
      else cursor.delete();
    }
    cursor.continue();
  };

  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const setLastBookId = (bookId: string) =>
  transact(META_STORE, 'readwrite', (store) => store.put(bookId, LAST_BOOK_KEY));

export const getLastBookId = () =>
  transact<string | undefined>(META_STORE, 'readonly', (store) => store.get(LAST_BOOK_KEY));

export const setLastViewState = (state: StoredViewState) =>
  transact(META_STORE, 'readwrite', (store) => store.put(state, LAST_VIEW_KEY));

export const getLastViewState = () =>
  transact<StoredViewState | undefined>(META_STORE, 'readonly', (store) => store.get(LAST_VIEW_KEY));

const getLibraryOrderKey = (folderId: string | null) =>
  `${LIBRARY_ORDER_KEY_PREFIX}${folderId ?? 'root'}`;

export const getLibraryOrder = (folderId: string | null) =>
  transact<string[] | undefined>(META_STORE, 'readonly', (store) => store.get(getLibraryOrderKey(folderId)));

export const setLibraryOrder = (folderId: string | null, itemKeys: string[]) =>
  transact(META_STORE, 'readwrite', (store) => store.put(itemKeys, getLibraryOrderKey(folderId)));

export const removeBook = async (bookId: string) => {
  const db = await openDb();
  const tx = db.transaction(
    [BOOK_STORE, BOOK_DETAILS_STORE, BOOK_COVER_STORE, BOOK_FOLDER_STORE, LOCATION_STORE, HIGHLIGHT_STORE, META_STORE],
    'readwrite',
  );
  tx.objectStore(BOOK_STORE).delete(bookId);
  tx.objectStore(BOOK_DETAILS_STORE).delete(bookId);
  tx.objectStore(BOOK_COVER_STORE).delete(bookId);
  tx.objectStore(BOOK_FOLDER_STORE).delete(bookId);
  tx.objectStore(LOCATION_STORE).delete(bookId);

  const highlightStore = tx.objectStore(HIGHLIGHT_STORE);
  const highlightIndex = highlightStore.index('bookId');
  const highlightRequest = highlightIndex.openCursor(IDBKeyRange.only(bookId));
  highlightRequest.onsuccess = () => {
    const cursor = highlightRequest.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  const metaStore = tx.objectStore(META_STORE);
  const lastBookRequest = metaStore.get(LAST_BOOK_KEY);
  lastBookRequest.onsuccess = () => {
    if (lastBookRequest.result === bookId) metaStore.delete(LAST_BOOK_KEY);
  };

  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
