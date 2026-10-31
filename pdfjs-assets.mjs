import { fileURLToPath } from 'node:url';

const pdfjsRoot = new URL('./node_modules/pdfjs-dist/', import.meta.url);

export function pdfjsAssetDirectory(name, { root = pdfjsRoot, windows } = {}) {
  // PDF.js requires a literal trailing '/', including on Windows. Its Node
  // loader passes this string to fs.readFile, so keep a decoded filesystem
  // path (not a file:// URL). Windows also accepts the final '/' separator.
  return `${fileURLToPath(new URL(name, root), { windows })}/`;
}
