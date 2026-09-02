import * as assert from 'assert';
import {buildDraftOptionsPrompt, buildDraftPrompt, parseDraftOptions} from '../post-prompt';

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
	});

	test('asks for several grounded angles without Git workflow language', () => {
		const prompt = buildDraftOptionsPrompt({platform: 'linkedin'});

		assert.match(prompt, /two or three distinct post options/);
		assert.match(prompt, /Never say "merged PR"/);
		assert.match(prompt, /Return only a JSON array/);
	});

	test('parses valid draft options and ignores unsupported angles', () => {
		const options = parseDraftOptions('```json\n[{"angle":"feature","label":"New feature","draft":"Built image previews."},{"angle":"bug","label":"Problem solved","draft":"Fixed the picker."},{"angle":"news","label":"News","draft":"Nope."}]\n```');

		assert.deepStrictEqual(options, [
			{angle: 'feature', label: 'New feature', draft: 'Built image previews.'},
			{angle: 'bug', label: 'Problem solved', draft: 'Fixed the picker.'},
		]);
	});
});
