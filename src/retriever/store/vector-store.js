import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const VECTOR_STORE_FILE = ".upstage-cli/index/retrieval-index.json";

function storePath(cwd) {
  return resolve(cwd, VECTOR_STORE_FILE);
}

export async function loadVectorStore(cwd) {
  try {
    const content = await readFile(storePath(cwd), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveVectorStore(cwd, data) {
  const path = storePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}
