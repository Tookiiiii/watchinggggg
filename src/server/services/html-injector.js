const RESERVED_PREFIXES = new Set(['q', 'api', 'collector', 'monitor']);

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteRootRelativeAssets(html, quiz) {
  if (quiz.type !== 'directory' || !Array.isArray(quiz.rootEntries) || quiz.rootEntries.length === 0) {
    return html;
  }

  const entrySet = new Set(quiz.rootEntries);
  const mountPrefix = quiz.mountPath.replace(/\/+$/, '');

  return html.replace(
    /\b(src|href|action|poster)=(["'])\/(?!\/)([^"'#?][^"']*)\2/gi,
    (fullMatch, attr, quote, rawPath) => {
      const firstSegment = rawPath.split('/')[0];
      if (!firstSegment || RESERVED_PREFIXES.has(firstSegment.toLowerCase())) {
        return fullMatch;
      }
      if (!entrySet.has(firstSegment)) {
        return fullMatch;
      }
      return `${attr}=${quote}${mountPrefix}/${rawPath}${quote}`;
    }
  );
}

export function injectCollectorIntoHtml(html, quiz, options = {}) {
  let output = rewriteRootRelativeAssets(String(html || ''), quiz);

  if (quiz.collector?.enabled === false) {
    return output;
  }
  if (/data-watching-collector\s*=/i.test(output)) {
    return output;
  }

  const collectorUrl = options.collectorUrl || '/collector/collector.js';
  const apiEndpoint = options.apiEndpoint || '/api/records';

  const attrs = [
    `src="${escapeAttr(collectorUrl)}"`,
    'data-watching-collector="1"',
    `data-quiz-id="${escapeAttr(quiz.slug)}"`,
    `data-quiz-title="${escapeAttr(quiz.title || quiz.slug)}"`,
    `data-api-endpoint="${escapeAttr(apiEndpoint)}"`
  ];

  const collectorConfig = quiz.collector && typeof quiz.collector === 'object' ? quiz.collector : {};
  const hasCustomConfig = Object.keys(collectorConfig).some(key => key !== 'enabled');
  if (hasCustomConfig) {
    attrs.push(`data-quiz-config="${escapeAttr(JSON.stringify(collectorConfig))}"`);
  }

  const scriptTag = `<script ${attrs.join(' ')}></script>`;

  // Inject right before </head> so capture-phase listeners attach before inline body scripts run.
  if (/<\/head>/i.test(output)) {
    return output.replace(/<\/head>/i, `  ${scriptTag}\n</head>`);
  }
  if (/<body[^>]*>/i.test(output)) {
    return output.replace(/<body[^>]*>/i, match => `${match}\n${scriptTag}`);
  }
  if (/<\/body>/i.test(output)) {
    return output.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  }
  if (/<\/html>/i.test(output)) {
    return output.replace(/<\/html>/i, `${scriptTag}\n</html>`);
  }
  return `${output}\n${scriptTag}`;
}
