export function stampClientRelease(patch, index, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid release revision');
  if (!patch.includes('installSiteUpdates({revision:') || !/polytrack_062_patch\.js\?v=\d+/.test(index)) {
    throw new Error('Release anchors are missing. No files were changed.');
  }
  patch = patch.replace(/installSiteUpdates\(\{revision:\d+/, `installSiteUpdates({revision:${revision}`)
    .replace(/(filter-(?:runtime|menu|groups)\.(?:mjs|css)|site-updates\.mjs)\?v=\d+/g, `$1?v=${revision}`)
    .replace(/(events\/client\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(tools\/(?:public-snapshot-client|record-placement|snapshot-metadata-recovery|ranked-live-snapshot|practice-history|practice-native|developer-diagnostics|practice-profile|local-insights)\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(kodub-weekly\.mjs)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(const extraCatalogRevision=)['"]\d+['"]/, `$1'${revision}'`);
  patch = patch.replace(/createLocalInsights\(\{storage,revision:\d+\}\)/g, `createLocalInsights({storage,revision:${revision}})`);
  index = index.replace(/polytrack_062_patch\.js\?v=\d+/, `polytrack_062_patch.js?v=${revision}`)
    .replace(/(main\.bundle\.js)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(public-name-policy\.js)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(home-ui\.css)(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`)
    .replace(/(events\/(?:events\.css|client\.mjs))(?:\?v=\d+)?(['"])/g, `$1?v=${revision}$2`);
  return {patch, index};
}
