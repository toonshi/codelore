const MAX_CONTEXT_FILES = 12;
const MAX_DIFF_CHARACTERS = 12_000;

const excludedPathParts = new Set([
	'.env',
	'.git',
	'node_modules',
	'dist',
	'build',
	'coverage',
]);

const excludedFileNames = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
]);

export type GitCommandRunner = (args: string[], workspacePath: string) => Promise<string>;

export type GitCommitContext = {
	commitMessage: string;
	changedFiles: string[];
	fileCount: number;
	stats: string;
	diff: string;
};

export async function collectLatestCommitContext(
	workspacePath: string,
	runGit: GitCommandRunner,
): Promise<GitCommitContext | undefined> {
	try {
		const commitMessage = (await runGit(['log', '-1', '--pretty=%B'], workspacePath)).trim();
		if (!commitMessage) return undefined;

		const changedFiles = filterContextFiles(
			(await runGit(['show', '--format=', '--name-only', '--root', 'HEAD'], workspacePath))
				.split('\n'),
		).slice(0, MAX_CONTEXT_FILES);
		const fileCount = changedFiles.length;
		const stats = formatStats(
			await runGit(['show', '--format=', '--shortstat', '--root', 'HEAD'], workspacePath),
		);
		const diff = changedFiles.length
			? limitDiff(await runGit(['show', '--format=', '--no-ext-diff', '--unified=3', '--root', 'HEAD', '--', ...changedFiles], workspacePath))
			: '';

		return {commitMessage, changedFiles, fileCount, stats, diff};
	} catch {
		return undefined;
	}
}

function filterContextFiles(paths: string[]): string[] {
	return paths.filter((filePath) => {
		const normalizedPath = filePath.trim();
		if (!normalizedPath) return false;

		const parts = normalizedPath.split('/');
		return !parts.some((part) => excludedPathParts.has(part))
			&& !excludedFileNames.has(parts.at(-1) ?? '');
	});
}

function formatStats(rawStats: string): string {
	const match = rawStats.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
	if (!match) return 'Changed files in latest commit';

	const [, files, additions = '0', deletions = '0'] = match;
	return `${files} files changed, ${additions} additions, ${deletions} deletions`;
}

function limitDiff(diff: string): string {
	return diff.slice(0, MAX_DIFF_CHARACTERS);
}
