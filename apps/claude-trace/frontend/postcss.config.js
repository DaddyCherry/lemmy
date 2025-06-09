module.exports = {
	plugins: {
		tailwindcss: {},
		autoprefixer: {},
	},
};

const fs = require('fs');

process.on('uncaughtException', function (err) {
	console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', function (err) {
	console.error('Unhandled Rejection:', err);
});

try {
	const fileContent = fs.readFileSync('/Users/masato/Desktop/Dev/git_work/lemmy/.claude-trace/log-2025-06-09-04-26-39.jsonl', 'utf-8');
	console.log(fileContent);
} catch (e) {
	console.error('Error:', e);
}

const lines = fileContent.split('\n').filter(Boolean);
console.log('lines[0]:', lines[0]);
console.log('lines[1]:', lines[1]);
console.log('lines.length:', lines.length);

const pairs = fileContent.split('\n').filter(Boolean).map(line => JSON.parse(line));
console.log(pairs);

const json = JSON.stringify(pairs);
console.log(json);

const base64 = Buffer.from(json, 'utf-8').toString('base64');
console.log(base64);

const buf = Buffer.from(base64, 'base64');
console.log(buf.toString('utf-8'));