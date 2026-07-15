import { Directory, File, Paths } from "expo-file-system";
import * as LegacyFs from "expo-file-system/legacy";

export type EnumeratedFile = {
  uri: string;
  name: string;
  relPath: string;
  size: number;
};

export type EnumerateOptions = {
  maxFiles: number;
};

export class FolderTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Folder exceeds the ${limit}-file limit.`);
    this.name = "FolderTooLargeError";
    this.limit = limit;
  }
}

const SKIP_NAMES = new Set(["node_modules", "__pycache__"]);

function shouldSkip(name: string): boolean {
  if (!name) return true;
  if (name.startsWith(".")) return true;
  if (SKIP_NAMES.has(name)) return true;
  return false;
}

// Android SAF child URIs look like:
//   content://...documents/document/primary%3ADocuments%2FProject%2Fnotes.md
// `Paths.basename` only splits on URI-level `/`, so it returns the entire
// percent-encoded document ID. Decode that, then take the last `/`-segment
// of the storage path (after the `:` separating tree root from doc path).
// Note: expo-file-system's Kotlin `listAsRecords` appends a trailing `/`
// to every child URI including files; strip that first or the leaf comes
// back empty.
function leafName(uri: string): string {
  const stripped = uri.replace(/\/+$/, "");
  const lastSlash = stripped.lastIndexOf("/");
  let tail = lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
  try {
    tail = decodeURIComponent(tail);
  } catch {
    /* keep raw tail */
  }
  const parts = tail.split("/").filter(Boolean);
  return parts[parts.length - 1] || "file";
}

// The declared `Directory.pickDirectoryAsync` return type in
// expo-file-system's `.d.ts` and the runtime augmented `Directory` class
// drift slightly on getter-only properties (`name`, `parentDirectory`).
// Use the inferred return type so the type checker stays out of the way.
type PickedDirectory = Awaited<ReturnType<typeof Directory.pickDirectoryAsync>>;

export async function pickFolder(): Promise<PickedDirectory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (err: unknown) {
    const msg = String((err as Error)?.message || err).toLowerCase();
    if (msg.includes("cancel")) return null;
    throw err;
  }
}

export async function enumerateFolder(
  root: PickedDirectory,
  opts: EnumerateOptions,
): Promise<EnumeratedFile[]> {
  const out: EnumeratedFile[] = [];
  await walk(root, "", out, opts);
  return out;
}

async function walk(
  dir: PickedDirectory,
  relPrefix: string,
  out: EnumeratedFile[],
  opts: EnumerateOptions,
): Promise<void> {
  const children = dir.list();
  for (const child of children) {
    const name = leafName(child.uri);
    if (shouldSkip(name)) continue;
    const relPath = relPrefix ? `${relPrefix}/${name}` : name;
    if (child instanceof File) {
      if (out.length >= opts.maxFiles) throw new FolderTooLargeError(opts.maxFiles);
      const cachePath = await materializeToCache(child, name);
      out.push({
        uri: cachePath,
        name,
        relPath,
        size: typeof child.size === "number" ? child.size : 0,
      });
    } else {
      await walk(child as PickedDirectory, relPath, out, opts);
    }
  }
}

// Engine reads via bare-fs which needs real file:// paths. SAF content://
// URIs (Android) and iOS security-scoped file:// URIs both stream cleanly
// via the legacy `copyAsync`, which IOUtils.copy's the input stream to the
// destination file. The new File API's `bytes()` / `open()` paths both go
// through `javaFile` and OOM on media-sized SAF sources.
async function materializeToCache(source: File, leafFileName: string): Promise<string> {
  const stamp = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dest = new File(Paths.cache, `peardrop-folder-${stamp}_${leafFileName}`);
  await LegacyFs.copyAsync({ from: source.uri, to: dest.uri });
  return dest.uri;
}
