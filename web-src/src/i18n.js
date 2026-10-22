// All text of the page comes from web/i18n/<lang>.json (fetched at run time, so a translation needs no rebuild).
// t(key, vars) falls back to English, then to the key itself.

let DICT = {}, EN = {};
export let LANG = 'en';

export const LANG_NAMES = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano', es: 'Español', ru: 'Русский' };

export function t(key, vars) {
  let s = DICT[key] != null ? DICT[key] : EN[key] != null ? EN[key] : key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

/** True when the dictionary has the key (a translation or English). */
export const has = key => DICT[key] != null || EN[key] != null;

export async function loadLang(lang) {
  const get = l => fetch(`i18n/${l}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  if (!Object.keys(EN).length) EN = await get('en');
  DICT = lang === 'en' ? EN : await get(lang);
  LANG = lang;
  document.documentElement.lang = lang;
}
