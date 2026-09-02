import type {GitCommitContext} from './git-context';

type DraftPromptOptions = {
	manualInsight?: string;
	gitContext?: GitCommitContext;
	platform: 'linkedin' | 'x';
};

export type DraftOptionAngle = 'feature' | 'bug' | 'lesson' | 'build-log';

export type PostDraftOption = {
	angle: DraftOptionAngle;
	label: string;
	draft: string;
};

export function buildDraftPrompt({manualInsight, gitContext, platform}: DraftPromptOptions): string {
	const platformInstruction = platform === 'x'
		? 'Write one X post under 280 characters.'
		: 'Write a LinkedIn update between 80 and 160 words.';
	const context = [
		manualInsight ? `What I want to say:\n${manualInsight}` : '',
		gitContext ? `Latest commit:\n${gitContext.commitMessage}` : '',
		gitContext?.stats ? `Change summary:\n${gitContext.stats}` : '',
		gitContext?.changedFiles.length ? `Files involved:\n${gitContext.changedFiles.join('\n')}` : '',
	].filter(Boolean).join('\n\n');

	return [
		platformInstruction,
		'Write like a developer sharing a real update with other developers, not an announcement or a changelog.',
		'Build a small story: open with the concrete thing that changed or the problem being worked through, add one useful detail, then stop when the thought is complete.',
		'Use short paragraphs and plain language. A direct, slightly unfinished-sounding update is better than polished marketing copy or a tidy moral.',
		'Every claim must be supported by the supplied context. Do not invent facts, feelings, collaborators, user impact, tradeoffs, or lessons.',
		'Do not force a lesson. If there is no real lesson in the context, leave it out.',
		'Do not use these phrases or their close cousins: "journey", "grateful", "excited", "dive deep", "the importance of", "collaboration was key", "making an impact", "not just", or "I look forward to".',
		'Do not add a call to action. Use no hashtags unless the author explicitly asks for them.',
		'Return only the post text. Do not add a title, commentary, or Markdown code fence.',
		'',
		context,
	].join('\n');
}

export function buildDraftOptionsPrompt(options: DraftPromptOptions): string {
	return [
		buildDraftPrompt(options),
		'',
		'Create two or three distinct post options. Each option must use a different supported angle.',
		'Allowed angles are: feature, bug, lesson, build-log. Use only angles the supplied context genuinely supports.',
		'Feature means a concrete capability or improvement. Bug means a real problem that was fixed. Lesson means a specific engineering idea learned or applied. Build log is a direct work-in-progress update without a forced lesson.',
		'Only include an angle if the supplied context supports it. Do not invent a bug, a lesson, a decision, or an outcome.',
		'Commit titles are source material, not post language. Never say "merged PR", mention a commit, mention a pull request, list file counts, or say "N files changed".',
		'If the author wrote an insight, treat it as the strongest source of their voice and intent.',
		'Use these labels: "Feature", "Problem solved", "Lesson learned", or "Build log". Do not reuse a label.',
		'Return only a JSON array. Each item must have exactly: angle, label, draft. No Markdown or extra commentary.',
	].join('\n');
}

export function parseDraftOptions(response: string): PostDraftOption[] {
	const source = response.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
	try {
		const value: unknown = JSON.parse(source);
		if (!Array.isArray(value)) return [];
		return value
			.filter(isPostDraftOption)
			.map((option) => ({...option, label: option.label.trim(), draft: option.draft.trim()}))
			.filter((option) => option.label && option.draft)
			.slice(0, 3);
	} catch {
		return [];
	}
}

export function buildCombinedDraftPrompt(
	options: PostDraftOption[],
	context: DraftPromptOptions,
): string {
	return [
		buildDraftPrompt(context),
		'',
		'Write one fresh build-in-public story from the selected directions below. Do not stitch together or quote the draft options.',
		'Find one natural thread that connects them. Do not turn this into a changelog or a list.',
		'Never mention pull requests, commits, file counts, or the existence of these options.',
		'Return only the post text.',
		'',
		'Selected directions:',
		...options.map((option) => `- ${option.label} (${option.angle})`),
	].join('\n');
}

function isPostDraftOption(value: unknown): value is PostDraftOption {
	if (!value || typeof value !== 'object') return false;
	const option = value as Record<string, unknown>;
	return typeof option.label === 'string'
		&& typeof option.draft === 'string'
		&& (option.angle === 'feature' || option.angle === 'bug' || option.angle === 'lesson' || option.angle === 'build-log');
}
