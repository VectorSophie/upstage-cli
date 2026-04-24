import { extname, join } from "node:path";
import * as TreeSitter from "web-tree-sitter";

const PARSERS = {
  javascript: {
    module: "tree-sitter-javascript",
    wasm: "tree-sitter-javascript.wasm",
    extensions: [".js", ".jsx", ".mjs", ".cjs"]
  },
  typescript: {
    module: "tree-sitter-typescript",
    wasm: "tree-sitter-typescript.wasm",
    extensions: [".ts"]
  },
  tsx: {
    module: "tree-sitter-typescript",
    wasm: "tree-sitter-tsx.wasm",
    extensions: [".tsx"]
  },
  python: {
    module: "tree-sitter-python",
    wasm: "tree-sitter-python.wasm",
    extensions: [".py"]
  },
  go: {
    module: "tree-sitter-go",
    wasm: "tree-sitter-go.wasm",
    extensions: [".go"]
  }
};

const CODE_EXTS = new Set(Object.values(PARSERS).flatMap(p => p.extensions));

const ParserClass =
  TreeSitter.Parser ||
  TreeSitter.default?.Parser ||
  TreeSitter.default ||
  null;
const LanguageClass =
  TreeSitter.Language ||
  TreeSitter.default?.Language ||
  ParserClass?.Language ||
  null;
const QueryClass =
  TreeSitter.Query ||
  TreeSitter.default?.Query ||
  ParserClass?.Query ||
  null;
const parserInit =
  (ParserClass && typeof ParserClass.init === "function" && ParserClass.init.bind(ParserClass)) ||
  (TreeSitter.default &&
    typeof TreeSitter.default.init === "function" &&
    TreeSitter.default.init.bind(TreeSitter.default)) ||
  (typeof TreeSitter.init === "function" && TreeSitter.init.bind(TreeSitter)) ||
  null;

let initialized = false;
let initPromise = null;
const langCache = new Map();

async function initTreeSitter() {
  if (initialized) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      if (parserInit) {
        await parserInit();
      }
      initialized = true;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
}

async function getLanguageForExtension(ext) {
  await initTreeSitter();
  const langKey = Object.keys(PARSERS).find(k => PARSERS[k].extensions.includes(ext));
  if (!langKey) return null;

  if (langCache.has(langKey)) return langCache.get(langKey);

  if (!LanguageClass || typeof LanguageClass.load !== "function") {
    return null;
  }

  const config = PARSERS[langKey];
  const wasmPath = join(process.cwd(), "node_modules", config.module, config.wasm);
  
  try {
    const lang = await LanguageClass.load(wasmPath);
    langCache.set(langKey, lang);
    return lang;
  } catch (e) {
    return null;
  }
}

function getTagsQuery(ext) {
  const langKey = Object.keys(PARSERS).find(k => PARSERS[k].extensions.includes(ext));
  if (langKey === "javascript" || langKey === "typescript" || langKey === "tsx") {
    return `
      (function_declaration name: (identifier) @name) @function
      (generator_function_declaration name: (identifier) @name) @function
      (method_definition name: (property_identifier) @name) @method
      (class_declaration name: (identifier) @name) @class
      (variable_declarator name: (identifier) @name value: (arrow_function)) @function
      (export_statement (variable_declaration (variable_declarator name: (identifier) @name))) @export
    `;
  }
  if (langKey === "python") {
    return `
      (function_definition name: (identifier) @name) @function
      (class_definition name: (identifier) @name) @class
    `;
  }
  if (langKey === "go") {
    return `
      (function_declaration name: (identifier) @name) @function
      (method_declaration name: (field_identifier) @name) @method
      (type_declaration (type_spec name: (type_identifier) @name)) @type
    `;
  }
  return null;
}

async function extractWithTreeSitter(content, relativePath, ext) {
  const lang = await getLanguageForExtension(ext);
  if (!lang) return null;

  if (typeof ParserClass !== "function") {
    return null;
  }

  const parser = new ParserClass();
  let tree = null;
  let query = null;

  try {
    parser.setLanguage(lang);
    tree = parser.parse(content);
    if (!tree) {
      return null;
    }
    const queryText = getTagsQuery(ext);
    if (!queryText) {
      return null;
    }

    if (typeof lang.query === "function") {
      query = lang.query(queryText);
    } else if (typeof QueryClass === "function") {
      query = new QueryClass(lang, queryText);
    } else {
      return null;
    }

    const captures = query.captures(tree.rootNode);

    const symbols = captures.map(cap => ({
      name: cap.node.text,
      kind: cap.name,
      file: relativePath,
      line: cap.node.startPosition.row + 1
    }));

    return {
      parser: "tree-sitter",
      symbols,
      imports: []
    };
  } catch {
    return null;
  } finally {
    query?.delete?.();
    tree?.delete?.();
    parser.delete?.();
  }
}

function extractWithRegex(content, relativePath) {
  const symbols = [];
  const imports = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const importMatch = line.match(/^\s*import\s+.*?from\s+["'](.+?)["']/);
    if (importMatch) imports.push(importMatch[1]);
    
    const fnMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) symbols.push({ name: fnMatch[1], kind: "function", file: relativePath, line: i + 1 });

    const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
    if (classMatch) symbols.push({ name: classMatch[1], kind: "class", file: relativePath, line: i + 1 });
  }

  return {
    parser: "regex",
    symbols,
    imports
  };
}

export function isCodeFile(filePath) {
  return CODE_EXTS.has(extname(filePath).toLowerCase());
}

export async function parseSourceFile({ filePath, relativePath, content }) {
  const ext = extname(filePath).toLowerCase();
  if (!isCodeFile(filePath)) {
    return { parser: "none", symbols: [], imports: [] };
  }

  const tsResult = await extractWithTreeSitter(content, relativePath, ext);
  if (tsResult) return tsResult;

  return extractWithRegex(content, relativePath);
}
