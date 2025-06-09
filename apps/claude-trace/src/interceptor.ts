import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { RawPair } from "./types";
import { HTMLGenerator } from "./html-generator";

export interface InterceptorConfig {
	logDirectory?: string;
	enableRealTimeHTML?: boolean;
	logLevel?: "debug" | "info" | "warn" | "error";
}

export class ClaudeTrafficLogger {
	private logDir: string;
	private logFile: string;
	private htmlFile: string;
	private pendingRequests: Map<string, any> = new Map();
	private pairs: RawPair[] = [];
	private config: InterceptorConfig;
	private htmlGenerator: HTMLGenerator;

	constructor(config: InterceptorConfig = {}) {
		this.config = {
			logDirectory: ".claude-trace",
			enableRealTimeHTML: true,
			logLevel: "info",
			...config,
		};

		// Create log directory if it doesn't exist
		this.logDir = this.config.logDirectory!;
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}

		// Generate timestamped filenames
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5); // Remove milliseconds and Z

		this.logFile = path.join(this.logDir, `log-${timestamp}.jsonl`);
		this.htmlFile = path.join(this.logDir, `log-${timestamp}.html`);

		// Initialize HTML generator
		this.htmlGenerator = new HTMLGenerator();

		// Clear log file with explicit UTF-8 encoding
		fs.writeFileSync(this.logFile, "", { encoding: 'utf8' });
	}

	private isAnthropicAPI(url: string | URL): boolean {
		const urlString = typeof url === "string" ? url : url.toString();
		const includeAllRequests = process.env.CLAUDE_TRACE_INCLUDE_ALL_REQUESTS === "true";

		if (includeAllRequests) {
			return urlString.includes("api.anthropic.com"); // Capture all Anthropic API requests
		}

		return urlString.includes("api.anthropic.com") && urlString.includes("/v1/messages");
	}

	private generateRequestId(): string {
		return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
	}

	private redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
		const redactedHeaders = { ...headers };
		const sensitiveKeys = [
			"authorization",
			"x-api-key",
			"x-auth-token",
			"cookie",
			"set-cookie",
			"x-session-token",
			"x-access-token",
			"bearer",
			"proxy-authorization",
		];

		for (const key of Object.keys(redactedHeaders)) {
			const lowerKey = key.toLowerCase();
			if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
				// Keep first 10 chars and last 4 chars, redact middle
				const value = redactedHeaders[key];
				if (value && value.length > 14) {
					redactedHeaders[key] = `${value.substring(0, 10)}...${value.slice(-4)}`;
				} else if (value && value.length > 4) {
					redactedHeaders[key] = `${value.substring(0, 2)}...${value.slice(-2)}`;
				} else {
					redactedHeaders[key] = "[REDACTED]";
				}
			}
		}

		return redactedHeaders;
	}

	private async cloneResponse(response: Response): Promise<Response> {
		// Clone the response to avoid consuming the body
		return response.clone();
	}

	private async parseRequestBody(body: any): Promise<any> {
		if (!body) return null;

		if (typeof body === "string") {
			try {
				return JSON.parse(body);
			} catch {
				return body;
			}
		}

		if (body instanceof FormData) {
			const formObject: Record<string, any> = {};
			// TypeScript doesn't have FormData.entries() in some environments
			// @ts-ignore
			if (body.entries) {
				// @ts-ignore
				for (const [key, value] of body.entries()) {
					formObject[key] = value;
				}
			}
			return formObject;
		}

		return body;
	}

	private async parseResponseBody(response: Response): Promise<{ body?: any; body_raw?: string }> {
		const contentType = response.headers.get("content-type") || "";

		try {
			if (contentType.includes("application/json")) {
				const body = await response.json();
				return { body };
			} else if (contentType.includes("text/event-stream")) {
				const buffer = await response.arrayBuffer();
				const decoder = new TextDecoder('utf-8');
				const body_raw = decoder.decode(buffer);
				return { body_raw };
			} else if (contentType.includes("text/")) {
				const buffer = await response.arrayBuffer();
				const decoder = new TextDecoder('utf-8');
				const body_raw = decoder.decode(buffer);
				return { body_raw };
			} else {
				// For other types, try to read as text with UTF-8 encoding
				const buffer = await response.arrayBuffer();
				const decoder = new TextDecoder('utf-8');
				const body_raw = decoder.decode(buffer);
				return { body_raw };
			}
		} catch (error) {
			// Silent error handling during runtime
			return {};
		}
	}

	private async parseResponseBodyFromString(
		body: string,
		contentType?: string,
	): Promise<{ body?: any; body_raw?: string }> {
		try {
			if (contentType && contentType.includes("application/json")) {
				return { body: JSON.parse(body) };
			} else {
				// For all other types, return the raw body with UTF-8 encoding
				const buffer = Buffer.from(body, 'utf-8');
				const decoder = new TextDecoder('utf-8');
				const body_raw = decoder.decode(buffer);
				return { body_raw };
			}
		} catch (error) {
			// Silent error handling during runtime
			return {};
		}
	}

	public instrumentAll(): void {
		this.instrumentFetch();
		this.instrumentNodeHTTP();
	}

	public instrumentFetch(): void {
		if (!global.fetch) {
			// Silent - fetch not available
			return;
		}

		// Check if already instrumented by checking for our marker
		if ((global.fetch as any).__claudeTraceInstrumented) {
			return;
		}

		const originalFetch = global.fetch;
		const logger = this;

		global.fetch = async function (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
			// Convert input to URL for consistency
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			// Only intercept Anthropic API calls
			if (!logger.isAnthropicAPI(url)) {
				return originalFetch(input, init);
			}

			const requestId = logger.generateRequestId();
			const requestTimestamp = Date.now();

			// Capture request details
			const requestData = {
				timestamp: requestTimestamp / 1000, // Convert to seconds (like Python version)
				method: init.method || "GET",
				url: url,
				headers: logger.redactSensitiveHeaders(Object.fromEntries(Array.from(new Headers(init.headers || {}) as any))),
				body: await logger.parseRequestBody(init.body),
			};

			// Store pending request
			logger.pendingRequests.set(requestId, requestData);

			try {
				// Make the actual request
				const response = await originalFetch(input, init);
				const responseTimestamp = Date.now();

				// Clone response to avoid consuming the body
				const clonedResponse = await logger.cloneResponse(response);

				// Parse response body
				const responseBodyData = await logger.parseResponseBody(clonedResponse);

				// Create response data
				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: response.status,
					headers: logger.redactSensitiveHeaders(Object.fromEntries(Array.from(response.headers as any))),
					...responseBodyData,
				};

				// Create paired request-response object
				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				// Remove from pending and add to pairs
				logger.pendingRequests.delete(requestId);
				logger.pairs.push(pair);

				// Write to log file
				await logger.writePairToLog(pair);

				// Generate HTML if enabled
				if (logger.config.enableRealTimeHTML) {
					await logger.generateHTML();
				}

				return response;
			} catch (error) {
				// Remove from pending requests on error
				logger.pendingRequests.delete(requestId);
				throw error;
			}
		};

		// Mark fetch as instrumented
		(global.fetch as any).__claudeTraceInstrumented = true;

		// Silent initialization
	}

	public instrumentNodeHTTP(): void {
		try {
			const http = require("http");
			const https = require("https");
			const logger = this;

			// Instrument http.request
			if (http.request && !(http.request as any).__claudeTraceInstrumented) {
				const originalHttpRequest = http.request;
				http.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpRequest, options, callback, false);
				};
				(http.request as any).__claudeTraceInstrumented = true;
			}

			// Instrument http.get
			if (http.get && !(http.get as any).__claudeTraceInstrumented) {
				const originalHttpGet = http.get;
				http.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpGet, options, callback, false);
				};
				(http.get as any).__claudeTraceInstrumented = true;
			}

			// Instrument https.request
			if (https.request && !(https.request as any).__claudeTraceInstrumented) {
				const originalHttpsRequest = https.request;
				https.request = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsRequest, options, callback, true);
				};
				(https.request as any).__claudeTraceInstrumented = true;
			}

			// Instrument https.get
			if (https.get && !(https.get as any).__claudeTraceInstrumented) {
				const originalHttpsGet = https.get;
				https.get = function (options: any, callback?: any) {
					return logger.interceptNodeRequest(originalHttpsGet, options, callback, true);
				};
				(https.get as any).__claudeTraceInstrumented = true;
			}
		} catch (error) {
			// Silent error handling
		}
	}

	private interceptNodeRequest(originalRequest: any, options: any, callback: any, isHttps: boolean) {
		// Parse URL from options
		const url = this.parseNodeRequestURL(options, isHttps);

		if (!this.isAnthropicAPI(url)) {
			return originalRequest.call(this, options, callback);
		}

		const requestId = this.generateRequestId();
		const requestTimestamp = Date.now();
		let requestBodyChunks: Buffer[] = [];

		// Create the request
		const req = originalRequest.call(this, options, (res: any) => {
			const responseTimestamp = Date.now();
			let responseBodyChunks: Buffer[] = [];

			// Capture response data as buffers to handle UTF-8 properly
			res.on("data", (chunk: any) => {
				responseBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});

			res.on("end", async () => {
				// Concatenate all chunks and decode as UTF-8
				const requestBodyBuffer = Buffer.concat(requestBodyChunks);
				const responseBodyBuffer = Buffer.concat(responseBodyChunks);
				
				const requestBody = requestBodyBuffer.length > 0 ? requestBodyBuffer.toString('utf8') : "";
				const responseBody = responseBodyBuffer.length > 0 ? responseBodyBuffer.toString('utf8') : "";
				// Process the captured request/response
				const requestData = {
					timestamp: requestTimestamp / 1000,
					method: options.method || "GET",
					url: url,
					headers: this.redactSensitiveHeaders(options.headers || {}),
					body: requestBody ? await this.parseRequestBody(requestBody) : null,
				};

				const responseData = {
					timestamp: responseTimestamp / 1000,
					status_code: res.statusCode,
					headers: this.redactSensitiveHeaders(res.headers || {}),
					...(await this.parseResponseBodyFromString(responseBody, res.headers["content-type"])),
				};

				const pair: RawPair = {
					request: requestData,
					response: responseData,
					logged_at: new Date().toISOString(),
				};

				this.pairs.push(pair);
				await this.writePairToLog(pair);

				if (this.config.enableRealTimeHTML) {
					await this.generateHTML();
				}
			});

			// Call original callback if provided
			if (callback) {
				callback(res);
			}
		});

		// Capture request body as buffers to handle UTF-8 properly
		const originalWrite = req.write;
		req.write = function (chunk: any) {
			if (chunk) {
				requestBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return originalWrite.call(this, chunk);
		};

		return req;
	}

	private parseNodeRequestURL(options: any, isHttps: boolean): string {
		if (typeof options === "string") {
			return options;
		}

		const protocol = isHttps ? "https:" : "http:";
		const hostname = options.hostname || options.host || "localhost";
		const port = options.port ? `:${options.port}` : "";
		const path = options.path || "/";

		return `${protocol}//${hostname}${port}${path}`;
	}

	private async writePairToLog(pair: RawPair): Promise<void> {
		// Ensure proper UTF-8 encoding when writing to log
		const normalizedPair = this.normalizeObjectForUTF8(pair);
		const line = JSON.stringify(normalizedPair) + "\n";
		await fs.promises.appendFile(this.logFile, line, { encoding: 'utf8' });
	}

	/**
	 * Recursively normalize strings in an object to ensure proper UTF-8 encoding
	 */
	private normalizeObjectForUTF8(obj: any): any {
		if (typeof obj === 'string') {
			return this.cleanAndNormalizeText(obj);
		} else if (Array.isArray(obj)) {
			return obj.map(item => this.normalizeObjectForUTF8(item));
		} else if (obj !== null && typeof obj === 'object') {
			const normalized: any = {};
			for (const [key, value] of Object.entries(obj)) {
				normalized[key] = this.normalizeObjectForUTF8(value);
			}
			return normalized;
		}
		return obj;
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
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // Remove control characters
			.normalize('NFC'); // Normalize to canonical form
	}

	private async generateHTML(): Promise<void> {
		const html = await this.htmlGenerator.generate(this.pairs);
		await fs.promises.writeFile(this.htmlFile, html, { encoding: 'utf8' });
	}

	public cleanup(): void {
		console.log("Cleaning up orphaned requests...");

		for (const [, requestData] of this.pendingRequests.entries()) {
			const orphanedPair = {
				request: requestData,
				response: null,
				note: "ORPHANED_REQUEST - No matching response received",
				logged_at: new Date().toISOString(),
			};

			try {
				const normalizedOrphanedPair = this.normalizeObjectForUTF8(orphanedPair);
				const jsonLine = JSON.stringify(normalizedOrphanedPair) + "\n";
				fs.appendFileSync(this.logFile, jsonLine, { encoding: 'utf8' });
			} catch (error) {
				console.log(`Error writing orphaned request: ${error}`);
			}
		}

		this.pendingRequests.clear();
		console.log(`Cleanup complete. Logged ${this.pairs.length} pairs`);

		// Open browser if requested
		const shouldOpenBrowser = process.env.CLAUDE_TRACE_OPEN_BROWSER === "true";
		if (shouldOpenBrowser && fs.existsSync(this.htmlFile)) {
			try {
				spawn("open", [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
				console.log(`🌐 Opening ${this.htmlFile} in browser`);
			} catch (error) {
				console.log(`❌ Failed to open browser: ${error}`);
			}
		}
	}

	public getStats() {
		return {
			totalPairs: this.pairs.length,
			pendingRequests: this.pendingRequests.size,
			logFile: this.logFile,
			htmlFile: this.htmlFile,
		};
	}
}

// Global logger instance
let globalLogger: ClaudeTrafficLogger | null = null;

// Track if event listeners have been set up
let eventListenersSetup = false;

export function initializeInterceptor(config?: InterceptorConfig): ClaudeTrafficLogger {
	if (globalLogger) {
		console.warn("Interceptor already initialized");
		return globalLogger;
	}

	globalLogger = new ClaudeTrafficLogger(config);
	globalLogger.instrumentAll();

	// Setup cleanup on process exit only once
	if (!eventListenersSetup) {
		const cleanup = () => {
			if (globalLogger) {
				globalLogger.cleanup();
			}
		};

		process.on("exit", cleanup);
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		process.on("uncaughtException", (error) => {
			console.error("Uncaught exception:", error);
			cleanup();
			process.exit(1);
		});

		eventListenersSetup = true;
	}

	return globalLogger;
}

export function getLogger(): ClaudeTrafficLogger | null {
	return globalLogger;
}
