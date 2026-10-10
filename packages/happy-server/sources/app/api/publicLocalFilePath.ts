import * as path from "node:path";

/** Private session/project files are served only by their authenticated routes. */
export function publicLocalFilePath(baseDir: string, requestedPath: string): string | null {
  const root = path.resolve(baseDir);
  const fullPath = path.resolve(root, requestedPath);
  if (!fullPath.startsWith(root + path.sep)) return null;
  const parts = path.relative(root, fullPath).split(path.sep);
  if (parts[0] === "sessions" || parts[0] === "projects") return null;
  return fullPath;
}
