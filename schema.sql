PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- IDs are SHA-256 hashes of the original PDF bytes. Bytes never change in place.
CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    chunk_size INTEGER NOT NULL CHECK (chunk_size >= 1024),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

-- Together these rows contain one exact copy of the source PDF.
-- chunk n represents [n * chunk_size, min((n + 1) * chunk_size, byte_length)).
CREATE TABLE IF NOT EXISTS document_chunks (
    document_id TEXT NOT NULL REFERENCES documents ON DELETE CASCADE,
    chunk_number INTEGER NOT NULL CHECK (chunk_number >= 0),
    data BLOB NOT NULL CHECK (length(data) > 0),
    PRIMARY KEY (document_id, chunk_number)
) STRICT, WITHOUT ROWID;

-- Settings include the renderer build, runtime, fonts, annotations, layers,
-- intent and trace resolution. A different profile gets a different manifest.
CREATE TABLE IF NOT EXISTS render_profiles (
    profile_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL CHECK (json_valid(settings_json))
) STRICT;

-- A row exists only after a successful, complete cold page render.
-- Page numbers are PDF.js's 1-based page numbers.
CREATE TABLE IF NOT EXISTS page_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES render_profiles,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    page_count INTEGER NOT NULL CHECK (page_count >= page_number),
    width REAL NOT NULL CHECK (width > 0),
    height REAL NOT NULL CHECK (height > 0),
    rotation INTEGER NOT NULL,
    pixel_sha256 TEXT NOT NULL,
    observed_bytes INTEGER NOT NULL CHECK (observed_bytes > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ref TEXT GENERATED ALWAYS AS (
        'pdf:v1:' || document_id || ':' || profile_id || ':' || page_number
    ) VIRTUAL,
    UNIQUE (document_id, profile_id, page_number)
) STRICT;

-- Observed cold-load dependencies, including header/xref/catalog/page-tree
-- reads. Shared chunks have multiple references but only one stored payload.
CREATE TABLE IF NOT EXISTS page_dependencies (
    page_manifest_id INTEGER NOT NULL REFERENCES page_manifests(id) ON DELETE CASCADE,
    chunk_number INTEGER NOT NULL CHECK (chunk_number >= 0),
    PRIMARY KEY (page_manifest_id, chunk_number)
) STRICT, WITHOUT ROWID;

-- Native PDF page coordinates, always [xmin, ymin, xmax, ymax].
-- JSON keeps the same positional representation in SQL, worker messages and PDF.js.
CREATE TABLE IF NOT EXISTS page_regions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    page_manifest_id INTEGER NOT NULL REFERENCES page_manifests(id) ON DELETE CASCADE,
    bounds TEXT NOT NULL CHECK (
        json_valid(bounds) AND json_type(bounds) = 'array' AND json_array_length(bounds) = 4
        AND json_type(bounds, '$[0]') IN ('integer', 'real')
        AND json_type(bounds, '$[1]') IN ('integer', 'real')
        AND json_type(bounds, '$[2]') IN ('integer', 'real')
        AND json_type(bounds, '$[3]') IN ('integer', 'real')
        AND json_extract(bounds, '$[0]') < json_extract(bounds, '$[2]')
        AND json_extract(bounds, '$[1]') < json_extract(bounds, '$[3]')
    ),
    ref TEXT GENERATED ALWAYS AS ('pdf:region:v1:' || id) VIRTUAL
) STRICT;
CREATE INDEX IF NOT EXISTS page_regions_manifest ON page_regions(page_manifest_id);
