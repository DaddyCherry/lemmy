#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { HTMLGenerator } from "./html-generator";

// Colors for output
export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
	console.log(`
${colors.blue}Claude Trace${colors.reset}
Record all your interactions with Claude Code as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  claude-trace [OPTIONS] [COMMAND]

${colors.yellow}OPTIONS:${colors.reset}
  --extract-token    Extract OAuth token and exit (reproduces claude-token.py)
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .claude-trace/ directory
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    claude-trace                     Start Claude with traffic logging
    claude-trace claude chat         Run specific Claude command with logging

  ${colors.green}Token extraction:${colors.reset}
    claude-trace --extract-token     Extract OAuth token for SDK usage

  ${colors.green}HTML generation:${colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name

  ${colors.green}Indexing:${colors.reset}
    claude-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Start Claude with logging
  claude-trace

  # Run specific command with logging
  claude-trace claude chat --model sonnet-3.5

  # Extract token for Anthropic SDK
  export ANTHROPIC_API_KEY=$(claude-trace --extract-token)

  # Generate HTML report
  claude-trace --generate-html logs/traffic.jsonl report.html

  # Generate conversation index
  claude-trace --index

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}

${colors.yellow}MIGRATION:${colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/mariozechner/claude-trace
`);
}

function getClaudeAbsolutePath(): string {
	try {
		return require("child_process")
			.execSync("which claude", {
				encoding: "utf-8",
			})
			.trim();
	} catch (error) {
		log(`❌ Claude CLI not found in PATH`, "red");
		log(`❌ Please install Claude Code CLI first`, "red");
		process.exit(1);
	}
}

function getLoaderPath(): string {
	const loaderPath = path.join(__dirname, "interceptor-loader.js");

	if (!fs.existsSync(loaderPath)) {
		log(`❌ Interceptor loader not found at: ${loaderPath}`, "red");
		process.exit(1);
	}

	return loaderPath;
}

