// Bounds everywhere are [xmin, ymin, xmax, ymax] in native PDF coordinates.
export function orderedBounds([x1, y1, x2, y2]) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

export function viewportBounds(viewport, bounds) {
  // PDF.js 6 exposes point conversion; transform the two opposite corners.
  return orderedBounds([
    ...viewport.convertToViewportPoint(bounds[0], bounds[1]),
    ...viewport.convertToViewportPoint(bounds[2], bounds[3]),
  ]);
}

export function cropGeometry(pdfPage, bounds, scale = 1) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Invalid region bounds.');
  const page = orderedBounds(pdfPage.view);
  if (bounds[0] < page[0] || bounds[1] < page[1] || bounds[2] > page[2] || bounds[3] > page[3]) {
    throw new Error('Region bounds are outside the page.');
  }
  const viewport = pdfPage.getViewport({ scale });
  const [left, top, right, bottom] = viewportBounds(viewport, bounds);
  return { width: right - left, height: bottom - top, left, top,
    viewport: pdfPage.getViewport({ scale, offsetX: -left, offsetY: -top }) };
}

// Only the crop has a bitmap. The lightweight full-page text layer is translated
// inside the clipped region, using CSS pixels independently of bitmap resolution.
export function createRegionView({ pdfjs, pdfPage, bounds, scale, container }) {
  const crop = cropGeometry(pdfPage, bounds, scale);
  const ratio = Math.min(window.devicePixelRatio || 1, 2,
    Math.sqrt(2_000_000 / (crop.width * crop.height)), 4096 / crop.width, 4096 / crop.height);
  const bitmap = cropGeometry(pdfPage, bounds, scale * ratio);
  const div = document.createElement('div');
  div.className = 'pdf-region-crop';
  div.style.width = `${crop.width}px`;
  div.style.height = `${crop.height}px`;
  div.style.setProperty('--total-scale-factor', scale * pdfPage.userUnit);
  div.style.setProperty('--scale-round-x', '1px');
  div.style.setProperty('--scale-round-y', '1px');
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bitmap.width);
  canvas.height = Math.ceil(bitmap.height);
  canvas.style.width = `${crop.width}px`;
  canvas.style.height = `${crop.height}px`;
  const textContainer = document.createElement('div');
  textContainer.className = 'textLayer';
  textContainer.style.left = `${-crop.left}px`;
  textContainer.style.top = `${-crop.top}px`;
  div.append(canvas, textContainer);
  container.append(div);
  const text = new pdfjs.TextLayer({ container: textContainer,
    textContentSource: pdfPage.streamTextContent(), viewport: pdfPage.getViewport({ scale }) });
  let task;
  return {
    div,
    draw() {
      task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: bitmap.viewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE });
      return Promise.all([task.promise, text.render()]);
    },
    reset() {
      task?.cancel();
      text.cancel();
      canvas.width = canvas.height = 0;
      div.remove();
    },
  };
}
