import fs from "fs";
import path from "path";
import { RawPair, ClaudeData, HTMLGenerationData } from "./types";

// Ensure UTF-8 encoding for all streams
process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

// Set locale environment for proper Unicode handling
if (!process.env.LC_ALL) {
	process.env.LC_ALL = 'C.UTF-8';
}

export class HTMLGenerator {
	private frontendDir: string;
	private templatePath: string;
	private bundlePath: string;
	private template: string;

	constructor() {
		this.frontendDir = path.join(process.cwd(), "frontend");
		this.templatePath = path.join(this.frontendDir, "template.html");
		this.bundlePath = path.join(this.frontendDir, "dist", "index.global.js");
		// Read template with explicit UTF-8 encoding
		const templateBuffer = fs.readFileSync(this.templatePath);
		// Remove BOM if present and ensure UTF-8
		this.template = templateBuffer.toString('utf8').replace(/^\uFEFF/, '');
	}

	private ensureFrontendBuilt(): void {
		if (!fs.existsSync(this.bundlePath)) {
			throw new Error(
				`Frontend bundle not found at ${this.bundlePath}. ` + `Run 'npm run build' in frontend directory first.`,
			);
		}
	}

	private loadTemplateFiles(): { htmlTemplate: string; jsBundle: string } {
		this.ensureFrontendBuilt();

		// Read files with explicit UTF-8 encoding
		const htmlTemplateBuffer = fs.readFileSync(this.templatePath);
		const jsBundleBuffer = fs.readFileSync(this.bundlePath);

		// Remove BOM if present and ensure UTF-8
		const htmlTemplate = htmlTemplateBuffer.toString('utf8').replace(/^\uFEFF/, '');
		const jsBundle = jsBundleBuffer.toString('utf8').replace(/^\uFEFF/, '');

		return { htmlTemplate, jsBundle };
	}

	private filterV1MessagesPairs(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => pair.request.url.includes("/v1/messages"));
	}

	private filterShortConversations(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => {
			const messages = pair.request?.body?.messages;
			if (!Array.isArray(messages)) return true;
			return messages.length > 2;
		});
	}

	private prepareDataForInjection(data: HTMLGenerationData): string {
		try {
			// Ensure proper UTF-8 encoding of JSON data
			const json = JSON.stringify(data, null, 2);
			
			// Normalize the string to NFC form
			const normalizedJson = json.normalize('NFC');
			
			// Convert to UTF-8 buffer and then to base64
			const buffer = Buffer.from(normalizedJson, 'utf-8');
			return buffer.toString('base64');
		} catch (error) {
			console.error('Error preparing data for injection:', error);
			throw error;
		}
	}

	private escapeHtml(text: string): string {
		if (!text) return '';
		
		// Normalize the text to NFC form first and clean artifacts
		const normalizedText = this.cleanAndNormalizeText(text);
		
		return normalizedText
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;")
			.replace(/\u2028/g, "\\u2028") // Line separator
			.replace(/\u2029/g, "\\u2029") // Paragraph separator
			.replace(/\u00A0/g, "&nbsp;") // Non-breaking space
			.replace(/\u202F/g, "&nbsp;") // Narrow non-breaking space
			.replace(/\uFEFF/g, "") // Zero-width no-break space (BOM)
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // Remove control characters
	}

	/**
	 * Clean and normalize text for proper UTF-8 handling
	 */
	private cleanAndNormalizeText(text: string): string {
		if (!text) return '';
		
		// First, handle potential encoding artifacts and normalize
		return text
			.replace(/\uFEFF/g, '') // Remove BOM
			.replace(/\uFFFD/g, '') // Remove replacement characters (encoding errors)
			.normalize('NFC'); // Normalize to canonical form
	}

	public async generateHTML(
		pairs: RawPair[],
		outputFile: string,
		options: {
			title?: string;
			timestamp?: string;
			includeAllRequests?: boolean;
		} = {},
	): Promise<void> {
		try {
			let filteredPairs = pairs;

			if (!options.includeAllRequests) {
				filteredPairs = this.filterV1MessagesPairs(pairs);
				filteredPairs = this.filterShortConversations(filteredPairs);
			}

			// Load template and bundle files
			const { htmlTemplate, jsBundle } = this.loadTemplateFiles();

			// Prepare data for injection
			const htmlData: HTMLGenerationData = {
				rawPairs: filteredPairs,
				timestamp: options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: options.includeAllRequests || false,
			};

			const dataJsonEscaped = this.prepareDataForInjection(htmlData);

			// BIZARRE BUT NECESSARY: Use split() instead of replace() for bundle injection
			const templateParts = htmlTemplate.split("__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__");
			if (templateParts.length !== 2) {
				throw new Error("Template bundle replacement marker not found or found multiple times");
			}

			// Reconstruct the template with the bundle injected between the split parts
			let htmlContent = templateParts[0] + jsBundle + templateParts[1];
			htmlContent = htmlContent
				.replace("__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__", dataJsonEscaped)
				.replace(
					"__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__",
					this.escapeHtml(options.title || `${filteredPairs.length} API Calls`),
				);

			// Ensure output directory exists
			const outputDir = path.dirname(outputFile);
			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, { recursive: true });
			}

			// Write HTML file with explicit UTF-8 encoding and flag
			fs.writeFileSync(outputFile, htmlContent, { encoding: 'utf8', flag: 'w' });
		} catch (error) {
			console.error(`Error generating HTML: ${error}`);
			throw error;
		}
	}

	public async generateHTMLFromJSONL(
		jsonlFile: string,
		outputFile?: string,
		includeAllRequests: boolean = false,
): Promise<string> {
		if (!fs.existsSync(jsonlFile)) {
			throw new Error(`File '${jsonlFile}' not found.`);
		}

		// Load all pairs from the JSONL file with explicit UTF-8 encoding
		const pairs: RawPair[] = [];
		const fileBuffer = fs.readFileSync(jsonlFile);
		// Remove BOM if present and ensure UTF-8
		const fileContent = fileBuffer.toString('utf8').replace(/^\uFEFF/, '').normalize('NFC');
		const lines = fileContent.split("\n");

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum].trim();
			if (line) {
				try {
					// Normalize line before JSON parsing
					const normalizedLine = line.normalize('NFC');
					const pair = JSON.parse(normalizedLine) as RawPair;
					pairs.push(pair);
				} catch (error) {
					console.warn(`Warning: Skipping invalid JSON on line ${lineNum + 1}: ${line.slice(0, 100)}...`);
					continue;
				}
			}
		}

		if (pairs.length === 0) {
			throw new Error(`No valid data found in '${jsonlFile}'.`);
		}

		// Determine output file
		if (!outputFile) {
			outputFile = jsonlFile.replace(/\.jsonl$/, ".html");
		}

		await this.generateHTML(pairs, outputFile, { includeAllRequests });
		return outputFile;
	}

	public getTemplatePaths(): { templatePath: string; bundlePath: string } {
		return {
			templatePath: this.templatePath,
			bundlePath: this.bundlePath,
		};
	}

	public async generate(pairs: RawPair[]): Promise<string> {
		const htmlData: HTMLGenerationData = {
			rawPairs: pairs,
			timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
			includeAllRequests: false,
		};
		const data = this.prepareDataForInjection(htmlData);
		return this.template
			.replace('__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__', `${pairs.length} API Calls`)
			.replace('__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__', data);
	}
}
