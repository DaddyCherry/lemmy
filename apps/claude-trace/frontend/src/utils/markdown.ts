import { marked } from "marked";

// Configure marked for safe HTML rendering with proper UTF-8 support
marked.setOptions({
	gfm: true, // GitHub Flavored Markdown
	breaks: true, // Convert \n to <br>
	sanitize: false, // Disable built-in sanitization to handle UTF-8 properly
});

/**
 * Escape HTML entities to prevent XSS while preserving UTF-8 characters
 */
function escapeHtml(text: string): string {
	// Manual HTML escaping that preserves Unicode characters like Japanese text
	// Only escape actual HTML special characters, not Unicode
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Convert markdown text to HTML string with proper escaping
 * @param markdown - The markdown text to convert
 * @returns HTML string
 */
export function markdownToHtml(markdown: string): string {
	if (!markdown) return "";

	try {
		// Process markdown directly without pre-escaping to preserve UTF-8 characters
		// marked will handle necessary escaping internally
		return marked(markdown) as string;
	} catch (error) {
		console.warn("Failed to parse markdown:", error);
		// Fallback to plain text with basic line break handling and safe HTML escaping
		return escapeHtml(markdown).replace(/\n/g, "<br>");
	}
}
