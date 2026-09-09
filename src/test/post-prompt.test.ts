import * as assert from 'assert';
import {buildCombinedDraftPrompt, buildDraftOptionsPrompt, buildDraftPrompt, buildXComposerUrl, isXReady, parseDraftOptions} from '../post-prompt';

suite('Post prompt builder', () => {
	test('grounds the draft in the developer\'s work and rejects generic LinkedIn language', () => {
		const prompt = buildDraftPrompt({
			platform: 'linkedin',
			manualInsight: 'I wanted the upload button to stay on the first row.',
			gitContext: {
				commitMessage: 'keep image controls together',
				changedFiles: ['src/extension.ts'],
				fileCount: 1,
				stats: '1 file changed, 12 additions, 4 deletions',
				diff: '',
			},
		});

		assert.match(prompt, /keep image controls together/);
		assert.match(prompt, /src\/extension.ts/);
		assert.match(prompt, /I wanted the upload button/);
		assert.match(prompt, /"journey", "grateful", "excited"/);
		assert.match(prompt, /Use no hashtags/);
		assert.match(prompt, /not an announcement or a changelog/);
		assert.match(prompt, /Do not force a lesson/);
		assert.match(prompt, /Every claim must be supported/);
	});

	test('keeps Git-only story ideas factual and out of Git workflow language', () => {
		const prompt = buildDraftOptionsPrompt({platform: 'linkedin'});

		assert.match(prompt, /Create exactly two distinct post options: one feature and one build-log/);
		assert.match(prompt, /Allowed angles are: feature, build-log/);
		assert.match(prompt, /Never say "merged PR"/);
		assert.match(prompt, /Return only a JSON array/);
		assert.match(prompt, /Feature means a concrete capability or improvement/);
		assert.match(prompt, /Use these labels: "Feature", "Problem solved", "Lesson learned", or "Build log"/);
	});

	test('builds a safe X composer link and checks the post length', () => {
		assert.strictEqual(buildXComposerUrl('Build notes & a link'), 'https://x.com/intent/tweet?text=Build%20notes%20%26%20a%20link');
		assert.strictEqual(isXReady('a'.repeat(280)), true);
		assert.strictEqual(isXReady('a'.repeat(281)), false);
		assert.strictEqual(isXReady('👋'.repeat(280)), true);
		assert.strictEqual(isXReady('👋'.repeat(281)), false);
	});

	test('unlocks problem and lesson angles when the author adds context', () => {
		const prompt = buildDraftOptionsPrompt({
			platform: 'linkedin',
			manualInsight: 'I fixed the layout bug after learning why the flex container kept shrinking.',
		});

		assert.match(prompt, /Create two or three distinct post options/);
		assert.match(prompt, /Allowed angles are: feature, bug, lesson, build-log/);
	});

	test('parses valid draft options and ignores unsupported angles', () => {
		const options = parseDraftOptions('```json\n[{"angle":"feature","label":"New feature","draft":"Built image previews."},{"angle":"bug","label":"Problem solved","draft":"Fixed the picker."},{"angle":"news","label":"News","draft":"Nope."}]\n```');

		assert.deepStrictEqual(options, [
			{angle: 'feature', label: 'Feature', draft: 'Built image previews.'},
			{angle: 'bug', label: 'Problem solved', draft: 'Fixed the picker.'},
		]);
	});

	test('parses draft options when the model adds a short preamble', () => {
		const options = parseDraftOptions('Here are three directions:\n[{"angle":"feature","label":"Feature","draft":"Added a cleaner publishing flow."}]\nPick the one that fits.');

		assert.deepStrictEqual(options, [
			{angle: 'feature', label: 'Feature', draft: 'Added a cleaner publishing flow.'},
		]);
	});

	test('normalizes common model field names and angle labels', () => {
		const options = parseDraftOptions('[{"angle":"Problem solved","content":"Tracked down why the draft action skipped the options screen."},{"angle":"build_log","post":"Still tightening the flow before release."}]');

		assert.deepStrictEqual(options, [
			{angle: 'bug', label: 'Problem solved', draft: 'Tracked down why the draft action skipped the options screen.'},
			{angle: 'build-log', label: 'Build log', draft: 'Still tightening the flow before release.'},
		]);
	});

	test('creates a fresh combined-story prompt instead of joining drafts', () => {
		const prompt = buildCombinedDraftPrompt([
			{angle: 'feature', label: 'New feature', draft: 'Built image previews.'},
			{angle: 'lesson', label: 'Engineering lesson', draft: 'Kept the controls together.'},
		], {platform: 'linkedin'});

		assert.match(prompt, /Do not stitch together/);
		assert.match(prompt, /New feature \(feature\)/);
		assert.match(prompt, /Never mention pull requests, commits, file counts/);
	});
});
