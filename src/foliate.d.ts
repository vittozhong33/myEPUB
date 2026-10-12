export type TocItem = {
  label: string;
  href?: string | null;
  subitems?: TocItem[] | null;
};

export type FoliateLocation = {
  cfi?: string;
  fraction?: number;
  current?: number;
  total?: number;
  tocItem?: {
    label?: string;
    href?: string | null;
  };
  range?: Range;
};

export type FoliateBook = {
  toc?: TocItem[];
  pageList?: TocItem[];
  sections?: Array<{ id?: string; linear?: string }>;
  getCover?: () => Promise<Blob | null | undefined>;
  metadata?: {
    title?: string | Record<string, string>;
    author?: string | string[] | Record<string, string>;
  };
};

export type FoliateRenderer = HTMLElement & {
  getContents?: () => Array<{
    doc: Document;
    index: number;
    overlayer?: {
      hitTest: (point: { x: number; y: number }) => [string?, Range?];
    };
  }>;
};

export type FoliateViewElement = HTMLElement & {
  book?: FoliateBook;
  renderer?: FoliateRenderer;
  lastLocation?: FoliateLocation | null;
  open: (book: File | Blob | string | FoliateBook) => Promise<void>;
  close: () => void;
  init: (options: { lastLocation?: string | null; showTextStart?: boolean }) => Promise<void>;
  prev: () => Promise<void>;
  next: () => Promise<void>;
  goTo: (target: string | number | { fraction: number }) => Promise<unknown>;
  goLeft: () => Promise<void>;
  goRight: () => Promise<void>;
  getCFI: (index: number, range?: Range) => string;
  addAnnotation: (annotation: unknown, remove?: boolean) => Promise<unknown>;
  deleteAnnotation: (annotation: unknown) => Promise<unknown>;
  showAnnotation: (annotation: unknown) => Promise<void>;
};
