import * as assert from 'assert';
import {collectLatestCommitContext} from '../git-context';

suite('Git context collector', () => {
	test('collects a safe, limited summary of the latest commit', async () => {
		const commands: string[][] = [];
		const context = await collectLatestCommitContext('/workspace', async (args) => {
			commands.push(args);
			if (args[0] === 'log') return 'add image publishing\n';
			if (args.includes('--name-only')) return 'src/extension.ts\napps/api/src/index.ts\n.env\npackage-lock.json\n';
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
	});

	test('returns no context when Git is unavailable', async () => {
		const context = await collectLatestCommitContext('/workspace', async () => {
			throw new Error('not a Git repository');
		});

		assert.strictEqual(context, undefined);
	});
});
