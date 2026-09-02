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

export type GitCommit = {
	id: string;
	title: string;
	date: string;
	fileCount: number;
};

export async function collectCommitContext(
	workspacePath: string,
	commitIds: string[],
	runGit: GitCommandRunner,
): Promise<GitCommitContext | undefined> {
	if (!commitIds.length) return undefined;

	try {
		const commitMessages = await Promise.all(commitIds.map(async (commitId) =>
			(await runGit(['log', '-1', '--pretty=%s', commitId], workspacePath)).trim(),
		));
		const changedFileLists = await Promise.all(commitIds.map(async (commitId) =>
			filterContextFiles((await runGit(
				['show', '--format=', '--name-only', '--root', '--first-parent', '-m', commitId],
				workspacePath,
			)).split('\n')),
		));
		const changedFiles = [...new Set(changedFileLists.flat())].slice(0, MAX_CONTEXT_FILES);
		const titles = commitMessages.filter(Boolean);
		if (!titles.length) return undefined;

		return {
			commitMessage: titles.join(' · '),
			changedFiles,
			fileCount: changedFiles.length,
			stats: `${titles.length} ${titles.length === 1 ? 'commit' : 'commits'} selected, ${changedFiles.length} ${changedFiles.length === 1 ? 'file' : 'files'} changed`,
			diff: '',
		};
	} catch {
		return undefined;
	}
}

export async function listRecentCommits(
	workspacePath: string,
	runGit: GitCommandRunner,
): Promise<GitCommit[]> {
	try {
		const rawCommits = await runGit(
			['log', '-30', '--date=short', '--pretty=format:%H%x1f%s%x1f%ad%x1e'],
			workspacePath,
		);
		const commits = rawCommits
			.split('\u001e')
			.map((record) => record.trim())
			.filter(Boolean)
			.map((record) => {
				const [id, title, date] = record.split('\u001f');
				return {id, title, date};
			})
			.filter((commit) => commit.id && commit.title && commit.date);

		return Promise.all(commits.map(async (commit) => {
			const files = await runGit(
				['show', '--format=', '--name-only', '--root', '--first-parent', '-m', commit.id],
				workspacePath,
			);
			return {...commit, fileCount: filterContextFiles(files.split('\n')).length};
		}));
	} catch {
		return [];
	}
}

export async function collectLatestCommitContext(
	workspacePath: string,
	runGit: GitCommandRunner,
): Promise<GitCommitContext | undefined> {
	try {
		const commitMessage = (await runGit(['log', '-1', '--pretty=%B'], workspacePath)).trim();
		if (!commitMessage) return undefined;

		const changedFiles = filterContextFiles(
			(await runGit(['show', '--format=', '--name-only', '--root', '--first-parent', '-m', 'HEAD'], workspacePath))
				.split('\n'),
		).slice(0, MAX_CONTEXT_FILES);
		const fileCount = changedFiles.length;
		const stats = formatStats(
			await runGit(['show', '--format=', '--shortstat', '--root', '--first-parent', '-m', 'HEAD'], workspacePath),
		);
		const diff = changedFiles.length
			? limitDiff(await runGit(['show', '--format=', '--no-ext-diff', '--unified=3', '--root', '--first-parent', '-m', 'HEAD', '--', ...changedFiles], workspacePath))
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
		const fileName = parts.at(-1) ?? '';
		return !parts.some((part) => excludedPathParts.has(part))
			&& !excludedFileNames.has(fileName)
			&& !fileName.startsWith('.env.');
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
