import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const INDEX_FILE = ".upstage-cli/index/intelligence-index.json";

function indexPath(cwd) {
  return resolve(cwd, INDEX_FILE);
}

export async function loadIntelligenceIndexFromDisk(cwd) {
  try {
    const content = await readFile(indexPath(cwd), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveIntelligenceIndexToDisk(cwd, index) {
  const path = indexPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index, null, 2), "utf8");
}
