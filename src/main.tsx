import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Folder,
  FolderPlus,
  GripVertical,
  Highlighter,
  EllipsisVertical,
  Library,
  Menu,
  Moon,
  Plus,
  MessageSquareText,
  ScrollText,
  Sun,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { makeBook } from 'foliate-js/view.js';
import { compare as compareCFI } from 'foliate-js/epubcfi.js';
import './styles.css';
import type { FoliateBook, FoliateLocation, FoliateRenderer, FoliateViewElement, TocItem } from './foliate';
import {
  getBook,
  getHighlight,
  getLastBookId,
  getLastViewState,
  getLibraryOrder,
  getLocation,
  assignBookToFolder,
  createFolder,
  listBookFolders,
  listFolders,
  listHighlights,
  listBooks,
  makeBookId,
  removeHighlight,
  removeBook,
  removeFolder,
  saveBook,
  saveHighlight,
  saveLocation,
  setLastBookId,
  setBookFilePath,
  setLastViewState,
  setLibraryOrder,
  updateBookDetails,
  type StoredHighlight,
  type StoredBook,
  type StoredFolder,
} from './storage';

type ReaderSettings = {
  theme: 'paper' | 'dark';
  backgroundColor: string;
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  flow: 'paginated' | 'scrolled';
};

type PendingHighlight = {
  cfi: string;
  excerpt: string;
  range: Range;
  x: number;
  y: number;
};

type HighlightPopover = {
  highlight: StoredHighlight;
  anchor: { left: number; top: number; right: number; bottom: number };
};

const SETTINGS_KEY = 'reader-settings-v1';
const HIGHLIGHT_COLOR = '#ffe36d';
const BACKGROUND_COLORS = ['#E8F1E4', '#EEF4EA', '#F3EAD8', '#F7F1E3', '#F8F4EA'] as const;
const DEFAULT_BACKGROUND_COLOR = BACKGROUND_COLORS[0];

const defaultSettings: ReaderSettings = {
  theme: 'paper',
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  fontSize: 18,
  lineHeight: 1.65,
  maxWidth: 900,
  flow: 'paginated',
};

const readSettings = (): ReaderSettings => {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    const parsed = saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    return {
      ...parsed,
      backgroundColor: (BACKGROUND_COLORS as readonly string[]).includes(parsed.backgroundColor)
        ? parsed.backgroundColor
        : DEFAULT_BACKGROUND_COLOR,
    };
  } catch {
    return defaultSettings;
  }
};

const normalizeLabel = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeLabel).filter(Boolean).join(', ');
  if (typeof value === 'object') return Object.values(value as Record<string, string>)[0] ?? '';
  return String(value);
};

const isDisplayableCoverBlob = (cover: Blob | null | undefined): cover is Blob =>
  Boolean(cover && cover.size > 0 && cover.type.startsWith('image/'));

const getErrorMessage = (reason: unknown) => {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return '';
};

const waitForNextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const getBookStartIndex = (book: FoliateBook | undefined) => {
  const index = book?.sections?.findIndex((section) => section.linear !== 'no') ?? -1;
  return index >= 0 ? index : 0;
};

