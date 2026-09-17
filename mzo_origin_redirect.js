/* Retired host: mzo-report-pwa.vercel.app → https://mzo-reports.vercel.app
   Safe on the new origin (no-op). Do not use a global vercel.json redirect. */
(function () {
  try {
    var host = String(location.hostname || '');
    if (!/(?:^|\.)mzo-report-pwa\.vercel\.app$/i.test(host)) return;
    location.replace(
      'https://mzo-reports.vercel.app' + location.pathname + location.search + location.hash
    );
  } catch (e) {}
})();
