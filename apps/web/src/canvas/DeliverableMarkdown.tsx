import { useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCanvasI18n } from './i18n';

/** A display/copy reference only; recognizing a path never reads or opens a file. */
export function localFilePath(value: string, plainFile = false): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const fileUri = /^file:/i.test(value);
  let path = value;
  if (fileUri) {
    try {
      const url = new URL(value);
      path = `${url.hostname ? `//${url.hostname}` : ''}${url.pathname}`;
    } catch { return null; }
  } else if (!/^\/?[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)
    && !(plainFile && value.startsWith('/') && !value.startsWith('//'))) return null;
  // Markdown hrefs are URI encoded; a plain file field already contains its literal path.
  if (fileUri || !plainFile) {
    try { path = decodeURIComponent(path); } catch { /* Preserve literal percent characters. */ }
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.replace(/^\/(?=[a-z]:[\\/])/i, '');
}

export function LocalFileReference({ path, children }: { path: string; children?: ReactNode }) {
  const { t } = useCanvasI18n();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, maxWidth: '100%', verticalAlign: 'top' }}>
    {children ? <span>{children}</span> : null}
    <code style={{ userSelect: 'text', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{path}</code>
    <button type="button" aria-label={t('deliverable.copyPath', { path })} style={{ alignSelf: 'flex-start' }} onClick={() => { void copyPath(); }}>{t('deliverable.copyPathButton')}</button>
    {copyState === 'copied' ? <span role="status">{t('deliverable.copied')}</span> : null}
    {copyState === 'failed' ? <span role="alert">{t('deliverable.copyFailed')}</span> : null}
  </span>;
}

/** Only these leave the page, in a new tab. A link without a scheme names something where the agent
 * worked (artifacts/report.md, #notes), never a page of this site. */
export const opensApart = (href?: string | null) => Boolean(href && /^(?:https?|mailto):/i.test(href));

const deliveryUrlTransform: UrlTransform = (url, key, node) =>
  // Only anchor paths reach our non-link renderer; images and every other URL keep sanitization.
  key === 'href' && node.tagName === 'a' && localFilePath(url) ? url : defaultUrlTransform(url);
const deliveryMarkdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const path = href ? localFilePath(href) : null;
    if (path) return <LocalFileReference key={path} path={path}>{children}</LocalFileReference>;
    // Anything else keeps its text and shows where it pointed.
    if (!opensApart(href)) return <span title={href || undefined}>{children}</span>;
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  // Untrusted Markdown must not make credentialed image requests from the workbench origin.
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
};

/** Delivered Markdown, inert: images become their alt text, links open apart, local paths are copy-only
 * and a relative link stays text. Upstream deliveries shown as a node's inputs render the same way. */
export function DeliverableMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={deliveryUrlTransform} components={deliveryMarkdownComponents}>{children}</ReactMarkdown>;
}
