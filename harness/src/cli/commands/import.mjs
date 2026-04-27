import { resolve } from "node:path";
import { loadSwebenchFile, writeSwebenchTasksToDir } from "../../task/loaders/swebench.mjs";
import { loadAiderPolyglotDir, writeAiderTasksToDir } from "../../task/loaders/aider-polyglot.mjs";

export async function importCommand(argv, options = {}) {
  const format = argv[0];
  const source = argv[1];
  const outDir = resolve(options["out-dir"] || options.out || `tasks/${format}`);

  if (!format) {
    console.error("Usage: harness import <swebench|aider> <source> [--out-dir tasks/]");
    console.error("  swebench  — import from SWE-bench JSONL file");
    console.error("  aider     — import from Aider polyglot exercise directory");
    process.exitCode = 1;
    return;
  }

  if (format === "swebench") {
    if (!source) {
      console.error("harness import swebench <file.jsonl>");
      process.exitCode = 1;
      return;
    }
    const absSource = resolve(source);
    console.log(`Loading SWE-bench tasks from ${absSource}...`);
    const tasks = loadSwebenchFile(absSource);
    if (tasks.length === 0) {
      console.error("No tasks found in file.");
      process.exitCode = 1;
      return;
    }
    const written = writeSwebenchTasksToDir(tasks, outDir);
    console.log(`Imported ${tasks.length} SWE-bench tasks → ${outDir}`);
    if (options.verbose) {
      for (const p of written) console.log(`  ${p}`);
    }
    return;
  }

  if (format === "aider") {
    if (!source) {
      console.error("harness import aider <exercises-dir>");
      process.exitCode = 1;
      return;
    }
    const absSource = resolve(source);
    console.log(`Loading Aider polyglot exercises from ${absSource}...`);
    const tasks = loadAiderPolyglotDir(absSource);
    if (tasks.length === 0) {
      console.error("No valid exercises found in directory.");
      process.exitCode = 1;
      return;
    }
    const written = writeAiderTasksToDir(tasks, outDir);
    console.log(`Imported ${tasks.length} Aider polyglot tasks → ${outDir}`);
    if (options.verbose) {
      for (const p of written) console.log(`  ${p}`);
    }
    return;
  }

  console.error(`Unknown format: ${format}. Supported: swebench, aider`);
  process.exitCode = 1;
}