const formatBytes = (size: number) => {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const getProgressText = (location: FoliateLocation | null) => {
  const value = location?.fraction ?? location?.current;
  if (typeof value !== 'number' || Number.isNaN(value)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
};

const createSvgElement = (tag: string) => document.createElementNS('http://www.w3.org/2000/svg', tag);

const drawHighlight = (
  rects: Array<{ left: number; top: number; height: number; width: number }>,
  options: { color?: string; padding?: number; noteUnderline?: boolean } = {},
) => {
  const { color = HIGHLIGHT_COLOR, padding = 1, noteUnderline = false } = options;
  const group = createSvgElement('g');
  group.style.mixBlendMode = 'multiply';

  for (const { left, top, height, width } of rects) {
    const rect = createSvgElement('rect');
    rect.setAttribute('x', String(left - padding));
    rect.setAttribute('y', String(top - padding));
    rect.setAttribute('height', String(height + padding * 2));
    rect.setAttribute('width', String(width + padding * 2));
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', color);
    rect.setAttribute('opacity', '0.42');
    group.append(rect);

    if (noteUnderline) {
      const underline = createSvgElement('line');
      const underlineY = top + height + Math.max(1, padding);
      underline.setAttribute('x1', String(left - padding));
      underline.setAttribute('x2', String(left + width + padding));
      underline.setAttribute('y1', String(underlineY));
      underline.setAttribute('y2', String(underlineY));
      underline.setAttribute('fill', 'none');
      underline.setAttribute('stroke', '#D97706');
      underline.setAttribute('stroke-width', '1.6');
      underline.setAttribute('stroke-dasharray', '5 3');
      underline.setAttribute('stroke-linecap', 'round');
      underline.setAttribute('opacity', '0.95');
      group.append(underline);
    }
  }

  return group;
};

const getHighlightId = () =>
  crypto.randomUUID?.() ?? `highlight-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const compactExcerpt = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 240);

const getEventTargetElement = (target: EventTarget | null) => {
  const node = target as (Node & { parentElement?: HTMLElement | null }) | null;
  return node?.nodeType === 1 ? node as unknown as HTMLElement : node?.parentElement ?? null;
};

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  const element = getEventTargetElement(target);
  return Boolean(element && (
    element.matches('input, textarea, select')
    || element.isContentEditable
    || element.closest('[contenteditable="true"]')
  ));
};

const getDisplayBookTitle = (book: StoredBook) => book.title || book.name.replace(/\.epub$/i, '');

const toFoliateAnnotation = (highlight: StoredHighlight) => ({
  ...highlight,
  value: highlight.cfi,
});

const sortHighlightsByReadingOrder = (highlights: StoredHighlight[]) =>
  highlights.sort((a, b) => {
    try {
      const position = compareCFI(a.cfi, b.cfi);
      return position || a.createdAt - b.createdAt;
    } catch {
      return a.createdAt - b.createdAt;
    }
  });

const getEffectiveMaxWidth = (settings: ReaderSettings, containerWidth: number) => {
  if (settings.flow !== 'paginated') return settings.maxWidth;

  return Math.max(500, Math.floor(containerWidth * 0.85));
};

const getPageGap = (settings: ReaderSettings, containerWidth: number) => {
  if (settings.flow !== 'paginated') return '8%';
  return containerWidth >= 1900 ? '6%' : '7%';
};

const getPageMargin = (settings: ReaderSettings, containerWidth: number) => {
  if (settings.flow !== 'paginated') return 64;
  return containerWidth >= 1900 ? 20 : 24;
};

const balancePageSideSpacing = (renderer: FoliateRenderer, settings: ReaderSettings) => {
  const root = renderer.shadowRoot;
  const existing = root?.getElementById('local-reader-balanced-pages');
  existing?.remove();

  if (!root || settings.flow !== 'paginated') return;

  const style = document.createElement('style');
  style.id = 'local-reader-balanced-pages';
  style.textContent = `
    #top {
      grid-template-columns:
        0
        var(--_half-gap)
        minmax(0, calc(var(--_max-width) - var(--_gap)))
        var(--_half-gap)
        0 !important;
    }
  `;
  root.append(style);
};

const applyBookStyles = (doc: Document, settings: ReaderSettings) => {
  const existing = doc.getElementById('local-reader-theme');
  existing?.remove();

  const backgroundColor = settings.theme === 'dark' ? '#171717' : settings.backgroundColor;

  const style = doc.createElement('style');
  style.id = 'local-reader-theme';
  style.textContent = `
    :root {
      --theme-bg-color: ${backgroundColor};
      color-scheme: ${settings.theme === 'dark' ? 'dark' : 'light'};
    }

    html, body {
      background: ${backgroundColor} !important;
      color: ${settings.theme === 'dark' ? '#e9e1d2' : '#211f1b'} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineHeight} !important;
    }

    body {
      overflow-wrap: break-word;
      max-width: none !important;
      width: auto !important;
      margin-inline: 0 !important;
      padding-inline: 0 !important;
    }

    a {
      color: ${settings.theme === 'dark' ? '#9cc7ff' : '#2762a5'} !important;
    }

    body > *,
    body *:not(img):not(svg):not(table):not(th):not(td),
    img,
    svg,
    table {
      max-width: 100% !important;
    }

    body *:not(img):not(svg):not(table):not(th):not(td) {
      margin-inline: 0 !important;
      padding-inline: 0 !important;
    }

    ul,
    ol {
      margin-inline-end: 0 !important;
    }
  `;
  doc.head.append(style);
};

const getTocTargetHref = (item: TocItem): string | undefined => {
  if (item.href) return item.href;
  for (const child of item.subitems ?? []) {
    const href = getTocTargetHref(child);
    if (href) return href;
  }
  return undefined;
};

const tocContainsHref = (item: TocItem, href: string | undefined): boolean => {
  if (!href) return false;
  if (item.href === href) return true;
  return (item.subitems ?? []).some((child) => tocContainsHref(child, href));
};

const normalizeTocPath = (href: string) => {
  const path = href.split('#', 1)[0].split('?', 1)[0];
  try {
    return decodeURIComponent(path).replace(/^\.\//, '');
  } catch {
    return path.replace(/^\.\//, '');
  }
};

const getTocFragment = (href: string) => {
  const marker = href.indexOf('#');
  if (marker < 0) return '';
  try {
    return decodeURIComponent(href.slice(marker + 1));
  } catch {
    return href.slice(marker + 1);
  }
};

const getChapterNumber = (label: string) => {
  const match = label.match(/^\s*第\s*(\d+)\s*章/u);
  return match ? Number(match[1]) : null;
};

const getSectionNumber = (label: string) => {
  const match = label.match(/^\s*(\d+)\s*[.．]\s*(\d+)/u);
  return match ? { chapter: Number(match[1]), section: Number(match[2]) } : null;
};

const correctTocOrder = (items: TocItem[], book: FoliateBook): TocItem[] => {
  const sectionOrder = new Map<string, number>();
  for (const [index, section] of (book.sections ?? []).entries()) {
    if (section.id) sectionOrder.set(normalizeTocPath(section.id), index);
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const getPosition = (item: TocItem) => {
    const href = getTocTargetHref(item) ?? '';
    const path = normalizeTocPath(href);
    let section = sectionOrder.get(path);
    if (section === undefined) {
      const match = [...sectionOrder].find(([sectionPath]) => (
        sectionPath.endsWith(`/${path}`) || path.endsWith(`/${sectionPath}`)
      ));
      section = match?.[1] ?? Number.MAX_SAFE_INTEGER;
    }
    return { section, fragment: getTocFragment(href) };
  };

  const sortLevel = (levelItems: TocItem[]): TocItem[] => levelItems
    .map((item, index) => ({
      item: {
        ...item,
        subitems: item.subitems?.length ? sortLevel(item.subitems) : item.subitems,
      },
      index,
    }))
    .sort((a, b) => {
      const left = getPosition(a.item);
      const right = getPosition(b.item);
      return left.section - right.section
        || collator.compare(left.fragment, right.fragment)
        || a.index - b.index;
    })
    .map(({ item }) => item);

  const roots = sortLevel(items);
  const chapters = new Map<number, TocItem>();
  for (const item of roots) {
    const chapter = getChapterNumber(item.label);
    if (chapter !== null) chapters.set(chapter, item);
  }

  const correctedRoots: TocItem[] = [];
  for (const item of roots) {
    const section = getSectionNumber(item.label);
    const chapter = section ? chapters.get(section.chapter) : undefined;
    if (chapter && chapter !== item) {
      chapter.subitems = [...(chapter.subitems ?? []), item];
    } else {
      correctedRoots.push(item);
    }
  }

  return sortLevel(correctedRoots);
};

function TocTree({
  items,
  onSelect,
  activeHref,
  level = 0,
}: {
  items: TocItem[];
  onSelect: (href: string) => void;
  activeHref?: string;
  level?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(items.map((item) => item.href ?? item.label)));

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="toc-tree">
      {items.map((item, index) => (
        <TocNode
          key={`${item.href ?? item.label}-${level}-${index}`}
          activeHref={activeHref}
          expanded={expanded}
          item={item}
          level={level}
          onSelect={onSelect}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function TocNode({
  item,
  level,
  expanded,
  activeHref,
  onSelect,
  onToggle,
}: {
  item: TocItem;
  level: number;
  expanded: Set<string>;
  activeHref?: string;
  onSelect: (href: string) => void;
  onToggle: (key: string) => void;
}) {
  const key = item.href ?? item.label;
  const hasChildren = !!item.subitems?.length;
  const isExpanded = expanded.has(key);
  const targetHref = getTocTargetHref(item);
  const isActive = tocContainsHref(item, activeHref);

  return (
    <div>
      <div className="toc-row" style={{ paddingLeft: 8 + level * 14 }}>
        {hasChildren ? (
          <button
            aria-expanded={isExpanded}
            className="toc-toggle"
            type="button"
            onClick={() => onToggle(key)}
          >
            <ChevronRight size={15} />
          </button>
        ) : (
          <span className="toc-spacer" />
        )}
        <button
          className={`toc-item ${isActive ? 'active' : ''}`}
          disabled={!targetHref}
          type="button"
          onClick={() => {
            if (targetHref) onSelect(targetHref);
          }}
        >
          {item.label || '未命名章节'}
        </button>
      </div>
      {hasChildren && isExpanded && (
        <TocTree
          activeHref={activeHref}
          items={item.subitems ?? []}
          level={level + 1}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [bookFolders, setBookFolders] = useState<Record<string, string>>({});
  const [bookCovers, setBookCovers] = useState<Record<string, string>>({});
  const [badCoverIds, setBadCoverIds] = useState<Set<string>>(() => new Set());
  const [activeBook, setActiveBook] = useState<StoredBook | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(readSettings);
  const [location, setLocation] = useState<FoliateLocation | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [sideOpen, setSideOpen] = useState(false);
  const [topOpen, setTopOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'reader' | 'library'>('reader');
  const [highlights, setHighlights] = useState<StoredHighlight[]>([]);
  const [pendingHighlight, setPendingHighlight] = useState<PendingHighlight | null>(null);
  const [editingHighlight, setEditingHighlight] = useState<StoredHighlight | null>(null);
  const [highlightPopover, setHighlightPopover] = useState<HighlightPopover | null>(null);
  const [highlightPopoverPosition, setHighlightPopoverPosition] = useState({ left: 12, top: 12 });
  const [highlightNote, setHighlightNote] = useState('');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderToDelete, setFolderToDelete] = useState<StoredFolder | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [bookMenuId, setBookMenuId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState(false);
  const [libraryOrder, setLibraryOrderState] = useState<string[]>([]);
  const [draggedLibraryKey, setDraggedLibraryKey] = useState<string | null>(null);
  const activeBookRef = useRef<StoredBook | null>(null);
  const locationRef = useRef<FoliateLocation | null>(null);
  const highlightsRef = useRef<StoredHighlight[]>([]);
  const openingBookIdRef = useRef<string | null>(null);
  const selectedFolderIdRef = useRef<string | null>(null);
  const libraryOrderRef = useRef<string[]>([]);
  const draggedLibraryKeyRef = useRef<string | null>(null);
  const highlightPopoverRef = useRef<HTMLDivElement | null>(null);
  const higherPriorityClickRef = useRef<{ doc: Document; at: number } | null>(null);
  const restoredViewRef = useRef(false);
  const migrationPromiseRef = useRef<Promise<void> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const element = highlightPopoverRef.current;
    if (!highlightPopover || !element) return;

    const margin = 12;
    const gap = 10;
    const { width, height } = element.getBoundingClientRect();
    const anchor = highlightPopover.anchor;
    const clampX = (value: number) => Math.min(window.innerWidth - width - margin, Math.max(margin, value));
    const clampY = (value: number) => Math.min(window.innerHeight - height - margin, Math.max(margin, value));
    const aboveTop = anchor.top - height - gap;
    const belowTop = anchor.bottom + gap;

    if (aboveTop >= margin) {
      setHighlightPopoverPosition({ left: clampX(anchor.right - width), top: aboveTop });
    } else if (belowTop + height <= window.innerHeight - margin) {
      setHighlightPopoverPosition({ left: clampX(anchor.right - width), top: belowTop });
    } else if (anchor.right + gap + width <= window.innerWidth - margin) {
      setHighlightPopoverPosition({ left: anchor.right + gap, top: clampY(anchor.top) });
    } else {
      setHighlightPopoverPosition({ left: clampX(anchor.left - width - gap), top: clampY(anchor.top) });
    }
  }, [highlightPopover]);

  const refreshBooks = useCallback(async () => {
    const [rows, folderRows, assignments] = await Promise.all([
      listBooks(),
      listFolders(),
      listBookFolders(),
    ]);
    setBooks(rows.sort((a, b) => b.updatedAt - a.updatedAt));
    setFolders(folderRows.sort((a, b) => a.createdAt - b.createdAt));
    setBookFolders(Object.fromEntries(assignments.map((item) => [item.bookId, item.folderId])));
  }, []);

  const refreshHighlights = useCallback(async (bookId: string) => {
    const rows = await listHighlights(bookId);
    setHighlights(sortHighlightsByReadingOrder(rows));
    return rows;
  }, []);

  const drawStoredHighlight = useCallback(async (highlight: StoredHighlight) => {
    await viewRef.current?.addAnnotation(toFoliateAnnotation(highlight));
  }, []);

  const cacheOpenBookDetails = useCallback(async (book: StoredBook, foliateBook: NonNullable<FoliateViewElement['book']>) => {
    const metadata = foliateBook.metadata ?? {};
    const nextTitle = normalizeLabel(metadata.title) || getDisplayBookTitle(book);
    const nextAuthor = normalizeLabel(metadata.author);
    const storedCover = isDisplayableCoverBlob(book.cover) ? book.cover : null;
    const extractedCover = storedCover ?? (await foliateBook.getCover?.().catch((reason: unknown) => {
      console.error(reason);
      return null;
    })) ?? null;
    const nextCover = isDisplayableCoverBlob(extractedCover) ? extractedCover : null;

    const details: Partial<Pick<StoredBook, 'title' | 'author' | 'cover'>> = {
      title: nextTitle,
      author: nextAuthor,
    };
    if (nextCover || book.cover) details.cover = nextCover;

    await updateBookDetails(book.id, details);
    return { title: nextTitle, author: nextAuthor, cover: nextCover };
  }, []);

  const patchSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const applyLayout = useCallback(() => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;

    const containerWidth = renderer.clientWidth || window.innerWidth;
    renderer.setAttribute('flow', settings.flow);
    renderer.setAttribute('margin', `${getPageMargin(settings, containerWidth)}px`);
    renderer.setAttribute('gap', getPageGap(settings, containerWidth));
    renderer.setAttribute('max-column-count', '2');
    renderer.setAttribute('max-inline-size', `${getEffectiveMaxWidth(settings, containerWidth)}px`);
    balancePageSideSpacing(renderer, settings);

    for (const content of renderer.getContents?.() ?? []) {
      applyBookStyles(content.doc, settings);
    }
  }, [settings]);

  const persistCurrentLocation = useCallback(async (bookId?: string) => {
    const targetBookId = bookId ?? activeBookRef.current?.id;
    const currentLocation = viewRef.current?.lastLocation ?? locationRef.current;
    if (!targetBookId || !currentLocation?.cfi) return;

    await saveLocation({
      bookId: targetBookId,
      cfi: currentLocation.cfi,
      progress: currentLocation.fraction ?? currentLocation.current ?? null,
      tocLabel: currentLocation.tocItem?.label ?? null,
      updatedAt: Date.now(),
    });
  }, []);

  const ensureBookFile = useCallback(async (book: StoredBook) => {
    if (book.path) {
      const { readStoredBook } = await import('./desktop');
      return readStoredBook(book.path);
    }
    if (!(book.blob instanceof Blob) || book.blob.size === 0) {
      throw new Error('书籍文件数据为空');
    }
    if (!('__TAURI_INTERNALS__' in window)) {
      return new File([book.blob], book.name, { type: book.type, lastModified: book.updatedAt });
    }

    const { readStoredBook, storeBookFile } = await import('./desktop');
    const path = await storeBookFile(book.name, book.id, book.blob);
    await setBookFilePath(book.id, path);
    return readStoredBook(path);
  }, []);

  const migrateLegacyBooks = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    if (migrationPromiseRef.current) return migrationPromiseRef.current;

    migrationPromiseRef.current = (async () => {
      const legacyBooks = (await listBooks()).filter((book) => !book.path && book.blob instanceof Blob);
      const { storeBookFile } = await import('./desktop');
      for (const book of legacyBooks) {
        const path = await storeBookFile(book.name, book.id, book.blob as Blob);
        await setBookFilePath(book.id, path);
      }
    })().finally(() => {
      migrationPromiseRef.current = null;
    });
    return migrationPromiseRef.current;
  }, []);

  const openStoredBook = useCallback(
    async (book: StoredBook, options: { ignoreSavedLocation?: boolean } = {}) => {
      const view = viewRef.current;
      if (!view) return;
      if (openingBookIdRef.current) return;
      await persistCurrentLocation();
      openingBookIdRef.current = book.id;

      setBusy(true);
      setError('');
      setLocation(null);
      setToc([]);

      let stage = '准备打开';
      try {
        setViewMode('reader');
        await waitForNextFrame();

        try {
          view.close?.();
        } catch (reason) {
          console.error(reason);
        }

        stage = '读取书籍数据';
        const file = await ensureBookFile(book);
        stage = '读取进度';
        const savedLocation = options.ignoreSavedLocation ? undefined : await getLocation(book.id);

        stage = '解析文件';
        const parsedBook = await makeBook(file);
        const displayToc = correctTocOrder(parsedBook.toc ?? [], parsedBook);

        // Some EPUBs contain stale navigation anchors. Foliate's progress
        // indexing can reject the whole book before the first page is shown.
        parsedBook.toc = [];
        parsedBook.pageList = [];

        stage = '打开文件';
        await view.open(parsedBook);
        applyLayout();
        stage = '初始化页面';
        const startIndex = getBookStartIndex(parsedBook);
        if (savedLocation?.cfi) {
          try {
            await view.init({ lastLocation: savedLocation.cfi });
          } catch (reason) {
            console.error(reason);
            await view.goTo(startIndex);
          }
        } else {
          await view.goTo(startIndex);
        }

        stage = '读取目录';
        const metadata = view.book?.metadata ?? {};
        const details = {
          title: normalizeLabel(metadata.title) || getDisplayBookTitle(book),
          author: normalizeLabel(metadata.author) || book.author || '',
          cover: isDisplayableCoverBlob(book.cover) ? book.cover : null,
        };
        setTitle(details.title);
        setAuthor(details.author);
        setToc(displayToc);
        setActiveBook({ ...book, title: details.title, author: details.author, cover: details.cover });
        setViewMode('reader');
        await setLastBookId(book.id);

        refreshHighlights(book.id)
          .then((savedHighlights) => Promise.allSettled(savedHighlights.map((highlight) => drawStoredHighlight(highlight))))
          .catch((reason) => console.error(reason));

        if (view.book) {
          cacheOpenBookDetails(book, view.book)
            .then((cached) => {
              if (cached.cover) {
                setBadCoverIds((current) => {
                  const next = new Set(current);
                  next.delete(book.id);
                  return next;
                });
              }
              setTitle(cached.title);
              setAuthor(cached.author);
              setActiveBook((current) => (
                current?.id === book.id
                  ? { ...current, title: cached.title, author: cached.author, cover: cached.cover }
                  : current
              ));
              return refreshBooks();
            })
            .catch((reason) => console.error(reason));
        }
      } catch (reason) {
        console.error(reason);
        const message = getErrorMessage(reason);
        setError(`这本书暂时打不开：${stage}失败${message ? `（${message}）` : ''}。`);
      } finally {
        openingBookIdRef.current = null;
        setBusy(false);
      }
    },
    [applyLayout, cacheOpenBookDetails, drawStoredHighlight, ensureBookFile, persistCurrentLocation, refreshBooks, refreshHighlights],
  );

  useEffect(() => {
    activeBookRef.current = activeBook;
  }, [activeBook]);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(() => {
    selectedFolderIdRef.current = selectedFolderId;
  }, [selectedFolderId]);

  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);

  useEffect(() => {
    migrateLegacyBooks()
      .then(refreshBooks)
      .catch((reason) => {
        console.error(reason);
        setError('迁移本地书库失败，旧书数据仍保留。');
      });
  }, [migrateLegacyBooks, refreshBooks]);

  useEffect(() => {
    const entries = books
      .filter((book) => isDisplayableCoverBlob(book.cover))
      .map((book) => [book.id, URL.createObjectURL(book.cover as Blob)] as const);
    const urls = Object.fromEntries(entries);
    setBookCovers(urls);

    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [books]);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      await migrateLegacyBooks();
      const savedView = await getLastViewState();
      if (cancelled) return;

      const savedFolders = await listFolders();
      const restoredFolderId = savedFolders.some((folder) => folder.id === savedView?.folderId)
        ? savedView?.folderId ?? null
        : null;
      setSelectedFolderId(restoredFolderId);

      if (savedView?.view === 'library') {
        setViewMode('library');
        restoredViewRef.current = true;
        return;
      }

      const lastId = await getLastBookId();
      if (lastId && !cancelled) {
        const book = await getBook(lastId);
        if (book && !cancelled) await openStoredBook(book);
      }
      restoredViewRef.current = true;
    };

    restore().catch((reason) => {
      console.error(reason);
      setError('恢复上次阅读失败。');
    });

    return () => {
      cancelled = true;
    };
  }, [migrateLegacyBooks, openStoredBook]);

  useEffect(() => {
    if (!restoredViewRef.current) return;
    setLastViewState({ view: viewMode, folderId: selectedFolderId })
      .catch((reason) => console.error(reason));
  }, [selectedFolderId, viewMode]);

  useEffect(() => {
    const persist = () => {
      persistCurrentLocation().catch((reason) => console.error(reason));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist();
    };

    window.addEventListener('pagehide', persist);
    window.addEventListener('beforeunload', persist);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', persist);
      window.removeEventListener('beforeunload', persist);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [persistCurrentLocation]);

  useEffect(() => {
    applyLayout();
  }, [applyLayout]);

  useEffect(() => {
    let frame = 0;
    const handleResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(applyLayout);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, [applyLayout]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const handleLoad = (event: Event) => {
      const detail = (event as CustomEvent<{ doc: Document }>).detail;
      applyBookStyles(detail.doc, settings);
      let pagePress: { startedAt: number; x: number; y: number } | null = null;

      const handlePagePointerDown = (pointerEvent: PointerEvent) => {
        if (pointerEvent.button !== 0 || settings.flow !== 'paginated') return;
        pagePress = {
          startedAt: performance.now(),
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        };
      };

      const handlePagePointerUp = (pointerEvent: PointerEvent) => {
        const press = pagePress;
        pagePress = null;
        if (!press || pointerEvent.button !== 0 || settings.flow !== 'paginated') return;

        const target = getEventTargetElement(pointerEvent.target);
        if (target?.closest('a, button, input, textarea, select, [contenteditable="true"]')) {
          return;
        }

        const heldFor = performance.now() - press.startedAt;
        const movedBy = Math.hypot(pointerEvent.clientX - press.x, pointerEvent.clientY - press.y);
        const selection = detail.doc.getSelection();
        if (heldFor >= 300 || movedBy > 7 || (selection && !selection.isCollapsed)) return;

        const content = view.renderer?.getContents?.().find((item) => item.doc === detail.doc);
        const annotationValue = content?.overlayer?.hitTest({
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        })[0];
        if (annotationValue && highlightsRef.current.some((highlight) => highlight.cfi === annotationValue)) {
          return;
        }

        const frame = detail.doc.defaultView?.frameElement as HTMLElement | null;
        const frameRect = frame?.getBoundingClientRect();
        const pageX = (frameRect?.left ?? 0) + pointerEvent.clientX;
        if (pageX <= window.innerWidth * 0.25) {
          view.prev();
        } else if (pageX >= window.innerWidth * 0.75) {
          view.next();
        }
      };

      const handleBookKeyDown = (keyEvent: KeyboardEvent) => {
        if (isEditableKeyboardTarget(keyEvent.target)) return;
          if (keyEvent.metaKey && (keyEvent.key === ' ' || keyEvent.code === 'Space')) {
            keyEvent.preventDefault();
            view.prev();
            return;
        }
        if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) return;
        if (keyEvent.key === 'ArrowLeft') {
          keyEvent.preventDefault();
          view.prev();
        } else if (keyEvent.key === 'ArrowRight' || keyEvent.key === ' ' || keyEvent.code === 'Space') {
          keyEvent.preventDefault();
          view.next();
        }
      };

      const handleHigherPriorityClick = (clickEvent: MouseEvent) => {
        const target = getEventTargetElement(clickEvent.target);
        const isHigherPriority = Boolean(target?.closest(
          'a[href], button, input, textarea, select, [contenteditable="true"]',
        ));
        higherPriorityClickRef.current = isHigherPriority
          ? { doc: detail.doc, at: performance.now() }
          : null;
      };

      detail.doc.addEventListener('pointerdown', handlePagePointerDown);
      detail.doc.addEventListener('pointerup', handlePagePointerUp);
      detail.doc.addEventListener('click', handleHigherPriorityClick, true);
      detail.doc.addEventListener('keydown', handleBookKeyDown);

      const handleSelection = (selectionEvent: MouseEvent | KeyboardEvent) => {
        if (!activeBookRef.current) return;
        const selection = detail.doc.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setPendingHighlight(null);
          return;
        }

        const range = selection.getRangeAt(0).cloneRange();
        const excerpt = compactExcerpt(selection.toString());
        if (!excerpt) {
          setPendingHighlight(null);
          return;
        }

        const content = view.renderer?.getContents?.().find((item) => item.doc === detail.doc);
        if (!content) return;

        const cfi = view.getCFI(content.index, range);
        const frame = detail.doc.defaultView?.frameElement as HTMLElement | null;
        const frameRect = frame?.getBoundingClientRect();
        const fallbackRect = range.getBoundingClientRect();
        const toolbarWidth = 150;

        setPendingHighlight({
          cfi,
          excerpt,
          range,
          x: Math.min(
            window.innerWidth - toolbarWidth - 12,
            Math.max(16, (frameRect?.left ?? 0) + fallbackRect.right - toolbarWidth),
          ),
          y: Math.min(
            window.innerHeight - 48,
            Math.max(76, (frameRect?.top ?? 0) + fallbackRect.top - 46),
          ),
        });
      };

      detail.doc.addEventListener('mouseup', handleSelection);
      detail.doc.addEventListener('keyup', handleSelection);
      detail.doc.addEventListener('selectionchange', (selectionEvent) => {
        window.setTimeout(() => handleSelection(selectionEvent as unknown as KeyboardEvent), 120);
      });
    };

    const handleRelocate = (event: Event) => {
      const detail = (event as CustomEvent<FoliateLocation>).detail;
      setPendingHighlight(null);
      setHighlightPopover(null);
      setLocation(detail);
      locationRef.current = detail;

      const bookId = openingBookIdRef.current ?? activeBookRef.current?.id;
      if (bookId) {
        saveLocation({
          bookId,
          cfi: detail.cfi ?? null,
          progress: detail.fraction ?? detail.current ?? null,
          tocLabel: detail.tocItem?.label ?? null,
          updatedAt: Date.now(),
        }).catch((reason) => console.error(reason));
      }
    };

    const handleCreateOverlay = () => {
      for (const highlight of highlightsRef.current) {
        view.addAnnotation(toFoliateAnnotation(highlight)).catch((reason) => console.error(reason));
      }
    };

    const handleDrawAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{
        draw: (
          func: typeof drawHighlight,
          options: { color: string; padding: number; noteUnderline: boolean },
        ) => void;
        annotation: StoredHighlight;
      }>).detail;
      detail.draw(drawHighlight, {
        color: detail.annotation.color || HIGHLIGHT_COLOR,
        padding: 1,
        noteUnderline: Boolean(detail.annotation.note.trim()),
      });
    };

    const handleShowAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{ value: string; range: Range }>).detail;
      const highlight = highlightsRef.current.find((item) => item.cfi === detail.value);
      if (!highlight) return;
      const rangeDocument = detail.range.startContainer.ownerDocument
        ?? (detail.range.startContainer as Document);
      const higherPriorityClick = higherPriorityClickRef.current;
      if (
        higherPriorityClick?.doc === rangeDocument
        && performance.now() - higherPriorityClick.at < 250
      ) return;
      const frame = rangeDocument.defaultView?.frameElement as HTMLElement | null;
      const frameRect = frame?.getBoundingClientRect();
      const rects = Array.from(detail.range.getClientRects());
      const rangeRect = detail.range.getBoundingClientRect();
      const firstRect = rects[0] ?? rangeRect;
      const lastRect = rects[rects.length - 1] ?? rangeRect;
      setPendingHighlight(null);
      setHighlightPopover({
        highlight,
        anchor: {
          left: (frameRect?.left ?? 0) + firstRect.left,
          top: (frameRect?.top ?? 0) + firstRect.top,
          right: (frameRect?.left ?? 0) + lastRect.right,
          bottom: (frameRect?.top ?? 0) + lastRect.bottom,
        },
      });
    };

    view.addEventListener('load', handleLoad);
    view.addEventListener('relocate', handleRelocate);
    view.addEventListener('create-overlay', handleCreateOverlay);
    view.addEventListener('draw-annotation', handleDrawAnnotation);
    view.addEventListener('show-annotation', handleShowAnnotation);
    return () => {
      view.removeEventListener('load', handleLoad);
      view.removeEventListener('relocate', handleRelocate);
      view.removeEventListener('create-overlay', handleCreateOverlay);
      view.removeEventListener('draw-annotation', handleDrawAnnotation);
      view.removeEventListener('show-annotation', handleShowAnnotation);
    };
  }, [settings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!activeBook) return;

      if (event.key === 'Escape' && pendingHighlight) {
        setPendingHighlight(null);
        for (const content of viewRef.current?.renderer?.getContents?.() ?? []) {
          content.doc.getSelection()?.removeAllRanges();
        }
        return;
      }

      if (isEditableKeyboardTarget(event.target)) return;

      if (event.metaKey && (event.key === ' ' || event.code === 'Space')) {
        event.preventDefault();
        viewRef.current?.prev();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        viewRef.current?.prev();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        viewRef.current?.next();
      }
      if (event.key === ' ') {
        event.preventDefault();
        viewRef.current?.next();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeBook, pendingHighlight]);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');

    try {
      const id = await makeBookId(file);
      let path: string | undefined;
      if ('__TAURI_INTERNALS__' in window) {
        const { storeBookFile } = await import('./desktop');
        path = await storeBookFile(file.name, id, file);
      }
      const book = await saveBook(file, path, id);
      const targetFolderId = selectedFolderIdRef.current;
      if (targetFolderId) await assignBookToFolder(book.id, targetFolderId);
      await refreshBooks();
      await openStoredBook(book);
    } catch (reason) {
      console.error(reason);
      setError('导入失败。请确认浏览器允许本地存储。');
    } finally {
      setBusy(false);
    }
  }, [openStoredBook, refreshBooks]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;

    let unlisten: (() => void) | undefined;
    import('./desktop')
      .then(async ({ setupDesktopOpenFiles }) => {
        unlisten = await setupDesktopOpenFiles(handleFile);
      })
      .catch((reason) => {
        console.error(reason);
        setError('桌面文件打开监听启动失败。');
      });

    return () => {
      unlisten?.();
    };
  }, [handleFile]);

  const removeStoredBook = async (book: StoredBook) => {
    if (book.path && '__TAURI_INTERNALS__' in window) {
      const { deleteStoredBookFile } = await import('./desktop');
      await deleteStoredBookFile(book.path);
    }
    await removeBook(book.id);
    if (activeBook?.id === book.id) {
      viewRef.current?.close();
      setActiveBook(null);
      setLocation(null);
      setToc([]);
      setHighlights([]);
      setPendingHighlight(null);
      setEditingHighlight(null);
      setTitle('');
      setAuthor('');
    }
    await refreshBooks();
  };

  const jumpToTocHref = async (href: string) => {
    const view = viewRef.current;
    if (!view) return;

    setError('');
    const result = await view.goTo(href);
    if (!result) {
      setError('无法跳转到这个目录位置。');
      return;
    }

    setSideOpen(false);
  };

  const startPendingHighlightNote = () => {
    if (!pendingHighlight || !activeBook) return;
    const now = Date.now();
    const highlight: StoredHighlight = {
      id: getHighlightId(),
      bookId: activeBook.id,
      cfi: pendingHighlight.cfi,
      excerpt: pendingHighlight.excerpt,
      note: '',
      color: HIGHLIGHT_COLOR,
      tocLabel: currentChapter || null,
      createdAt: now,
      updatedAt: now,
    };
    setEditingHighlight(highlight);
    setHighlightNote('');
  };

  const savePendingHighlightOnly = async () => {
    if (!pendingHighlight || !activeBook) return;
    const now = Date.now();
    const highlight: StoredHighlight = {
      id: getHighlightId(),
      bookId: activeBook.id,
      cfi: pendingHighlight.cfi,
      excerpt: pendingHighlight.excerpt,
      note: '',
      color: HIGHLIGHT_COLOR,
      tocLabel: currentChapter || null,
      createdAt: now,
      updatedAt: now,
    };

    await saveHighlight(highlight);
    setHighlights((current) => sortHighlightsByReadingOrder([highlight, ...current]));
    await drawStoredHighlight(highlight);
    setPendingHighlight(null);

    for (const content of viewRef.current?.renderer?.getContents?.() ?? []) {
      content.doc.getSelection()?.removeAllRanges();
    }
  };

  const saveEditingHighlight = async () => {
    if (!editingHighlight) return;
    const next = {
      ...editingHighlight,
      note: highlightNote.trim(),
      updatedAt: Date.now(),
    };
    await saveHighlight(next);
    setHighlights((current) => {
      const without = current.filter((item) => item.id !== next.id);
      return sortHighlightsByReadingOrder([next, ...without]);
    });
    await drawStoredHighlight(next);
    setEditingHighlight(null);
    setPendingHighlight(null);
    setHighlightNote('');

    for (const content of viewRef.current?.renderer?.getContents?.() ?? []) {
      content.doc.getSelection()?.removeAllRanges();
    }
  };

  const deleteStoredHighlight = async (highlight: StoredHighlight) => {
    await removeHighlight(highlight.id);
      await viewRef.current?.deleteAnnotation(toFoliateAnnotation(highlight));
    setHighlights((current) => current.filter((item) => item.id !== highlight.id));
    if (highlightPopover?.highlight.id === highlight.id) setHighlightPopover(null);
    if (editingHighlight?.id === highlight.id) {
      setEditingHighlight(null);
      setHighlightNote('');
    }
  };

  const jumpToHighlight = async (highlight: StoredHighlight) => {
    setViewMode('reader');
    setHighlightsOpen(false);
    await viewRef.current?.goTo(highlight.cfi);
  };

  const progressText = useMemo(() => getProgressText(location), [location]);
  const currentChapter = location?.tocItem?.label ?? '';
  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  );
  const parentFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolder?.parentId) ?? null,
    [folders, selectedFolder],
  );
  const visibleFolders = useMemo(
    () => folders.filter((folder) => (folder.parentId ?? null) === selectedFolderId),
    [folders, selectedFolderId],
  );
  const visibleLibraryBooks = useMemo(
    () => books.filter((book) => selectedFolderId
      ? bookFolders[book.id] === selectedFolderId
      : !bookFolders[book.id]),
    [bookFolders, books, selectedFolderId],
  );
  const visibleLibraryKeys = useMemo(
    () => [
      ...visibleFolders.map((folder) => `folder:${folder.id}`),
      ...visibleLibraryBooks.map((book) => `book:${book.id}`),
    ],
    [visibleFolders, visibleLibraryBooks],
  );
  const orderedLibraryKeys = useMemo(() => {
    const visibleKeys = new Set(visibleLibraryKeys);
    const savedKeys = libraryOrder.filter((key) => visibleKeys.has(key));
    const savedKeySet = new Set(savedKeys);
    return [...savedKeys, ...visibleLibraryKeys.filter((key) => !savedKeySet.has(key))];
  }, [libraryOrder, visibleLibraryKeys]);
  const libraryOrderIndex = useMemo(
    () => new Map(orderedLibraryKeys.map((key, index) => [key, index])),
    [orderedLibraryKeys],
  );

  useEffect(() => {
    let cancelled = false;
    setSortMode(false);
    setDraggedLibraryKey(null);
    draggedLibraryKeyRef.current = null;
    getLibraryOrder(selectedFolderId)
      .then((savedOrder) => {
        if (cancelled) return;
        const nextOrder = savedOrder ?? [];
        libraryOrderRef.current = nextOrder;
        setLibraryOrderState(nextOrder);
      })
      .catch((reason) => {
        console.error(reason);
        if (!cancelled) setError('读取书库排序失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFolderId]);

  const normalizeLibraryOrder = (order: string[]) => {
    const visibleKeys = new Set(visibleLibraryKeys);
    const savedKeys = order.filter((key) => visibleKeys.has(key));
    const savedKeySet = new Set(savedKeys);
    return [...savedKeys, ...visibleLibraryKeys.filter((key) => !savedKeySet.has(key))];
  };

  const persistCurrentLibraryOrder = async () => {
    const nextOrder = normalizeLibraryOrder(libraryOrderRef.current);
    libraryOrderRef.current = nextOrder;
    setLibraryOrderState(nextOrder);
    await setLibraryOrder(selectedFolderId, nextOrder);
  };

  const moveLibraryItemBefore = (targetKey: string) => {
    const draggedKey = draggedLibraryKeyRef.current;
    if (!sortMode || !draggedKey || draggedKey === targetKey) return;
    const currentOrder = normalizeLibraryOrder(libraryOrderRef.current);
    const sourceIndex = currentOrder.indexOf(draggedKey);
    const targetIndex = currentOrder.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextOrder = [...currentOrder];
    nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, draggedKey);
    libraryOrderRef.current = nextOrder;
    setLibraryOrderState(nextOrder);
  };

  const handleLibraryPointerDown = (event: React.PointerEvent<HTMLElement>, itemKey: string) => {
    if (!sortMode || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggedLibraryKeyRef.current = itemKey;
    setDraggedLibraryKey(itemKey);
  };

  const handleLibraryPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggedLibraryKeyRef.current) return;
    event.preventDefault();
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-library-sort-key]');
    const targetKey = target?.dataset.librarySortKey;
    if (targetKey) moveLibraryItemBefore(targetKey);
  };

  const handleLibraryPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggedLibraryKeyRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggedLibraryKeyRef.current = null;
    setDraggedLibraryKey(null);
    persistCurrentLibraryOrder().catch((reason) => {
      console.error(reason);
      setError('保存书库排序失败。');
    });
  };

  const toggleSortMode = () => {
    setBookMenuId(null);
    if (sortMode) {
      persistCurrentLibraryOrder().catch((reason) => {
        console.error(reason);
        setError('保存书库排序失败。');
      });
      setSortMode(false);
      return;
    }
    const nextOrder = normalizeLibraryOrder(libraryOrderRef.current);
    libraryOrderRef.current = nextOrder;
    setLibraryOrderState(nextOrder);
    setSortMode(true);
  };

  const saveLibraryFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    const parentId = selectedFolder && !selectedFolder.parentId ? selectedFolder.id : null;
    if (folders.some((folder) => (
      (folder.parentId ?? null) === parentId
      && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    ))) {
      setError('已经有同名文件夹。');
      return;
    }
    await createFolder(name, parentId);
    setFolderName('');
    setFolderDialogOpen(false);
    await refreshBooks();
  };

  const moveBookToFolder = async (bookId: string, folderId: string) => {
    await assignBookToFolder(bookId, folderId || null);
    setBookMenuId(null);
    await refreshBooks();
  };

  const deleteLibraryFolder = async (folder: StoredFolder) => {
    await removeFolder(folder.id, folder.parentId ?? null);
    setFolderToDelete(null);
    if (selectedFolderId === folder.id) setSelectedFolderId(folder.parentId ?? null);
    await refreshBooks();
  };

  return (
    <main
      className={`app theme-${settings.theme}`}
      style={{ '--reader-bg-color': settings.backgroundColor } as React.CSSProperties}
    >
      <input
        ref={fileInputRef}
        accept=".epub,application/epub+zip"
        className="file-input"
        type="file"
        onChange={(event) => handleFile(event.target.files?.[0])}
      />
      {viewMode === 'reader' && activeBook && (
        <>
          <div
            aria-hidden="true"
            className="sidebar-hotspot"
            onMouseEnter={() => setSideOpen(true)}
          />
          {sideOpen && (
            <button
              aria-label="关闭侧栏"
              className="sidebar-scrim"
              type="button"
              onClick={() => setSideOpen(false)}
            />
          )}
          <aside
            className={`sidebar ${sideOpen ? 'open' : ''}`}
            onMouseEnter={() => setSideOpen(true)}
            onMouseLeave={() => setSideOpen(false)}
          >
            <div className="sidebar-head">
              <div className="brand">
                <Menu size={20} />
                <span>目录</span>
              </div>
              <button className="icon-button" type="button" onClick={() => setSideOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <section className="panel toc-panel">
              {!!toc.length ? (
                <div
                  className="toc-scroll"
                  onTouchMove={(event) => event.stopPropagation()}
                  onWheel={(event) => event.stopPropagation()}
                >
                  <TocTree
                    activeHref={location?.tocItem?.href}
                    items={toc}
                    onSelect={(href) => {
                      jumpToTocHref(href).catch((reason) => {
                        console.error(reason);
                        setError('无法跳转到这个目录位置。');
                      });
                    }}
                  />
                </div>
              ) : (
                <p className="empty-text">当前书籍没有可用目录。</p>
              )}
            </section>
          </aside>
        </>
      )}
      {settingsOpen && (
        <>
          <button
            aria-label="关闭排版设置"
            className="settings-scrim"
            type="button"
            onClick={() => setSettingsOpen(false)}
          />
          <div className="settings-popover">
            <div className="panel-title">
              <Type size={16} />
              排版
            </div>
            <label className="control-row">
              <span>字号</span>
              <input
                max="24"
                min="14"
                type="range"
                value={settings.fontSize}
                onChange={(event) => patchSettings({ fontSize: Number(event.target.value) })}
              />
            </label>
            <label className="control-row">
              <span>行距</span>
              <input
                max="2"
                min="1.25"
                step="0.05"
                type="range"
                value={settings.lineHeight}
                onChange={(event) => patchSettings({ lineHeight: Number(event.target.value) })}
              />
            </label>
            <label className="control-row">
              <span>宽度</span>
              <input
                max="1240"
                min="640"
                step="20"
                type="range"
                value={settings.maxWidth}
                onChange={(event) => patchSettings({ maxWidth: Number(event.target.value) })}
              />
            </label>
            <div className="segmented">
              <button
                className={settings.flow === 'paginated' ? 'selected' : ''}
                type="button"
                onClick={() => patchSettings({ flow: 'paginated' })}
              >
                <Columns2 size={16} />
              </button>
              <button
                className={settings.flow === 'scrolled' ? 'selected' : ''}
                type="button"
                onClick={() => patchSettings({ flow: 'scrolled' })}
              >
                <ScrollText size={16} />
              </button>
            </div>
            <div className="segmented">
              <button
                className={settings.theme === 'paper' ? 'selected' : ''}
                type="button"
                onClick={() => patchSettings({ theme: 'paper' })}
              >
                <Sun size={16} />
              </button>
              <button
                className={settings.theme === 'dark' ? 'selected' : ''}
                type="button"
                onClick={() => patchSettings({ theme: 'dark' })}
              >
                <Moon size={16} />
              </button>
            </div>
            {settings.theme === 'paper' && (
              <div className="background-swatches" aria-label="阅读背景色">
                {BACKGROUND_COLORS.map((color) => (
                  <button
                    key={color}
                    aria-label={`切换背景色 ${color}`}
                    className={settings.backgroundColor === color ? 'selected' : ''}
                    style={{ backgroundColor: color }}
                    type="button"
                    onClick={() => patchSettings({ backgroundColor: color })}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {highlightsOpen && (
        <>
          <button
            aria-label="关闭高亮列表"
            className="modal-scrim"
            type="button"
            onClick={() => setHighlightsOpen(false)}
          />
          <section className="highlights-panel">
            <div className="modal-head">
              <div>
                <h2>高亮</h2>
                <p>{activeBook ? `${highlights.length} 条记录` : '请先打开一本书'}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setHighlightsOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="highlight-list">
              {highlights.map((highlight) => (
                <article key={highlight.id} className="highlight-card">
                  <button
                    className="highlight-card-main"
                    type="button"
                    onClick={() => {
                      jumpToHighlight(highlight).catch((reason) => {
                        console.error(reason);
                        setError('无法跳转到这条高亮。');
                      });
                    }}
                  >
                    <mark>{highlight.excerpt}</mark>
                    {highlight.note && <span>{highlight.note}</span>}
                    <small>{highlight.tocLabel || '未命名位置'}</small>
                  </button>
                  <div className="highlight-card-actions">
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => {
                        setEditingHighlight(highlight);
                        setHighlightNote(highlight.note);
                      }}
                    >
                      <MessageSquareText size={17} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => {
                        deleteStoredHighlight(highlight).catch((reason) => {
                          console.error(reason);
                          setError('删除高亮失败。');
                        });
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              ))}
              {!highlights.length && <p className="empty-text">这本书还没有高亮。</p>}
            </div>
          </section>
        </>
      )}

      {pendingHighlight && !editingHighlight && (
        <div
          className="selection-toolbar"
          style={{ left: pendingHighlight.x, top: pendingHighlight.y }}
        >
          <button
            type="button"
            onClick={() => {
              savePendingHighlightOnly().catch((reason) => {
                console.error(reason);
                setError('保存高亮失败。');
              });
            }}
          >
            <Highlighter size={15} />
            划线
          </button>
          <button type="button" onClick={startPendingHighlightNote}>
            <MessageSquareText size={15} />
            写想法
          </button>
        </div>
      )}

      {highlightPopover && !editingHighlight && (
        <>
          <button
            aria-label="关闭划线操作"
            className="highlight-popover-scrim"
            type="button"
            onClick={() => setHighlightPopover(null)}
          />
          <div
            ref={highlightPopoverRef}
            className="highlight-popover"
            style={{ left: highlightPopoverPosition.left, top: highlightPopoverPosition.top }}
          >
            <div className="highlight-popover-actions">
              <button
                type="button"
                onClick={() => {
                  setEditingHighlight(highlightPopover.highlight);
                  setHighlightNote(highlightPopover.highlight.note);
                  setHighlightPopover(null);
                }}
              >
                <MessageSquareText size={15} />
                写想法
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => {
                  deleteStoredHighlight(highlightPopover.highlight).catch((reason) => {
                    console.error(reason);
                    setError('删除高亮失败。');
                  });
                }}
              >
                <Trash2 size={15} />
                删除划线
              </button>
            </div>
            {highlightPopover.highlight.note && (
              <div className="highlight-popover-note">
                <span>想法</span>
                <p>{highlightPopover.highlight.note}</p>
              </div>
            )}
          </div>
        </>
      )}

      {editingHighlight && (
        <>
          <button
            aria-label="关闭高亮感想"
            className="modal-scrim"
            type="button"
            onClick={() => {
              setEditingHighlight(null);
              setHighlightNote('');
              setPendingHighlight(null);
            }}
          />
          <section className="note-dialog">
            <div className="modal-head">
              <div>
                <h2>高亮感想</h2>
                <p>{editingHighlight.tocLabel || '当前选区'}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setEditingHighlight(null);
                  setHighlightNote('');
                  setPendingHighlight(null);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <blockquote>{editingHighlight.excerpt}</blockquote>
            <textarea
              autoFocus
              placeholder="写一点感想..."
              value={highlightNote}
              onChange={(event) => setHighlightNote(event.target.value)}
            />
            <div className="dialog-actions">
              {highlights.some((item) => item.id === editingHighlight.id) && (
                <button
                  className="text-button danger"
                  type="button"
                  onClick={() => {
                    deleteStoredHighlight(editingHighlight).catch((reason) => {
                      console.error(reason);
                      setError('删除高亮失败。');
                    });
                  }}
                >
                  删除
                </button>
              )}
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setEditingHighlight(null);
                  setHighlightNote('');
                  setPendingHighlight(null);
                }}
              >
                取消
              </button>
              <button
                className="text-button primary"
                type="button"
                onClick={() => {
                  saveEditingHighlight().catch((reason) => {
                    console.error(reason);
                    setError('保存高亮失败。');
                  });
                }}
              >
                保存
              </button>
            </div>
          </section>
        </>
      )}

      {folderDialogOpen && (
        <>
          <button
            aria-label="关闭新建文件夹"
            className="modal-scrim"
            type="button"
            onClick={() => {
              setFolderDialogOpen(false);
              setFolderName('');
            }}
          />
          <section className="note-dialog folder-dialog">
            <div className="modal-head">
              <div>
                <h2>新建文件夹</h2>
                <p>{selectedFolder ? `在“${selectedFolder.name}”中新建子文件夹` : '给这一组图书起个名字'}</p>
              </div>
              <button
                aria-label="关闭"
                className="icon-button"
                type="button"
                onClick={() => {
                  setFolderDialogOpen(false);
                  setFolderName('');
                }}
              >
                <X size={18} />
              </button>
            </div>
            <input
              autoFocus
              maxLength={40}
              placeholder="例如：心理学"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  saveLibraryFolder().catch((reason) => {
                    console.error(reason);
                    setError('创建文件夹失败。');
                  });
                }
              }}
            />
            <div className="dialog-actions">
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setFolderDialogOpen(false);
                  setFolderName('');
                }}
              >
                取消
              </button>
              <button
                className="text-button primary"
                disabled={!folderName.trim()}
                type="button"
                onClick={() => {
                  saveLibraryFolder().catch((reason) => {
                    console.error(reason);
                    setError('创建文件夹失败。');
                  });
                }}
              >
                创建
              </button>
            </div>
          </section>
        </>
      )}

      {folderToDelete && (
        <>
          <button
            aria-label="关闭删除文件夹确认"
            className="modal-scrim"
            type="button"
            onClick={() => setFolderToDelete(null)}
          />
          <section className="note-dialog folder-delete-dialog">
            <div className="modal-head">
              <div>
                <h2>删除文件夹</h2>
                <p>
                  “{folderToDelete.name}”及其子文件夹中的
                  {' '}
                  {books.filter((book) => {
                    const childIds = folders
                      .filter((folder) => folder.parentId === folderToDelete.id)
                      .map((folder) => folder.id);
                    return [folderToDelete.id, ...childIds].includes(bookFolders[book.id]);
                  }).length}
                  {' '}
                  本书将移到{folderToDelete.parentId ? '上一级文件夹' : '书库'}，书籍不会被删除。
                </p>
              </div>
              <button className="icon-button" type="button" onClick={() => setFolderToDelete(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="dialog-actions">
              <button className="text-button" type="button" onClick={() => setFolderToDelete(null)}>取消</button>
              <button
                className="text-button danger"
                type="button"
                onClick={() => {
                  deleteLibraryFolder(folderToDelete).catch((reason) => {
                    console.error(reason);
                    setError('删除文件夹失败。');
                  });
                }}
              >
                删除
              </button>
            </div>
          </section>
        </>
      )}

      <section className="reader-shell">
        {viewMode === 'reader' && activeBook && (
          <div
            className={`topbar-hover-zone ${topOpen ? 'open' : ''}`}
            onMouseEnter={() => setTopOpen(true)}
            onMouseLeave={() => setTopOpen(false)}
          >
            <div aria-hidden="true" className="topbar-hotspot" />
            <header className={`topbar ${topOpen ? 'open' : ''}`}>
              <button
                className="icon-button"
                type="button"
                onClick={async () => {
                  await persistCurrentLocation();
                  setSideOpen(false);
                  setSettingsOpen(false);
                  setViewMode('library');
                }}
              >
                <Library size={18} />
              </button>
              <div className="book-heading">
                <strong>{title || 'myEPUB'}</strong>
                <span>{author || currentChapter || '导入一本书开始阅读'}</span>
              </div>
              <div className="top-nav">
                <span>{currentChapter || progressText}</span>
              </div>
              <div className="top-actions">
                <span className="progress-pill">{progressText}</span>
                <button
                  className={`icon-button ${highlightsOpen ? 'selected' : ''}`}
                  disabled={!activeBook}
                  type="button"
                  onClick={() => {
                    setSettingsOpen(false);
                    setHighlightsOpen((open) => !open);
                  }}
                >
                  <Highlighter size={18} />
                </button>
                <button
                  className={`icon-button ${settingsOpen ? 'selected' : ''}`}
                  type="button"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <Type size={18} />
                </button>
              </div>
            </header>
          </div>
        )}

        <div className="reader-stage">
          {viewMode === 'library' && (
            <div className="library-page">
              <div className="library-head">
                <div>
                  <div className="library-title-row">
                    <h1>{selectedFolder?.name ?? '书库'}</h1>
                    {selectedFolder ? (
                      <button
                        className="library-back-button"
                        type="button"
                        onClick={() => setSelectedFolderId(selectedFolder.parentId ?? null)}
                      >
                        <ChevronLeft size={18} />
                        返回{parentFolder?.name ?? '书库'}
                      </button>
                    ) : null}
                  </div>
                  <p>
                    {selectedFolder
                      ? `${visibleLibraryBooks.length} 本 EPUB${visibleFolders.length ? ` · ${visibleFolders.length} 个文件夹` : ''}`
                      : `${books.length} 本 EPUB · ${visibleFolders.length} 个文件夹`}
                  </p>
                </div>
                <div className="library-head-actions">
                  <button
                    aria-pressed={sortMode}
                    className={`library-sort-button ${sortMode ? 'active' : ''}`}
                    disabled={visibleLibraryKeys.length < 2}
                    type="button"
                    onClick={toggleSortMode}
                  >
                    {sortMode ? <Check size={18} /> : <ArrowUpDown size={18} />}
                    {sortMode ? '完成' : '排序'}
                  </button>
                  {!selectedFolder?.parentId && (
                    <button
                      className="library-folder-button"
                      type="button"
                      onClick={() => setFolderDialogOpen(true)}
                    >
                      <FolderPlus size={18} />
                      新建文件夹
                    </button>
                  )}
                  <button className="import-button library-import" type="button" onClick={() => fileInputRef.current?.click()}>
                    <Plus size={18} />
                    导入 EPUB
                  </button>
                </div>
              </div>
              <div className="library-list">
                {visibleFolders.map((folder) => {
                  const containedFolderIds = new Set([
                    folder.id,
                    ...folders.filter((item) => item.parentId === folder.id).map((item) => item.id),
                  ]);
                  const folderBooks = books.filter((book) => containedFolderIds.has(bookFolders[book.id]));
                  const count = folderBooks.length;
                  return (
                    <article
                      key={folder.id}
                      className={`library-book library-folder-card ${sortMode ? 'sorting' : ''} ${draggedLibraryKey === `folder:${folder.id}` ? 'dragging' : ''}`}
                      data-library-sort-key={`folder:${folder.id}`}
                      style={{ order: libraryOrderIndex.get(`folder:${folder.id}`) }}
                    >
                      <button
                        className="library-book-main"
                        type="button"
                        onClick={() => setSelectedFolderId(folder.id)}
                      >
                        <span
                          className="book-cover folder-cover"
                          data-preview-count={Math.min(folderBooks.length, 3)}
                          aria-hidden="true"
                        >
                          <span className="folder-preview-stack">
                            {folderBooks.slice(0, 3).map((book, index) => (
                              <span key={book.id} className={`folder-preview-book folder-preview-book-${index + 1}`}>
                                {bookCovers[book.id] && !badCoverIds.has(book.id) ? (
                                  <img src={bookCovers[book.id]} alt="" />
                                ) : (
                                  <span className="folder-preview-placeholder"><BookOpen size={22} /></span>
                                )}
                              </span>
                            ))}
                          </span>
                          <span className="folder-cover-sheet" />
                        </span>
                        <span className="book-meta">
                          <strong>{folder.name}</strong>
                          <span>{count} 本图书</span>
                        </span>
                      </button>
                      <button
                        aria-label={`删除文件夹 ${folder.name}`}
                        className="icon-button"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setFolderToDelete(folder);
                        }}
                      >
                        <Trash2 size={17} />
                      </button>
                      {sortMode && (
                        <span
                          className="library-sort-surface"
                          aria-hidden="true"
                          onPointerDown={(event) => handleLibraryPointerDown(event, `folder:${folder.id}`)}
                          onPointerMove={handleLibraryPointerMove}
                          onPointerUp={handleLibraryPointerEnd}
                          onPointerCancel={handleLibraryPointerEnd}
                        >
                          <span><GripVertical size={20} /></span>
                        </span>
                      )}
                    </article>
                  );
                })}
                {visibleLibraryBooks.map((book) => (
                        <article
                          key={book.id}
                          className={`library-book ${activeBook?.id === book.id ? 'active' : ''} ${sortMode ? 'sorting' : ''} ${draggedLibraryKey === `book:${book.id}` ? 'dragging' : ''}`}
                          data-library-sort-key={`book:${book.id}`}
                          style={{ order: libraryOrderIndex.get(`book:${book.id}`) }}
                        >
                          <button className="library-book-cover-button" type="button" onClick={() => openStoredBook(book)}>
                            <span className="book-cover" aria-hidden="true">
                              {bookCovers[book.id] && !badCoverIds.has(book.id) ? (
                                <img
                                  src={bookCovers[book.id]}
                                  alt=""
                                  onError={() => {
                                    setBadCoverIds((current) => new Set(current).add(book.id));
                                    updateBookDetails(book.id, { cover: null })
                                      .then(refreshBooks)
                                      .catch((reason) => console.error(reason));
                                  }}
                                />
                              ) : (
                                <span className="book-cover-placeholder">
                                  <BookOpen size={34} />
                                </span>
                              )}
                            </span>
                          </button>
                          <div className="book-card-meta">
                            <button className="book-title-button" type="button" onClick={() => openStoredBook(book)}>
                              <span className="book-meta">
                                <strong>{getDisplayBookTitle(book)}</strong>
                                <span>{book.author || '未知作者'}</span>
                              </span>
                            </button>
                            <button
                              aria-label={`${getDisplayBookTitle(book)}的操作`}
                              aria-expanded={bookMenuId === book.id}
                              className="book-menu-button"
                              type="button"
                              onClick={() => setBookMenuId((current) => current === book.id ? null : book.id)}
                            >
                              <EllipsisVertical size={18} />
                            </button>
                            {bookMenuId === book.id && (
                              <>
                                <button
                                  aria-label="关闭图书操作菜单"
                                  className="book-menu-scrim"
                                  type="button"
                                  onClick={() => setBookMenuId(null)}
                                />
                                <div className="book-action-menu">
                                  <div className="book-action-group">
                                    <span>移动到分组</span>
                                    <details className="book-group-dropdown">
                                      <summary>
                                        <span>{folders.find((item) => item.id === bookFolders[book.id])?.name ?? '未分组'}</span>
                                        <ChevronDown size={14} aria-hidden="true" />
                                      </summary>
                                      <div className="book-group-options">
                                        <button
                                          className={!bookFolders[book.id] ? 'selected' : ''}
                                          type="button"
                                          onClick={() => {
                                            moveBookToFolder(book.id, '').catch((reason) => {
                                              console.error(reason);
                                              setError('移动图书失败。');
                                            });
                                          }}
                                        >
                                          <span>未分组</span>
                                          {!bookFolders[book.id] && <span aria-hidden="true">✓</span>}
                                        </button>
                                      {folders.map((item) => (
                                        <button
                                          key={item.id}
                                          className={bookFolders[book.id] === item.id ? 'selected' : ''}
                                          type="button"
                                          onClick={() => {
                                            moveBookToFolder(book.id, item.id).catch((reason) => {
                                              console.error(reason);
                                              setError('移动图书失败。');
                                            });
                                          }}
                                        >
                                          <span>{item.name}</span>
                                          {bookFolders[book.id] === item.id && <span aria-hidden="true">✓</span>}
                                        </button>
                                      ))}
                                      </div>
                                    </details>
                                  </div>
                                  <div className="book-action-divider" />
                                  <button
                                    className="book-action-reveal"
                                    type="button"
                                    onClick={() => {
                                      setBookMenuId(null);
                                      if (!('__TAURI_INTERNALS__' in window)) {
                                        setError('“在文件夹中显示”仅在桌面应用中可用。');
                                        return;
                                      }
                                      ensureBookFile(book)
                                        .then(async () => {
                                          const storedBook = await getBook(book.id);
                                          if (!storedBook?.path) throw new Error('书籍存储路径不存在');
                                          const { revealStoredBook } = await import('./desktop');
                                          return revealStoredBook(storedBook.path);
                                        })
                                        .catch((reason) => {
                                          console.error(reason);
                                          setError('无法在文件夹中显示这本书。');
                                        });
                                    }}
                                  >
                                    <Folder size={15} />
                                    <span>在文件夹中显示</span>
                                  </button>
                                  <div className="book-action-divider" />
                                  <button
                                    className="book-action-delete"
                                    type="button"
                                    onClick={() => {
                                      setBookMenuId(null);
                                      removeStoredBook(book).catch((reason) => {
                                        console.error(reason);
                                        setError('删除图书失败。');
                                      });
                                    }}
                                  >
                                    <Trash2 size={15} />
                                    <span>删除图书</span>
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                          {sortMode && (
                            <span
                              className="library-sort-surface"
                              aria-hidden="true"
                              onPointerDown={(event) => handleLibraryPointerDown(event, `book:${book.id}`)}
                              onPointerMove={handleLibraryPointerMove}
                              onPointerUp={handleLibraryPointerEnd}
                              onPointerCancel={handleLibraryPointerEnd}
                            >
                              <span><GripVertical size={20} /></span>
                            </span>
                          )}
                        </article>
                ))}
                {selectedFolder && !visibleLibraryBooks.length && !visibleFolders.length && (
                  <div className="library-folder-empty">
                    <Folder size={42} />
                    <p>这个文件夹还是空的</p>
                    <span>可通过书名右侧的菜单移动图书</span>
                  </div>
                )}
                {!selectedFolder && !books.length && !folders.length && (
                  <button className="drop-zone library-empty" type="button" onClick={() => fileInputRef.current?.click()}>
                    <BookOpen size={44} />
                    <h1>导入一本 EPUB</h1>
                    <p>文件会保存在本地书库中，阅读进度会自动恢复。</p>
                  </button>
                )}
              </div>
            </div>
          )}
          {!activeBook && viewMode === 'reader' && (
            <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
              <BookOpen size={44} />
              <h1>打开一本 EPUB</h1>
              <p>文件会保存在当前浏览器的本地存储中，阅读进度会自动恢复。</p>
            </div>
          )}

          {error && <div className="toast">{error}</div>}
          {busy && <div className="loading">正在处理...</div>}

          <foliate-view ref={viewRef} className="reader-view" />
          {activeBook && settings.flow === 'paginated' && <div aria-hidden="true" className="book-seam" />}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
