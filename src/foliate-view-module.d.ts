declare module 'foliate-js/view.js' {
  export function makeBook(
    file: File | Blob | string,
  ): Promise<import('./foliate').FoliateBook>;
}
