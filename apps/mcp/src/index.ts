import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {collectCommitContext, listRecentCommits} from '../../../src/git-context.js';
import {buildDraftPrompt} from '../../../src/post-prompt.js';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], workspacePath: string): Promise<string> {
	const {stdout} = await execFileAsync('git', args, {cwd: workspacePath});
	return stdout;
}

function textResult(text: string) {
	return {content: [{type: 'text' as const, text}]};
}

const server = new McpServer({name: 'LoreCode', version: '0.1.0'});

server.registerTool('lorecode_list_recent_commits', {
	description: 'List recent commits in a local Git repository so the author can choose the work behind one story.',
	inputSchema: z.object({repositoryPath: z.string().describe('Absolute path to the local Git repository.')}),
}, async ({repositoryPath}) => {
	try {
		const commits = await listRecentCommits(repositoryPath, runGit);
		return textResult(JSON.stringify(commits, null, 2));
	} catch (error) {
		return textResult(`Could not read Git commits: ${error instanceof Error ? error.message : 'unknown error'}`);
	}
});

server.registerTool('lorecode_collect_git_context', {
	description: 'Collect a safe, high-level story context from selected Git commit IDs. It returns commit titles, file names, and summary statistics, never source diffs.',
	inputSchema: z.object({
		repositoryPath: z.string().describe('Absolute path to the local Git repository.'),
		commitIds: z.array(z.string()).min(1).max(20).describe('Commit SHAs to include in the story.'),
	}),
}, async ({repositoryPath, commitIds}) => {
	try {
		const context = await collectCommitContext(repositoryPath, commitIds, runGit);
		return textResult(JSON.stringify(context, null, 2));
	} catch (error) {
		return textResult(`Could not collect Git context: ${error instanceof Error ? error.message : 'unknown error'}`);
	}
});

server.registerTool('lorecode_create_post_prompt', {
	description: 'Create LoreCode writing instructions for a LinkedIn update or X post. Supply Git context separately in the conversation.',
	inputSchema: z.object({
		platform: z.enum(['linkedin', 'x']),
		manualInsight: z.string().optional(),
	}),
}, ({platform, manualInsight}) => textResult(buildDraftPrompt({platform, manualInsight})));

server.registerTool('lorecode_check_post', {
	description: 'Run deterministic final checks on a proposed social post before the author publishes it.',
	inputSchema: z.object({platform: z.enum(['linkedin', 'x']), text: z.string()}),
}, ({platform, text}) => {
	const characterCount = Array.from(text).length;
	const notes: string[] = [];
	if (!text.trim()) notes.push('Add post text before publishing.');
	if (platform === 'x' && characterCount > 280) notes.push(`X posts must be shortened by ${characterCount - 280} characters.`);
	if (platform === 'linkedin' && characterCount < 45) notes.push('This is very short for a LinkedIn update; add one concrete detail if useful.');
	if (/\b(journey|grateful|excited to share|dive deep)\b/i.test(text)) notes.push('Consider replacing generic promotional language with a concrete detail.');
	if (!notes.length) notes.push('Looks ready for the author to review and publish.');
	return textResult(JSON.stringify({platform, characterCount, notes}, null, 2));
});

await serveStdio(() => server);
