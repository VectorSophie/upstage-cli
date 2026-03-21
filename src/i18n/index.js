import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LANGUAGE = 'ko';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocale(localeName) {
  const localePath = path.join(__dirname, 'locales', `${localeName}.json`);
  const content = fs.readFileSync(localePath, 'utf8');
  return JSON.parse(content);
}

const LOCALES = {
  ko: loadLocale('ko'),
  en: loadLocale('en')
};

export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(LOCALES));

let language = DEFAULT_LANGUAGE;
const subscribers = new Set();

function resolveValue(obj, key) {
  if (!obj || typeof obj !== 'object' || !key) {
    return undefined;
  }
  return key.split('.').reduce((current, token) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) {
      return undefined;
    }
    return current[token];
  }, obj);
}

function interpolate(template, params) {
  if (typeof template !== 'string' || !params || typeof params !== 'object') {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, token) => {
    if (!Object.prototype.hasOwnProperty.call(params, token)) {
      return match;
    }
    const value = params[token];
    return typeof value === 'undefined' || value === null ? '' : String(value);
  });
}

export function isSupportedLanguage(nextLanguage) {
  return typeof nextLanguage === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, nextLanguage);
}

export function getLanguage() {
  return language;
}

export function setLanguage(nextLanguage) {
  if (!isSupportedLanguage(nextLanguage)) {
    return false;
  }
  if (language === nextLanguage) {
    return true;
  }
  language = nextLanguage;
  for (const notify of subscribers) {
    notify(language);
  }
  return true;
}

export function initializeLanguage(preferredLanguage) {
  if (isSupportedLanguage(preferredLanguage)) {
    setLanguage(preferredLanguage);
    return language;
  }
  setLanguage(DEFAULT_LANGUAGE);
  return language;
}

export function subscribeLanguage(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function t(key, params) {
  const activeLocale = LOCALES[language] || LOCALES[DEFAULT_LANGUAGE];
  const fallbackLocale = LOCALES.en || {};
  let template = resolveValue(activeLocale, key);
  if (typeof template === 'undefined') {
    template = resolveValue(fallbackLocale, key);
  }
  if (typeof template === 'undefined') {
    return key;
  }
  if (typeof template !== 'string') {
    return template;
  }
  return interpolate(template, params);
}
