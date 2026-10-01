import { Marked } from 'marked'

const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]!))

/** Only web pages and local evidence files can become report links. */
export function reviewMarkdownHref(raw: string): string | undefined {
  try {
    if (raw.startsWith('//')) return undefined
    const url = new URL(raw.startsWith('/') ? `file://${raw}` : raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ||
      (url.protocol === 'file:' && !url.hostname && /\.(?:html?|md|txt|log|pdf|png|jpe?g|webp|csv|json)$/i.test(decodeURIComponent(url.pathname)))
      ? url.href : undefined
  } catch {
    return undefined
  }
}

// One renderer for Review and its saved page. Agent-written HTML is displayed as
// text; images become links, so opening a report cannot load remote tracking images.
const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) { return escape(text) },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens)
      const url = reviewMarkdownHref(href)
      return url ? `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''}>${label}</a>` : label
    },
    image({ href, text }) {
      const url = reviewMarkdownHref(href)
      return url ? `<a href="${escape(url)}">${escape(text || href)}</a>` : escape(text)
    }
  }
})

export function renderReviewMarkdown(text: string): string {
  return markdown.parse(text, { async: false })
}

/** Main revalidates an inline link against the saved report before opening it. */
export function reviewMarkdownLinks(text: string): Set<string> {
  const links = new Set<string>()
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type !== 'link' && token.type !== 'image') return
    const href = reviewMarkdownHref(String(token.href))
    if (href) links.add(href)
  })
  return links
}
