# claude-bridge

Use non-Anthropic models (OpenAI, Google) with Claude Code by proxying and transforming requests.

## What it does

Claude Code only works with Anthropic's Claude models. `claude-bridge` intercepts Claude Code's API calls and forwards them to other LLM providers like OpenAI or Google, allowing you to use GPT-4, Gemini, and other models within Claude Code's interface.

## Usage

```bash
# Use OpenAI GPT-4o with Claude Code (defaults to chat mode)
claude-bridge --provider openai --model gpt-4o

# Use Google Gemini with a specific prompt in Claude Code headless mode
claude-bridge --provider google --model gemini-1.5-pro --run-with -p "Hello world"

# Use custom API key
claude-bridge --provider openai --model gpt-4o --apiKey sk-...

# Use custom log directory
claude-bridge --provider google --model gemini-1.5-pro --log-dir ./my-logs
```

### Options

- `--provider <provider>` - LLM provider (openai, google)
- `--model <model>` - Model name (e.g., gpt-4o, gemini-1.5-pro)
- `--apiKey <key>` - API key (optional, uses env vars)
- `--log-dir <dir>` - Log directory (default: .claude-bridge)
- `--run-with <args...>` - Claude Code arguments (default: chat)
- `--patch-claude` - Patch Claude binary to disable anti-debugging (development only)

### Environment Variables

- `OPENAI_API_KEY` - OpenAI API key
- `GOOGLE_API_KEY` - Google API key

## Development

### Architecture

```
Claude Code → claude-bridge (intercept) → Transform → Provider API → Transform → Stream back
```

**Core Components:**

- **CLI** (`src/cli.ts`) - Command-line interface and process management
- **Interceptor** (`src/interceptor.ts`) - Fetch interception and request/response logging
- **Types** (`src/types.ts`) - TypeScript interfaces and types
- **Loader** (`src/interceptor-loader.js`) - CommonJS loader for tsx/node compatibility

**How it works:**

1. **Interception**: Instruments `global.fetch()` to catch calls to `api.anthropic.com/v1/messages`
2. **Logging**: Raw requests logged to `{logDir}/requests-{timestamp}.jsonl`
3. **Debug Info**: Interceptor logs to `{logDir}/log.txt` (avoids stdout pollution)
4. **Transformation**: ✅ Convert Anthropic requests → lemmy UserMessage/AssistantMessage format
5. **Logging Transformed**: Converted messages logged to `{logDir}/transformed-{timestamp}.jsonl`
6. **Forwarding**: _(TODO)_ Send to OpenAI/Google APIs and stream response back

### Project Structure

```
src/
├── cli.ts                  # CLI entry point with commander
├── interceptor.ts          # Fetch interception + file logging + transformation
├── interceptor-loader.js   # CommonJS loader for tsx compatibility
├── transform.ts           # Anthropic → lemmy Message conversion
├── types.ts               # TypeScript interfaces
└── index.ts               # Package exports

test/
└── smoke.test.ts          # Integration tests (4 tests)

dist/                      # Compiled JavaScript output
```

### Building & Testing

```bash
# Install dependencies (from monorepo root)
npm install

# Build lemmy package first (required dependency)
cd packages/lemmy && npm run build && cd ../..

# Build claude-bridge
cd apps/claude-bridge
npm run build

# Run tests
npm run test:run

# Type checking
npm run typecheck
```

### Development Workflow

**VSCode Debug Setup:**

Claude Code includes anti-debugging protection that prevents debuggers from attaching. For development, you can patch the Claude binary:

2. Set breakpoints in `src/cli.ts` or `src/interceptor.ts`
3. Open JavaScript Debug Terminal in VSCode
4. Run: `npx tsx --inspect src/cli.ts --provider openai --model gpt-4o --patch-code`, `--patch-code` will disable the anti-debug in Claude Code.
5. Debugger will attach automatically

**⚠️ Warning**: `--patch-claude` modifies your Claude binary in-place. A backup is saved to `{logDir}/claude.backup`. Restore with:

```bash
cp .claude-bridge/claude.backup /opt/homebrew/bin/claude
```

**Quick Testing:**

```bash
# Test CLI help
npx tsx src/cli.ts --help

# Test with minimal args (defaults to chat)
npx tsx src/cli.ts --provider openai --model gpt-4o

# For debugging/development with patched Claude
npx tsx src/cli.ts --provider openai --model gpt-4o --patch-claude
```

**Log Inspection:**

```bash
# Check interception logs
cat .claude-bridge/log.txt

# Check raw requests (when Claude actually makes calls)
cat .claude-bridge/requests-*.jsonl | jq

# Check transformed lemmy messages
cat .claude-bridge/transformed-*.jsonl | jq
```

### Current Status

- ✅ **Fetch Interception**: Working - captures v1/messages calls
- ✅ **File Logging**: Working - requests.jsonl + log.txt
- ✅ **CLI Interface**: Working - all arguments and validation
- ✅ **Testing**: Working - 4 smoke tests passing
- ✅ **Request Transformation**: Working - Anthropic → lemmy UserMessage/AssistantMessage
- ✅ **Transformation Logging**: Working - transformed.jsonl with lemmy messages + anthropic params
- 🔄 **Provider Forwarding**: TODO - Call OpenAI/Google APIs
- 🔄 **Response Streaming**: TODO - Forward SSE back to Claude Code

### Next Steps

1. ✅ ~~Implement request transformation using lemmy package~~
2. Add provider-specific API calls (OpenAI/Google)
3. Stream provider responses back as Anthropic-compatible SSE
4. Add more comprehensive testing with real API calls

### Transformation Details

The `transform.ts` module converts Anthropic API requests to lemmy's unified format:

- **Input**: Anthropic `MessageCreateParamsBase` (from `@anthropic-ai/sdk`)
- **Output**: `TransformResult` containing:
   - `context`: Lemmy `Context` object with system message, messages, and tools
   - `anthropicParams`: Anthropic-specific parameters not stored in Context

**Context includes:**

- **System message** → `context.setSystemMessage()`
- **Messages** → `context.addMessage()` for each `UserMessage`/`AssistantMessage`
- **Tools** → Preserved in `anthropicParams.tools` (not converted to lemmy format)

**Supported conversions:**

- Text content → `UserMessage.content` / `AssistantMessage.content`
- Images → `UserMessage.attachments[]` with proper mime types
- Tool results → `UserMessage.toolResults[]`
- Tool calls → `AssistantMessage.toolCalls[]`
- Thinking blocks → `AssistantMessage.thinking` + `thinkingSignature`
- Tool definitions → Preserved as original Anthropic format in `anthropicParams.tools`

**Log format** (`transformed-{timestamp}.jsonl`):

```json
{
	"timestamp": 1640995200.123,
	"request_id": "req_123_abc",
	"original_anthropic": {
		/* raw anthropic request */
	},
	"lemmy_context": {
		"system_message": "You are a helpful assistant",
		"messages": [
			/* UserMessage/AssistantMessage[] */
		]
	},
	"anthropic_params": {
		/* model, max_tokens, temperature, etc. */
	},
	"bridge_config": { "provider": "openai", "model": "gpt-4o" },
	"logged_at": "2023-01-01T00:00:00.000Z"
}
```
