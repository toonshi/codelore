import * as assert from 'assert';
import {collectCommitContext, collectLatestCommitContext, listRecentCommits} from '../git-context';

suite('Git context collector', () => {
	test('collects a safe, limited summary of the latest commit', async () => {
		const commands: string[][] = [];
		const context = await collectLatestCommitContext('/workspace', async (args) => {
			commands.push(args);
			if (args[0] === 'log') return 'add image publishing\n';
			if (args.includes('--name-only')) return 'src/extension.ts\napps/api/src/index.ts\n.env\n.env.local\npackage-lock.json\n';
			if (args.includes('--shortstat')) return ' 2 files changed, 70 insertions(+), 6 deletions(-)\n';
			return 'diff --git a/src/extension.ts b/src/extension.ts\n+new feature\n'.repeat(500);
		});

		assert.deepStrictEqual(context, {
			commitMessage: 'add image publishing',
			changedFiles: ['src/extension.ts', 'apps/api/src/index.ts'],
			fileCount: 2,
			stats: '2 files changed, 70 additions, 6 deletions',
			diff: 'diff --git a/src/extension.ts b/src/extension.ts\n+new feature\n'.repeat(500).slice(0, 12_000),
		});
		assert.ok(commands.some((args) => args.includes('--root')));
		assert.ok(commands.some((args) => args.includes('--first-parent') && args.includes('-m')));
	});

	test('returns no context when Git is unavailable', async () => {
		const context = await collectLatestCommitContext('/workspace', async () => {
			throw new Error('not a Git repository');
		});

		assert.strictEqual(context, undefined);
	});

	test('lists recent commits with stable metadata for the picker', async () => {
		const commits = await listRecentCommits('/workspace', async (args) => {
			if (args[0] === 'log') {
				return 'a1b2c3\u001fkeep image controls together\u001f2026-09-02\u001e'
					+ 'd4e5f6\u001fadd image preview\u001f2026-09-01\u001e';
			}
			if (args.includes('a1b2c3')) return 'src/extension.ts\n';
			return 'src/extension.ts\nresources/codelore.svg\n';
		});

		assert.deepStrictEqual(commits, [
			{id: 'a1b2c3', title: 'keep image controls together', date: '2026-09-02', fileCount: 1},
			{id: 'd4e5f6', title: 'add image preview', date: '2026-09-01', fileCount: 2},
		]);
	});

	test('combines selected commits into one safe writing context', async () => {
		const context = await collectCommitContext('/workspace', ['a1b2c3', 'd4e5f6'], async (args) => {
			if (args[0] === 'log') return args.includes('a1b2c3') ? 'keep image controls together\n' : 'add image preview\n';
			if (args.includes('a1b2c3')) return 'src/extension.ts\n';
			return 'src/extension.ts\nresources/codelore.svg\n';
		});

		assert.deepStrictEqual(context, {
			commitMessage: 'keep image controls together · add image preview',
			changedFiles: ['src/extension.ts', 'resources/codelore.svg'],
			fileCount: 2,
			stats: '2 commits selected, 2 files changed',
			diff: '',
		});
	});
});
