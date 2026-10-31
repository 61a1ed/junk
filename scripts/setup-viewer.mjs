import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import release from '../pdfjs-release.json' with { type: 'json' };

const destination = fileURLToPath(new URL('../.cache/pdfjs/', import.meta.url));

export async function installViewer(archive, target = destination) {
  target = path.resolve(target);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error('PDF.js archive checksum mismatch; no assets installed.');
  const files = unzipSync(archive);
  const htmlPath = 'web/viewer.html';
  const coreScript = '<script src="../build/pdf.mjs" type="module"></script>';
  const html = new TextDecoder().decode(files[htmlPath]);
  if (html.split(coreScript).length !== 2) throw new Error('Unexpected PDF.js viewer HTML; review the adapter injection.');
  files[htmlPath] = new TextEncoder().encode(html.replace(coreScript, `<script src="/reader.js"></script>\n${coreScript}`));

  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}-`);
  try {
    for (const [name, bytes] of Object.entries(files)) {
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part.includes(':'))) {
        throw new Error(`Unsafe PDF.js archive path: ${name}`);
      }
      if (name.endsWith('/')) continue;
      const filename = path.join(staging, name);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.dependencies['pdfjs-dist'] !== release.version) throw new Error('Update the npm PDF.js pin and pdfjs-release.json together.');
  let archive;
  if (process.env.PDFJS_ARCHIVE) {
    archive = await readFile(process.env.PDFJS_ARCHIVE);
  } else {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`PDF.js download failed: HTTP ${response.status}`);
    archive = new Uint8Array(await response.arrayBuffer());
  }
  await installViewer(archive);
  console.log(`Installed verified PDF.js ${release.version} viewer in .cache/pdfjs`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
