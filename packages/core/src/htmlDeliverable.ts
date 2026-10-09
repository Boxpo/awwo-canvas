/** Strip only a complete HTML fence; preserve every byte of the document inside it. */
export function htmlDocumentSource(value: string): string {
  const fenced = value.trim().match(/^```html[\t ]*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? fenced[1] : value;
}

/**
 * Require an explicit HTML document, not a path, prose, fragment, or an example in a comment.
 * This is a document-shape gate, not a browser conformance validator. No DOM is constructed:
 * untrusted script, image, and iframe content must not execute or load during validation.
 */
export function isCompleteHtmlDocument(value: string): boolean {
  const source = htmlDocumentSource(value).trim().replace(/^\uFEFF/, '');
  if (!source || source.includes('\u0000')) return false;
  let remaining = source;
  type Phase = 'before' | 'html' | 'head' | 'after-head' | 'body' | 'after-body' | 'done';
  let phase: Phase = 'before';
  let doctype = false;
  while (remaining) {
    const textEnd = remaining.indexOf('<');
    const text = textEnd < 0 ? remaining : remaining.slice(0, textEnd);
    if (text.trim() && phase !== 'head' && phase !== 'body') return false;
    if (textEnd < 0) return phase === 'done';
    remaining = remaining.slice(textEnd);
    const comment = remaining.match(/^<!--[\s\S]*?-->/);
    if (comment) { remaining = remaining.slice(comment[0].length); continue; }
    const declaration = remaining.match(/^<!doctype\s+html\s*>/i);
    if (declaration) {
      if (phase !== 'before' || doctype) return false;
      doctype = true;
      remaining = remaining.slice(declaration[0].length);
      continue;
    }
    // Quoted attributes may contain angle brackets. They are never interpreted as structure.
    const tag = remaining.match(/^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/i);
    if (!tag) return false;
    const [whole, closing, rawName] = tag;
    const name = rawName.toLowerCase();
    remaining = remaining.slice(whole.length);
    if (name === 'html' || name === 'head' || name === 'body') {
      if (/\/\s*>$/.test(whole)) return false;
      const transition: string = `${phase}:${closing ? '/' : ''}${name}`;
      const next: Record<string, Phase> = {
        'before:html': 'html', 'html:head': 'head', 'head:/head': 'after-head',
        'after-head:body': 'body', 'body:/body': 'after-body', 'after-body:/html': 'done',
      };
      if (!Object.hasOwn(next, transition)) return false;
      phase = next[transition];
      continue;
    }
    if (phase !== 'head' && phase !== 'body') return false;
    if (!closing && /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/.test(name)) {
      // These elements can contain tag-like strings that must not satisfy the document gate.
      const end = remaining.match(new RegExp(`</${name}\\s*>`, 'i'));
      if (!end || end.index === undefined) return false;
      remaining = remaining.slice(end.index + end[0].length);
    }
  }
  return phase === 'done';
}

export const MAX_ARTIFACT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** No capabilities are granted by the iframe sandbox. CSP also prevents even CSS/image requests. */
export const ARTIFACT_PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

/** Inline scripts are an explicit opt-in, inside an opaque-origin sandbox. This limits
 * resources and capability access, but is not a guarantee against frame self-navigation. */
export const ARTIFACT_INTERACTIVE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

const PREVIEW_ELEMENTS = new Set(('a abbr address article aside b bdi bdo blockquote br button caption circle cite code col colgroup dd defs del details dfn div dl dt ellipse em fieldset figcaption figure footer form g h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label legend li line main mark meter nav ol optgroup option p path pattern polygon polyline pre progress q rect s samp section select small span strong style sub summary sup svg table tbody td text textarea tfoot th thead time tr tspan u ul use var wbr').split(' '));
const PREVIEW_ATTRIBUTES = new Set(('class id style title role lang dir alt width height colspan rowspan scope value placeholder type checked disabled selected multiple min max step rows cols size open name for viewbox d fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity clip-rule cx cy r rx ry x x1 x2 y y1 y2 points transform xmlns preserveaspectratio').split(' '));

function filterPreviewAttributes(element: Element, interactive = false): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim();
    const fragment = (name === 'href' || name === 'xlink:href') && /^#[a-zA-Z0-9_-]+$/.test(value);
    const image = name === 'src' && element.localName === 'img'
      && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value);
    const scriptAttribute = interactive && (/^on[a-z]+$/.test(name) || /^data-[a-z0-9_.:-]+$/.test(name) || name === 'tabindex');
    if (!PREVIEW_ATTRIBUTES.has(name) && !/^aria-[a-z-]+$/.test(name) && !fragment && !image && !scriptAttribute) {
      element.removeAttribute(attribute.name);
    }
  }
  // Controls may be displayed, but never submit or navigate from the preview.
  if (element.localName === 'button') element.setAttribute('type', 'button');
  if (element.localName === 'input' && /^(submit|image)$/i.test(element.getAttribute('type') || '')) {
    element.setAttribute('type', 'button');
  }
}

/** Preserve common root styling that HTML fragment parsing would otherwise discard. */
function previewRootAttributes(source: string, tagName: 'html' | 'body', interactive = false): { attributes: string; deferredStyle: string } {
  const structural = source.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b(?:[^<>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi, '');
  const tag = structural.match(new RegExp(`<${tagName}\\b((?:[^<>"']|"[^"]*"|'[^']*')*)>`, 'i'));
  if (!tag) return { attributes: '', deferredStyle: '' };
  const holder = document.createElement('template');
  holder.innerHTML = `<div${tag[1]}></div>`;
  const element = holder.content.firstElementChild;
  if (!element) return { attributes: '', deferredStyle: '' };
  filterPreviewAttributes(element, tagName === 'body' && interactive);
  // The root appears before the CSP meta. Apply its CSS only after CSP has been parsed so even
  // a background URL cannot start an early request; preserve body styles in their normal place.
  const deferredStyle = tagName === 'html' ? element.getAttribute('style') || '' : '';
  if (tagName === 'html') element.removeAttribute('style');
  // Serialize through the browser to escape attribute delimiters, never concatenate raw values.
  return { attributes: element.outerHTML.match(/^<div((?:[^<>"']|"[^"]*"|'[^']*')*)>/)?.[1] || '', deferredStyle };
}

/**
 * Parse in an inert template (not a live parent document), then put the sanitized result only in
 * an opaque-origin sandboxed iframe. The original bytes remain untouched for source/download.
 * Sanitization removes navigation and metadata; CSP and the empty sandbox are independent guards.
 */
export function htmlPreviewDocument(value: string, interactive = false): string {
  const source = htmlDocumentSource(value);
  if (new TextEncoder().encode(source).byteLength > MAX_ARTIFACT_PREVIEW_BYTES) throw new Error('preview_too_large');
  const template = document.createElement('template');
  template.innerHTML = source;
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    const name = element.localName.toLowerCase();
    if (!PREVIEW_ELEMENTS.has(name) && !(interactive && (name === 'canvas' || name === 'script'))) {
      element.remove();
      continue;
    }
    // Only inline script bodies survive. In particular, SVG script href/src and
    // imported module URLs do not gain authority from the source document.
    if (name === 'script') {
      if (element.hasAttribute('src') || element.hasAttribute('href') || element.hasAttribute('xlink:href')) { element.remove(); continue; }
      for (const attribute of Array.from(element.attributes)) if (attribute.name !== 'type') element.removeAttribute(attribute.name);
    } else filterPreviewAttributes(element, interactive);
  }
  const root = previewRootAttributes(source, 'html');
  const body = previewRootAttributes(source, 'body', interactive);
  // Escaping '<' in CSS prevents a model-supplied style value from closing the trusted style tag.
  const rootStyle = root.deferredStyle.replace(/</g, '\\3c ');
  return `<!doctype html><html${root.attributes}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${interactive ? ARTIFACT_INTERACTIVE_CSP : ARTIFACT_PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}body{margin:20px;color:#202828;font:14px/1.55 system-ui,sans-serif}img,svg,canvas{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{max-width:100%}html{${rootStyle}}</style></head><body${body.attributes}>${template.innerHTML}</body></html>`;
}

/** Export the verified response content. A saved file reference is never read by this helper. */
export function downloadTextDeliverable(value: string, name: string, type: 'html' | 'markdown'): void {
  const extension = type === 'html' ? 'html' : 'md';
  const basename = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\.(?:html?|md)$/i, '')
    .trim().replace(/[. ]+$/, '').slice(0, 120) || 'deliverable';
  const source = type === 'html' ? htmlDocumentSource(value) : value;
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const url = URL.createObjectURL(new Blob([source], { type: type === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `${basename}.${extension}`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => revokeObjectURL(url), 1000);
  }
}
