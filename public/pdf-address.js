// SQL-friendly, versioned coordinates. Hashes identify immutable source bytes
// and the completed trace profile; page numbers follow PDF.js (1-based).
const ADDRESS = /^pdf:v1:([a-f0-9]{64}):([a-f0-9]{64}):([1-9][0-9]*)$/;
const REGION = /^pdf:region:v1:([1-9][0-9]*)$/;

export function decodePdfAddress(value) {
  const region = typeof value === 'string' && REGION.exec(value);
  if (region && region[0] === value && Number.isSafeInteger(Number(region[1]))) {
    return { regionId: Number(region[1]) };
  }
  const match = typeof value === 'string' && ADDRESS.exec(value);
  if (!match || match[0] !== value || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error('Expected pdf:v1:<document-id>:<profile-id>:<page-number> or pdf:region:v1:<region-id>');
  }
  return { documentId: match[1], profileId: match[2], pageNumber: Number(match[3]) };
}

export function encodePdfAddress({ documentId, profileId, pageNumber }) {
  const value = `pdf:v1:${documentId}:${profileId}:${pageNumber}`;
  decodePdfAddress(value);
  return value;
}
