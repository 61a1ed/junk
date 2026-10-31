/**
 * Deterministic PDF fixtures with independently placed page streams.
 *
 * Pages inherit /MediaBox and a shared Helvetica resource from /Pages. Each
 * page has at least 128 KiB of valid, mostly-comment content. Object 10 is a
 * large unreferenced stream, so an index that reads the entire file is visible
 * in coverage assertions. All offsets and /Length values count encoded bytes.
 */

import { deflateSync } from "node:zlib";

const encoder = new TextEncoder();

function ascii(text) {
  return encoder.encode(text);
}

function concatenate(parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function streamObject(content, dictionaryEntries = "") {
  return concatenate([
    ascii(`<< ${dictionaryEntries}/Length ${content.byteLength} >>\nstream\n`),
    content,
    ascii("\nendstream"),
  ]);
}

function pageContent(pageNumber, minimumBytes) {
  const colors = ["0.85 0.1 0.1", "0.1 0.65 0.2", "0.1 0.25 0.85"];
  const drawing = [
    "q",
    `${colors[pageNumber - 1]} rg`,
    `${8 + pageNumber * 4} 12 ${60 - pageNumber * 6} 48 re f`,
    "0 0 0 RG 1 w 5 5 86 86 re S",
    "0 0 0 rg",
    `BT /F1 12 Tf 8 76 Td (Page ${pageNumber}) Tj ET`,
    "Q",
    "",
  ].join("\n");
  const comment = `% Page ${pageNumber}: unused drawing-stream padding ${"x".repeat(80)}\n`;
  const repetitions = Math.max(0, Math.ceil((minimumBytes - drawing.length) / comment.length));
  return ascii(drawing + comment.repeat(repetitions));
}

/** Return a complete, valid PDF with a classic cross-reference table. */
export function makeFixturePdf({
  pageStreamBytes = 192 * 1024,
  unreachableStreamBytes = 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(pageStreamBytes) || pageStreamBytes < 128 * 1024) {
    throw new RangeError("pageStreamBytes must be an integer of at least 128 KiB");
  }
  if (!Number.isSafeInteger(unreachableStreamBytes) || unreachableStreamBytes < 0) {
    throw new RangeError("unreachableStreamBytes must be a nonnegative integer");
  }

  const objects = new Map([
    [1, ascii("<< /Type /Catalog /Pages 2 0 R >>")],
    [2, ascii("<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 /MediaBox [0 0 96 96] /Resources << /Font << /F1 9 0 R >> >> >>")],
    [3, ascii("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>")],
    [4, streamObject(pageContent(1, pageStreamBytes))],
    [5, ascii("<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>")],
    [6, streamObject(pageContent(2, pageStreamBytes))],
    [7, ascii("<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>")],
    [8, streamObject(pageContent(3, pageStreamBytes))],
    [9, ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")],
    [10, streamObject(ascii("z".repeat(unreachableStreamBytes)))],
  ]);

  const parts = [ascii("%PDF-1.4\n% Deterministic range-index test fixture\n")];
  let byteOffset = parts[0].byteLength;
  const offsets = [0];
  for (const [number, body] of objects) {
    offsets[number] = byteOffset;
    const object = concatenate([
      ascii(`${number} 0 obj\n`),
      body,
      ascii("\nendobj\n"),
    ]);
    parts.push(object);
    byteOffset += object.byteLength;
  }

  const xrefOffset = byteOffset;
  const xref = ["xref\n0 11\n0000000000 65535 f \n"];
  for (let number = 1; number <= 10; number += 1) {
    xref.push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(`trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  parts.push(ascii(xref.join("")));
  return concatenate(parts);
}

/**
 * Append a valid incremental revision with an /Info object and a /Prev chain.
 * The pages are unchanged, but startup must still find the active xref/trailer.
 */
export function makeIncrementalFixturePdf(options) {
  const original = makeFixturePdf(options);
  const originalTail = new TextDecoder().decode(original.subarray(-256));
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(originalTail);
  if (!match) throw new Error("Fixture has no terminal startxref");
  const previousXref = Number(match[1]);
  const infoObject = ascii("11 0 obj\n<< /Producer (range-index incremental fixture) >>\nendobj\n");
  const xrefOffset = original.byteLength + infoObject.byteLength;
  const trailer = ascii(
    "xref\n11 1\n" +
    `${String(original.byteLength).padStart(10, "0")} 00000 n \n` +
    `trailer\n<< /Size 12 /Root 1 0 R /Info 11 0 R /Prev ${previousXref} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  return concatenate([original, infoObject, trailer]);
}

/**
 * PDF 1.5 variant using an actual compressed /ObjStm and an /XRef stream.
 * The page-tree node, page dictionaries, inherited resources, and font are
 * compressed objects; content streams remain large and independently placed.
 */
export function makeObjectStreamFixturePdf({
  pageStreamBytes = 192 * 1024,
  unreachableStreamBytes = 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(pageStreamBytes) || pageStreamBytes < 128 * 1024) {
    throw new RangeError("pageStreamBytes must be an integer of at least 128 KiB");
  }
  if (!Number.isSafeInteger(unreachableStreamBytes) || unreachableStreamBytes < 0) {
    throw new RangeError("unreachableStreamBytes must be a nonnegative integer");
  }

  const compressedObjects = [
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 /MediaBox [0 0 96 96] /Resources 11 0 R >>"],
    [3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"],
    [5, "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>"],
    [7, "<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>"],
    [9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
    [11, "<< /Font << /F1 9 0 R >> >>"],
  ];
  let bodyLength = 0;
  const objectIndex = new Map();
  const objectHeaders = [];
  const objectBodies = [];
  for (const [number, text] of compressedObjects) {
    objectIndex.set(number, objectBodies.length);
    objectHeaders.push(`${number} ${bodyLength}`);
    const body = ascii(`${text}\n`);
    objectBodies.push(body);
    bodyLength += body.byteLength;
  }
  const objectHeader = ascii(`${objectHeaders.join(" ")}\n`);
  const objectStream = streamObject(
    deflateSync(concatenate([objectHeader, ...objectBodies])),
    `/Type /ObjStm /N ${compressedObjects.length} /First ${objectHeader.byteLength} /Filter /FlateDecode `,
  );

  const ordinaryObjects = new Map([
    [1, ascii("<< /Type /Catalog /Pages 2 0 R >>")],
    [12, objectStream],
    [4, streamObject(pageContent(1, pageStreamBytes))],
    [6, streamObject(pageContent(2, pageStreamBytes))],
    [8, streamObject(pageContent(3, pageStreamBytes))],
    [10, streamObject(ascii("z".repeat(unreachableStreamBytes)))],
  ]);
  const parts = [ascii("%PDF-1.5\n% Compressed object and cross-reference streams\n")];
  const offsets = new Map();
  let byteOffset = parts[0].byteLength;
  for (const [number, body] of ordinaryObjects) {
    offsets.set(number, byteOffset);
    const object = concatenate([
      ascii(`${number} 0 obj\n`), body, ascii("\nendobj\n"),
    ]);
    parts.push(object);
    byteOffset += object.byteLength;
  }

  const xrefOffset = byteOffset;
  offsets.set(13, xrefOffset);
  // /W [1 4 2]: entry type, byte offset or object-stream number, generation
  // or index within that object stream. Fields are unsigned, big-endian.
  const entries = new Uint8Array(14 * 7);
  const view = new DataView(entries.buffer);
  for (let number = 0; number <= 13; number += 1) {
    const position = number * 7;
    if (number === 0) {
      view.setUint8(position, 0);
      view.setUint32(position + 1, 0);
      view.setUint16(position + 5, 65535);
    } else if (objectIndex.has(number)) {
      view.setUint8(position, 2);
      view.setUint32(position + 1, 12);
      view.setUint16(position + 5, objectIndex.get(number));
    } else {
      if (!offsets.has(number)) throw new Error(`No fixture object ${number}`);
      view.setUint8(position, 1);
      view.setUint32(position + 1, offsets.get(number));
      view.setUint16(position + 5, 0);
    }
  }
  parts.push(concatenate([
    ascii("13 0 obj\n"),
    streamObject(
      deflateSync(entries),
      "/Type /XRef /Size 14 /Root 1 0 R /W [1 4 2] /Index [0 14] /Filter /FlateDecode ",
    ),
    ascii(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`),
  ]));
  return concatenate(parts);
}
