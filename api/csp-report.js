// CSP violation collector.
// Receives browser report-to / report-uri payloads, filters extension noise,
// logs to stdout (Vercel captures). Fail-open: any exception still returns 204.

const IGNORED_SOURCES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  'webkit-masked-url:',
  'about:blank'
];

function isExtensionNoise(blockedUri, sourceFile) {
  const v = String(blockedUri || '') + ' ' + String(sourceFile || '');
  return IGNORED_SOURCES.some(p => v.indexOf(p) !== -1);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  try {
    // Body can be application/csp-report, application/reports+json, or application/json
    let body = req.body;
    if (!body) body = {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = { raw: body }; } }

    // Normalize: legacy report-uri uses { 'csp-report': {...} }; Reporting API uses an array
    const reports = Array.isArray(body) ? body : [body['csp-report'] ? { type: 'csp-violation', body: body['csp-report'] } : body];

    for (const r of reports) {
      const payload = r && r.body ? r.body : r;
      const blockedUri = payload && (payload['blocked-uri'] || payload.blockedURL || payload.blockedUri);
      const sourceFile = payload && (payload['source-file'] || payload.sourceFile);
      if (isExtensionNoise(blockedUri, sourceFile)) continue;

      const summary = {
        ts: new Date().toISOString(),
        ua: (req.headers && req.headers['user-agent']) || null,
        ref: (req.headers && req.headers['referer']) || null,
        violated: payload && (payload['violated-directive'] || payload.effectiveDirective || payload.violatedDirective),
        blocked: blockedUri,
        source: sourceFile,
        doc: payload && (payload['document-uri'] || payload.documentURL),
        line: payload && (payload['line-number'] || payload.lineNumber),
        sample: payload && (payload['script-sample'] || payload.sample)
      };
      console.error('[csp-violation]', JSON.stringify(summary));
    }
  } catch (e) {
    console.error('[csp-report handler error]', e && e.message);
  }
  res.status(204).end();
};
