/**
 * Vite's build.assetsInlineLimit: false keeps an asset a file, undefined leaves Vite's default (inline under 4 KB).
 * Fonts are always files: the API's Content-Security-Policy (default-src 'self', no font-src) refuses a data: font.
 */
export const inlineAsset = (file: string): false | undefined => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined);
