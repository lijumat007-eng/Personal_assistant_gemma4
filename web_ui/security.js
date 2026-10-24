// Only text formatting and safe hyperlinks are permitted in chat Markdown.
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function renderSafeMarkdown(text) {
    const template = document.createElement('template');
    template.innerHTML = marked.parse(String(text ?? ''));
    const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE',
        'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
    for (const node of [...template.content.querySelectorAll('*')]) {
        if (!allowed.has(node.tagName)) {
            node.replaceWith(document.createTextNode(node.textContent || ''));
            continue;
        }
        const href = node.tagName === 'A' ? node.getAttribute('href') : null;
        for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
        if (href) {
            try {
                const url = new URL(href, window.location.origin);
                if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
                    node.setAttribute('href', url.href);
                    node.setAttribute('rel', 'noopener noreferrer');
                }
            } catch (_) { /* Invalid links remain plain text. */ }
        }
    }
    return template.innerHTML;
}
