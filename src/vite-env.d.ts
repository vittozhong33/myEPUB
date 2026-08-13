/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import type { FoliateViewElement } from './foliate';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'foliate-view': DetailedHTMLProps<HTMLAttributes<FoliateViewElement>, FoliateViewElement>;
    }
  }
}

interface Window {
  __TAURI_INTERNALS__?: unknown;
}