// Scenario 1: No args -> launch node with interceptor and absolute path to claude
async function runClaudeWithInterception(): Promise<void> {
	log("🚀 Claude Trace", "blue");
	log("Starting Claude with traffic logging", "yellow");
	console.log("");

	const claudePath = getClaudeAbsolutePath();
	const loaderPath = getLoaderPath();

	log("🔄 Starting traffic logger...", "green");
	log("📁 Logs will be written to: .claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}", "blue");
	console.log("");

	// Launch node with interceptor and absolute path to claude
	const child: ChildProcess = spawn("node", ["--require", loaderPath, claudePath], {
		env: {
			...process.env,
			NODE_OPTIONS: "--no-deprecation",
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	// Handle child process events
	child.on("error", (error: Error) => {
		log(`❌ Error starting Claude: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		if (signal) {
			log(`\n🔄 Claude terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\n⚠️  Claude exited with code: ${code}`, "yellow");
		} else {
			log("\n✅ Claude session completed", "green");
		}
	});

	// Handle our own signals
	const handleSignal = (signal: string) => {
		log(`\n🔄 Received ${signal}, shutting down...`, "yellow");
		if (child.pid) {
			child.kill(signal as NodeJS.Signals);
		}
	};

	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));

	// Wait for child process to complete
	try {
		await new Promise<void>((resolve, reject) => {
			child.on("exit", () => resolve());
			child.on("error", reject);
		});
	} catch (error) {
		const err = error as Error;
		log(`❌ Unexpected error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Scenario 2: --extract-token -> launch node with token interceptor and absolute path to claude
async function extractToken(): Promise<void> {
	const claudePath = getClaudeAbsolutePath();

	// Create a temporary file to store the token
	const tempTokenFile = path.join(process.cwd(), `.token-${Date.now()}.tmp`);

	// Read the token extractor template and configure it
	const templatePath = path.join(__dirname, "token-extractor.js");
	if (!fs.existsSync(templatePath)) {
		log(`❌ Token extractor template not found at: ${templatePath}`, "red");
		process.exit(1);
	}

	const templateCode = fs.readFileSync(templatePath, "utf-8");
	const extractorCode = templateCode.replace("TOKEN_FILE_PLACEHOLDER", tempTokenFile);

	// Write the configured extractor
	const tokenExtractorPath = path.join(process.cwd(), `token-extractor-${Date.now()}.js`);
	fs.writeFileSync(tokenExtractorPath, extractorCode);

	const cleanup = () => {
		try {
			if (fs.existsSync(tokenExtractorPath)) fs.unlinkSync(tokenExtractorPath);
			if (fs.existsSync(tempTokenFile)) fs.unlinkSync(tempTokenFile);
		} catch (e) {
			// Ignore cleanup errors
		}
	};

	// Launch node with token interceptor and absolute path to claude
	const child: ChildProcess = spawn("node", ["--require", tokenExtractorPath, claudePath, "-p", "hello"], {
		env: {
			...process.env,
			NODE_TLS_REJECT_UNAUTHORIZED: "0",
		},
		stdio: ["pipe", "pipe", "pipe"], // Suppress all output from Claude
		cwd: process.cwd(),
	});

	// Set a timeout to avoid hanging
	const timeout = setTimeout(() => {
		child.kill();
		cleanup();
		console.error("❌ Timeout: No token found within 30 seconds");
		process.exit(1);
	}, 30000);

	// Handle child process events
	child.on("error", (error: Error) => {
		clearTimeout(timeout);
		cleanup();
		console.error(`❌ Error starting Claude: ${error.message}`);
		process.exit(1);
	});

	child.on("exit", () => {
		clearTimeout(timeout);

		try {
			if (fs.existsSync(tempTokenFile)) {
				const token = fs.readFileSync(tempTokenFile, "utf-8").trim();
				cleanup();
				if (token) {
					// Only output the token, nothing else
					console.log(token);
					process.exit(0);
				}
			}
		} catch (e) {
			// File doesn't exist or read error
		}

		cleanup();
		console.error("❌ No authorization token found");
		process.exit(1);
	});

	// Check for token file periodically
	const checkToken = setInterval(() => {
		try {
			if (fs.existsSync(tempTokenFile)) {
				const token = fs.readFileSync(tempTokenFile, "utf-8").trim();
				if (token) {
					clearTimeout(timeout);
					clearInterval(checkToken);
					child.kill();
					cleanup();

					// Only output the token, nothing else
					console.log(token);
					process.exit(0);
				}
			}
		} catch (e) {
			// Ignore read errors, keep trying
		}
	}, 500);
}

// Scenario 3: --generate-html input.jsonl output.html
async function generateHTMLFromCLI(inputFile: string, outputFile?: string): Promise<void> {
	try {
		const htmlGenerator = new HTMLGenerator();
		await htmlGenerator.generateHTMLFromJSONL(inputFile, outputFile);
		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`❌ Error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Scenario 4: --index
async function generateIndex(): Promise<void> {
	try {
		const { IndexGenerator } = await import("./index-generator");
		const indexGenerator = new IndexGenerator();
		await indexGenerator.generateIndex();
		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`❌ Error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Main entry point
async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Check for help flags
	if (args.includes("--help") || args.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	// Scenario 2: --extract-token
	if (args.includes("--extract-token")) {
		await extractToken();
		return;
	}

	// Scenario 3: --generate-html input.jsonl [output.html]
	if (args.includes("--generate-html")) {
		const flagIndex = args.indexOf("--generate-html");
		const inputFile = args[flagIndex + 1];
		const outputFile = args[flagIndex + 2];

		if (!inputFile) {
			log(`❌ Missing input file for --generate-html`, "red");
			log(`Usage: claude-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile);
		return;
	}

	// Scenario 4: --index
	if (args.includes("--index")) {
		await generateIndex();
		return;
	}

	// Scenario 1: No args (or claude with args) -> launch claude with interception
	await runClaudeWithInterception();
}

main().catch((error) => {
	const err = error as Error;
	log(`❌ Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
