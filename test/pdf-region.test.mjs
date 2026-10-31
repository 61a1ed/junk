import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cropGeometry, orderedBounds, viewportBounds } from '../public/pdf-region.js';
import { makeReadingFixturePdf } from './fixture.mjs';

test('crop-sized rendering matches full-page pixels at every rotation and an offset page origin', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const task = pdfjs.getDocument({ data: makeReadingFixturePdf({ rotation, origin: [-20, 10] }),
      useSystemFonts: true, disableFontFace: true });
    try {
      const page = await task.promise.then(pdf => pdf.getPage(1));
      const bounds = [40, 650, 310, 760];
      const viewport = page.getViewport({ scale: 2 });
      const displayed = viewportBounds(viewport, bounds);
      const roundTrip = orderedBounds([
        ...viewport.convertToPdfPoint(displayed[0], displayed[1]),
        ...viewport.convertToPdfPoint(displayed[2], displayed[3]),
      ]);
      assert.deepEqual(roundTrip, bounds);
      const crop = cropGeometry(page, bounds, 2);
      const full = createCanvas(viewport.width, viewport.height);
      const small = createCanvas(crop.width, crop.height);
      await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;
      await page.render({ canvasContext: small.getContext('2d'), viewport: crop.viewport }).promise;
      const expected = full.getContext('2d').getImageData(crop.left, crop.top, crop.width, crop.height).data;
      const actual = small.getContext('2d').getImageData(0, 0, crop.width, crop.height).data;
      assert.deepEqual(actual, expected, `crop pixels at ${rotation} degrees`);
      assert.ok(small.width * small.height < full.width * full.height / 10);
      assert.throws(() => cropGeometry(page, [0, 0, 10, 10]), /outside/);
      assert.throws(() => cropGeometry(page, [0, 20, 0, 30]), /Invalid/);
    } finally { await task.destroy(); }
  }
});
