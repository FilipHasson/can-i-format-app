import { DatabaseSync } from "node:sqlite";

/**
 * Builds a Lightroom catalog, for testing the catalog reader.
 *
 * Only the tables and columns the reader actually joins, with the same names
 * and the same shapes Lightroom uses — including the parts that are easy to
 * get wrong from documentation alone: `captureTime` is an ISO-ish local wall
 * clock, `absolutePath` ends with a separator, and camera model and serial are
 * interned in their own tables and referenced by id.
 */

export interface CatalogFile {
  /** Folder path relative to the root, ending in "/" as Lightroom stores it. */
  pathFromRoot: string;
  baseName: string;
  extension: string;
  /** The camera's filename at import, which survives a convert-to-DNG. */
  originalFilename?: string;
  /** "2024-05-01T09:10:00" — naive, no zone. */
  captureTime?: string;
  cameraModel?: string;
  cameraSerial?: string;
  md5?: string;
}

export interface CatalogSpec {
  /** The library root on disk, as Lightroom records it. */
  rootPath: string;
  files: CatalogFile[];
}

export function writeCatalog(file: string, spec: CatalogSpec): void {
  const db = new DatabaseSync(file);

  db.exec(`
    CREATE TABLE AgLibraryRootFolder (
      id_local INTEGER PRIMARY KEY, absolutePath TEXT, name TEXT
    );
    CREATE TABLE AgLibraryFolder (
      id_local INTEGER PRIMARY KEY, rootFolder INTEGER, pathFromRoot TEXT
    );
    CREATE TABLE AgLibraryFile (
      id_local INTEGER PRIMARY KEY, folder INTEGER, baseName TEXT,
      extension TEXT, originalFilename TEXT, md5 TEXT
    );
    CREATE TABLE Adobe_images (
      id_local INTEGER PRIMARY KEY, rootFile INTEGER, captureTime TEXT, fileFormat TEXT
    );
    CREATE TABLE AgHarvestedExifMetadata (
      id_local INTEGER PRIMARY KEY, image INTEGER, cameraModelRef INTEGER, cameraSNRef INTEGER
    );
    CREATE TABLE AgInternedExifCameraModel (id_local INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE AgInternedExifCameraSN (id_local INTEGER PRIMARY KEY, value TEXT);
  `);

  // Lightroom stores the root with a trailing separator.
  const root = spec.rootPath.endsWith("/") ? spec.rootPath : `${spec.rootPath}/`;
  db.prepare("INSERT INTO AgLibraryRootFolder VALUES (?, ?, ?)").run(1, root, "Library");

  const folders = new Map<string, number>();
  const models = new Map<string, number>();
  const serials = new Map<string, number>();

  const intern = (
    table: string,
    cache: Map<string, number>,
    value: string | undefined,
  ): number | null => {
    if (!value) return null;
    const existing = cache.get(value);
    if (existing !== undefined) return existing;
    const id = cache.size + 1;
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(id, value);
    cache.set(value, id);
    return id;
  };

  // One transaction, or every row is its own sync to disk: a catalog of a
  // few thousand files took most of a minute to write.
  db.exec("BEGIN");
  for (const [i, entry] of spec.files.entries()) {
    const id = i + 1;

    let folderId = folders.get(entry.pathFromRoot);
    if (folderId === undefined) {
      folderId = folders.size + 1;
      db.prepare("INSERT INTO AgLibraryFolder VALUES (?, ?, ?)").run(folderId, 1, entry.pathFromRoot);
      folders.set(entry.pathFromRoot, folderId);
    }

    db.prepare("INSERT INTO AgLibraryFile VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      folderId,
      entry.baseName,
      entry.extension,
      entry.originalFilename ?? `${entry.baseName}.${entry.extension}`,
      entry.md5 ?? null,
    );
    db.prepare("INSERT INTO Adobe_images VALUES (?, ?, ?, ?)").run(
      id,
      id,
      entry.captureTime ?? null,
      entry.extension.toUpperCase(),
    );
    db.prepare("INSERT INTO AgHarvestedExifMetadata VALUES (?, ?, ?, ?)").run(
      id,
      id,
      intern("AgInternedExifCameraModel", models, entry.cameraModel),
      intern("AgInternedExifCameraSN", serials, entry.cameraSerial),
    );
  }
  db.exec("COMMIT");

  db.close();
}
