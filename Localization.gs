/**
 * Return all bundled localization data. Locale files contain labels, aliases,
 * and locale-specific extraction/report/profile data; processing logic stays
 * elsewhere.
 */
function getLocalizationRegistry_() {
  return Object.freeze({
    en: getEnglishLocalization_(),
    it: getItalianLocalization_()
  });
}

function getSupportedLocales_() {
  return Object.keys(getLocalizationRegistry_());
}

function getLocalization_() {
  const locale = getAutomationConfig_().locale || 'en';
  return getLocalizationRegistry_()[locale];
}

function getHeaderAliases_(headerKey) {
  return getLocalization_().headerAliases[headerKey] || [];
}
