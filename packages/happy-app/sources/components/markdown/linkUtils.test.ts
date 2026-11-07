import { describe, expect, it } from 'vitest';
import { isHttpMarkdownLink, markdownSessionId } from './linkUtils';
import { parseMarkdown } from './parseMarkdown';

describe('markdownSessionId', () => {
    it('recognizes the reported execution link after Markdown parsing', () => {
        const blocks = parseMarkdown('[查看执行会话](/session/cmw67h8ad1y52ms1d4vbyp01l)');
        expect(blocks).toEqual([{ type: 'text', content: [{ styles: [], text: '查看执行会话', url: '/session/cmw67h8ad1y52ms1d4vbyp01l' }] }]);
        expect(markdownSessionId('/session/cmw67h8ad1y52ms1d4vbyp01l')).toBe('cmw67h8ad1y52ms1d4vbyp01l');
    });

    it.each([
        '/session/', '/session/../dots', '/session/a/file', '/session/a?redirect=https://evil.test',
        '/session/a#fragment', '//evil.test/session/a', 'https://evil.test/session/a',
        '/happy/session/a', '/session/%2f%2fevil.test', '/session/a\\b', '/session/a\n',
        ' /session/a', '/Users/me/file.ts', 'javascript:alert(1)', 'data:text/html,test',
    ])('rejects targets outside the exact session route: %j', target => {
        expect(markdownSessionId(target)).toBeNull();
    });
});

describe('isHttpMarkdownLink', () => {
    it('accepts http and https links', () => {
        expect(isHttpMarkdownLink('http://example.com')).toBe(true);
        expect(isHttpMarkdownLink('https://example.com/docs')).toBe(true);
        expect(isHttpMarkdownLink(' HTTPS://example.com/docs ')).toBe(true);
    });

    it('rejects non-http schemes and path-like targets', () => {
        expect(isHttpMarkdownLink('mailto:test@example.com')).toBe(false);
        expect(isHttpMarkdownLink('data:text/plain,hello')).toBe(false);
        expect(isHttpMarkdownLink('/Users/me/project/file.ts')).toBe(false);
        expect(isHttpMarkdownLink('packages/happy-app/index.tsx')).toBe(false);
    });
});
