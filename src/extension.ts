
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {collectCommitContext, collectLatestCommitContext, listRecentCommits, type GitCommitContext} from './git-context';
import {buildCombinedDraftPrompt, buildDraftOptionsPrompt, buildDraftPrompt, parseDraftOptions, type PostDraftOption} from './post-prompt';

const execFileAsync = promisify(execFile);
const apiBaseUrl = 'https://codelore-api.codelore.workers.dev';

type LinkedInStatus = {
	connected: boolean;
	displayName?: string | null;
	pictureUrl?: string | null;
};

type LoreCodePost = {
	id: string;
	insight: string;
	draft: string;
	createdAt: number;
	updatedAt: number;
	publishedAt?: number;
	imagePath?: string;
	imageName?: string;
	imageAltText?: string;
	commitIds?: string[];
};

const postsKey = 'lorecode.posts';
const activePostKey = 'lorecode.activePostId';

async function getPosts(context: vscode.ExtensionContext): Promise<LoreCodePost[]> {
	const savedPosts = context.workspaceState.get<LoreCodePost[]>(postsKey);
	if (savedPosts) return savedPosts;

	const insight = context.workspaceState.get<string>('lorecode.latestReflection') ?? '';
	const draft = context.workspaceState.get<string>('lorecode.latestDraft') ?? '';
	if (!insight && !draft) return [];

	const now = Date.now();
	const migratedPost = {id: randomUUID(), insight, draft, createdAt: now, updatedAt: now};
	await context.workspaceState.update(postsKey, [migratedPost]);
	await context.workspaceState.update(activePostKey, migratedPost.id);
	return [migratedPost];
}

function postTitle(post: LoreCodePost): string {
	const text = (post.draft || post.insight).replaceAll(/\s+/g, ' ').trim();
	return text.length > 44 ? `${text.slice(0, 44)}…` : text || 'Untitled post';
}

function postState(post: LoreCodePost): 'published' | 'draft' {
	return post.publishedAt ? 'published' : 'draft';
}

function imageContentType(imagePath: string): string | undefined {
	const extension = path.extname(imagePath).toLowerCase();
	if (extension === '.png') return 'image/png';
	if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
	return undefined;
}

async function createPost(context: vscode.ExtensionContext): Promise<LoreCodePost> {
	const now = Date.now();
	const post = {id: randomUUID(), insight: '', draft: '', createdAt: now, updatedAt: now};
	const posts = await getPosts(context);
	await context.workspaceState.update(postsKey, [post, ...posts]);
	await context.workspaceState.update(activePostKey, post.id);
	return post;
}

async function getActivePost(context: vscode.ExtensionContext): Promise<LoreCodePost> {
	const posts = await getPosts(context);
	const activeId = context.workspaceState.get<string>(activePostKey);
	const activePost = posts.find((post) => post.id === activeId);
	if (activePost) return activePost;
	if (posts[0]) {
		await context.workspaceState.update(activePostKey, posts[0].id);
		return posts[0];
	}
	return createPost(context);
}

async function updateActivePost(context: vscode.ExtensionContext, changes: Partial<LoreCodePost>): Promise<LoreCodePost> {
	const active = await getActivePost(context);
	const updated = {...active, ...changes, updatedAt: Date.now()};
	const posts = await getPosts(context);
	await context.workspaceState.update(postsKey, posts.map((post) => post.id === updated.id ? updated : post));
	await context.workspaceState.update('lorecode.latestReflection', updated.insight);
	await context.workspaceState.update('lorecode.latestDraft', updated.draft);
	return updated;
}

async function createDraftPostsFromOptions(
	context: vscode.ExtensionContext,
	drafts: string[],
): Promise<LoreCodePost[]> {
	const active = await getActivePost(context);
	const posts = await getPosts(context);
	const now = Date.now();
	const created = drafts.map((draft, index) => ({
		...active,
		id: index === 0 ? active.id : randomUUID(),
		draft,
		createdAt: index === 0 ? active.createdAt : now,
		updatedAt: now,
		publishedAt: undefined,
		imagePath: undefined,
		imageName: undefined,
		imageAltText: undefined,
	}));
	await context.workspaceState.update(postsKey, [...created, ...posts.filter((post) => post.id !== active.id)]);
	await context.workspaceState.update(activePostKey, created[0].id);
	await context.workspaceState.update('lorecode.latestDraft', created[0].draft);
	return created;
}

async function getLinkedInStatus(connectionId: string): Promise<LinkedInStatus> {
	const response = await fetch(
		`${apiBaseUrl}/auth/linkedin/status?connection_id=${encodeURIComponent(connectionId)}`,
	);
	const result = (await response.json()) as LinkedInStatus;

	return response.ok ? result : {connected: false};
}

async function isLinkedInConnected(connectionId: string): Promise<boolean> {
	return (await getLinkedInStatus(connectionId)).connected;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


async function getLatestCommitMessage(): Promise<string | undefined> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

	if (!workspaceFolder) {
		return undefined;
	}

	try {
		const {stdout} = await execFileAsync('git', ['log', '-1', '--pretty=%B'], {
			cwd: workspaceFolder.uri.fsPath,
		});
		return stdout.trim() || undefined;
	} catch (error) {
		console.error('Error fetching latest commit message:', error);
		return undefined;
	}
}

async function collectWorkspaceGitContext(commitIds?: string[]): Promise<GitCommitContext | undefined> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) return undefined;

	const runGit = async (args: string[], cwd: string) => {
		const {stdout} = await execFileAsync('git', args, {cwd});
		return stdout;
	};
	return commitIds !== undefined
		? collectCommitContext(workspaceFolder.uri.fsPath, commitIds, runGit)
		: collectLatestCommitContext(workspaceFolder.uri.fsPath, runGit);
}

async function listWorkspaceCommits() {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) return [];
	return listRecentCommits(workspaceFolder.uri.fsPath, async (args, cwd) => {
		const {stdout} = await execFileAsync('git', args, {cwd});
		return stdout;
	});
}


async function generateAiPostDraft(
	manualInsight: string | undefined,
	platform: 'linkedin' | 'x',
	gitContext?: GitCommitContext,
): Promise<string | undefined> {
	const [model] = await vscode.lm.selectChatModels({
		vendor: 'copilot',
	});

	if (!model) {
		vscode.window.showErrorMessage('No AI model available for generating the post draft.');
		return undefined;
	}

	const messages = [
		vscode.LanguageModelChatMessage.User(
			buildDraftPrompt({manualInsight, platform, gitContext}),
		),
	];

	const cancelllation = new vscode.CancellationTokenSource();

	try {
		const response = await model.sendRequest(
			messages,
			{},
		cancelllation.token,
		);

		let draft = '';

		for await (const fragment of response.text) {
			draft += fragment;
	}

	return draft.trim() || undefined;
} finally {
	cancelllation.dispose();
}

}

async function generateAiPostOptions(
	manualInsight: string | undefined,
	platform: 'linkedin' | 'x',
	gitContext?: GitCommitContext,
): Promise<PostDraftOption[]> {
	const [model] = await vscode.lm.selectChatModels({vendor: 'copilot'});
	if (!model) return [];

	const cancellation = new vscode.CancellationTokenSource();
	try {
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(buildDraftOptionsPrompt({manualInsight, platform, gitContext}))],
			{},
			cancellation.token,
		);
		let text = '';
		for await (const fragment of response.text) text += fragment;
		return parseDraftOptions(text);
	} finally {
		cancellation.dispose();
	}
}

async function generateAiCombinedDraft(
	options: PostDraftOption[],
	manualInsight: string | undefined,
	platform: 'linkedin' | 'x',
	gitContext?: GitCommitContext,
): Promise<string | undefined> {
	const [model] = await vscode.lm.selectChatModels({vendor: 'copilot'});
	if (!model) return undefined;

	const cancellation = new vscode.CancellationTokenSource();
	try {
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(buildCombinedDraftPrompt(options, {manualInsight, platform, gitContext}))],
			{},
			cancellation.token,
		);
		let text = '';
		for await (const fragment of response.text) text += fragment;
		return text.trim() || undefined;
	} finally {
		cancellation.dispose();
	}
}


class LoreCodeViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async (message: {command: string; postId?: string}) => {
			if (message.command === 'connectLinkedIn') {
				await vscode.commands.executeCommand('lorecode.connectLinkedIn');
				await this.refresh();
				return;
			}

			if (message.command === 'refresh') {
				await this.refresh();
				return;
			}

			if (message.command === 'newPost') {
				await createPost(this.context);
				await vscode.commands.executeCommand('lorecode.openWorkspace', 'create');
				await this.refresh();
				return;
			}

			if (message.command === 'openWorkspace') {
				await vscode.commands.executeCommand('lorecode.openWorkspace', 'create');
				return;
			}

			if (message.command === 'editPost' && message.postId) {
				await this.context.workspaceState.update(activePostKey, message.postId);
				await vscode.commands.executeCommand('lorecode.openWorkspace', 'create');
				return;
			}

			if (message.command === 'deletePost' && message.postId) {
				const choice = await vscode.window.showWarningMessage(
					'Delete this post? This cannot be undone.',
					{modal: true},
					'Delete',
				);
				if (choice !== 'Delete') return;

				const posts = await getPosts(this.context);
				const remainingPosts = posts.filter((post) => post.id !== message.postId);
				await this.context.workspaceState.update(postsKey, remainingPosts);
				if (this.context.workspaceState.get<string>(activePostKey) === message.postId) {
					await this.context.workspaceState.update(activePostKey, remainingPosts[0]?.id);
				}
				await this.refresh();
			}
		});

		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}

		const connectionId = await this.context.secrets.get('lorecode.linkedinConnectionId');
		const posts = await getPosts(this.context);
		this.view.webview.postMessage({type: 'posts', posts: posts.map((post) => ({id: post.id, title: postTitle(post), updatedAt: post.updatedAt, publishedAt: post.publishedAt, state: postState(post)}))});

		try {
			const status = connectionId
				? await getLinkedInStatus(connectionId)
				: {connected: false};
			this.view.webview.postMessage({type: 'linkedinStatus', ...status});
		} catch (error) {
			console.error('Error refreshing LoreCode profile:', error);
			this.view.webview.postMessage({type: 'linkedinStatus', connected: false});
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomUUID();

		return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<style>
	body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; margin: 0; padding: 16px; }
	.sidebar-shell { display: flex; flex-direction: column; min-height: calc(100vh - 32px); }
	h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
	.subtitle, .muted { color: var(--vscode-descriptionForeground); line-height: 1.45; margin: 0; }
	.section { font-size: 11px; font-weight: 600; letter-spacing: .04em; margin: 24px 0 8px; text-transform: uppercase; }
	.card { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 8px; margin-bottom: 10px; padding: 14px; }
	.card-top { align-items: center; display: flex; gap: 10px; }
	.mark, .avatar { align-items: center; background: var(--vscode-badge-background); border-radius: 50%; color: var(--vscode-badge-foreground); display: flex; flex: 0 0 auto; font-size: 12px; font-weight: 600; height: 32px; justify-content: center; overflow: hidden; width: 32px; }
	.avatar img { height: 100%; object-fit: cover; width: 100%; }
	.card-title { font-weight: 600; }
	.card-copy { color: var(--vscode-descriptionForeground); margin-top: 2px; }
	button { background: var(--vscode-button-secondaryBackground); border: 0; border-radius: 4px; color: var(--vscode-button-secondaryForeground); cursor: pointer; font: inherit; margin-top: 14px; padding: 7px 10px; width: 100%; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { cursor: default; opacity: .55; }
	.actions { display: grid; gap: 6px; }
	.actions button { margin: 0; text-align: left; }
	.new-post { margin: 18px 0 0; text-align: left; }
	.history-empty { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; padding: 10px 4px; }
	.history-row { align-items: center; border-radius: 4px; display: flex; gap: 6px; padding: 7px 4px; } .history-row:hover { background: var(--vscode-list-hoverBackground); } .history-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .history-action { background: transparent; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0; padding: 2px; width: auto; } .history-action svg { display: block; height: 14px; width: 14px; }
	.filters { display: flex; gap: 6px; margin-bottom: 6px; } .filter { background: transparent; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 0; padding: 3px 4px; width: auto; } .filter.active { color: var(--vscode-foreground); } .post-state { color: var(--vscode-descriptionForeground); font-size: 11px; }
	.accounts { margin-top: auto; padding-top: 24px; }
	.privacy { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin-top: 24px; }
</style>
</head>
<body><div class="sidebar-shell">
	<h1>LoreCode</h1>
	<p class="subtitle">Turn today’s work into a story worth sharing.</p>
	<button class="new-post" data-command="newPost">+ New post</button>

	<p class="section">Posts</p>
	<div class="filters"><button class="filter active" data-filter="all">All</button><button class="filter" data-filter="draft">Drafts</button><button class="filter" data-filter="published">Published</button></div><div class="history-empty" id="history">Your draft history will appear here.</div>

	<div class="accounts">
		<p class="section">Accounts</p>
		<div class="card">
			<div class="card-top">
				<div class="mark" id="linkedin-mark">in</div>
				<div>
					<div class="card-title" id="linkedin-title">LinkedIn</div>
					<div class="card-copy" id="linkedin-copy">Share your work with your network.</div>
				</div>
			</div>
			<button id="linkedin-button">Connect LinkedIn</button>
		</div>

		<div class="card">
			<div class="card-top">
				<div class="mark">X</div>
				<div>
					<div class="card-title">X</div>
					<div class="card-copy">Short updates are coming soon.</div>
				</div>
			</div>
			<button disabled>Coming soon</button>
		</div>
		<p class="privacy">Your work stays local until you choose to publish.</p>
	</div>
</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const button = document.getElementById('linkedin-button');
	const title = document.getElementById('linkedin-title');
	const copy = document.getElementById('linkedin-copy');
	const mark = document.getElementById('linkedin-mark');
	const history = document.getElementById('history');
	let postFilter = 'all'; let savedPosts = [];

	button.addEventListener('click', () => vscode.postMessage({command: 'connectLinkedIn'}));
	document.querySelectorAll('[data-command]').forEach((item) => {
		item.addEventListener('click', () => vscode.postMessage({command: item.dataset.command}));
	});
	document.querySelectorAll('[data-filter]').forEach((item) => item.addEventListener('click', () => { postFilter = item.dataset.filter; document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === postFilter)); window.dispatchEvent(new MessageEvent('message', {data: {type: 'posts', posts: savedPosts}})); }));

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'posts') { savedPosts = message.posts; history.replaceChildren(); const posts = savedPosts.filter(post => postFilter === 'all' || post.state === postFilter); if (!posts.length) { history.textContent = 'No posts here yet.'; return; } const ago = time => { const minutes = Math.max(1, Math.floor((Date.now() - time) / 60000)); return minutes < 60 ? minutes + 'm ago' : minutes < 1440 ? Math.floor(minutes / 60) + 'h ago' : Math.floor(minutes / 1440) + 'd ago'; }; posts.forEach(post => { const row = document.createElement('div'); row.className = 'history-row'; const title = document.createElement('span'); title.className = 'history-title'; title.textContent = post.title; const state = document.createElement('span'); state.className = 'post-state'; state.textContent = post.state === 'published' ? 'Published ' + ago(post.publishedAt) : 'Draft ' + ago(post.updatedAt); const edit = document.createElement('button'); edit.className = 'history-action'; edit.ariaLabel = 'Edit post'; edit.title = 'Edit post'; edit.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z"/></svg>'; edit.addEventListener('click', () => vscode.postMessage({command: 'editPost', postId: post.id})); const remove = document.createElement('button'); remove.className = 'history-action'; remove.ariaLabel = 'Delete post'; remove.title = 'Delete post'; remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/></svg>'; remove.addEventListener('click', () => vscode.postMessage({command: 'deletePost', postId: post.id})); row.append(title, state, edit, remove); history.appendChild(row); }); return; }
		if (message.type !== 'linkedinStatus') return;

		if (!message.connected) {
			title.textContent = 'LinkedIn';
			copy.textContent = 'Share your work with your network.';
			mark.textContent = 'in';
			button.textContent = 'Connect LinkedIn';
			button.disabled = false;
			return;
		}

		const name = message.displayName || 'LinkedIn connected';
		title.textContent = name;
		copy.textContent = 'LinkedIn connected';
		button.textContent = 'Connected';
		button.disabled = true;
		mark.className = 'avatar';
		mark.textContent = name.charAt(0).toUpperCase();

		if (message.pictureUrl) {
			const image = document.createElement('img');
			image.src = message.pictureUrl;
			image.alt = '';
			image.addEventListener('error', () => image.remove());
			mark.replaceChildren(image);
		}
	});

	vscode.postMessage({command: 'refresh'});
</script>
</body>
</html>`;
	}
}

class LoreCodeWorkspacePanel {
	private panel: vscode.WebviewPanel | undefined;
	private activeView: 'create' | 'publish' = 'create';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly refreshSidebar: () => Promise<void>,
	) {}

	open(view: 'create' | 'publish' = 'create'): void {
		this.activeView = view;
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			void this.panel.webview.postMessage({type: 'navigate', view});
			void this.refresh();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'lorecode.workspace',
			'LoreCode',
			vscode.ViewColumn.Active,
			{enableScripts: true, retainContextWhenHidden: true},
		);
		this.panel.webview.html = this.getHtml(this.panel.webview);
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
		this.panel.webview.onDidReceiveMessage(async (message: {command: string; value?: string; source?: string; altText?: string; commitIds?: string[]; drafts?: string[]; options?: PostDraftOption[]}) => {
			if (message.command === 'ready') {
				await this.refresh();
				await this.panel?.webview.postMessage({type: 'navigate', view: this.activeView});
				return;
			}

			if (message.command === 'saveReflection') {
				const reflection = message.value?.trim();
				if (!reflection) {
					await this.postStatus('Write a reflection before saving it.');
					return;
				}

				await updateActivePost(this.context, {insight: reflection});
				await this.refresh('Reflection saved.');
				return;
			}

			if (message.command === 'generateDraft') {
				const writtenInsight = message.value?.trim();
				const post = await getActivePost(this.context);
				const gitContext = await collectWorkspaceGitContext(post.commitIds);
				const reflection = writtenInsight || gitContext?.commitMessage;
				if (!reflection) {
					await this.postStatus('Write an insight or make a Git commit first.');
					return;
				}
				await updateActivePost(this.context, {insight: writtenInsight ?? ''});

				await this.postStatus(writtenInsight ? 'Generating story ideas...' : 'Using your latest commit to generate story ideas...');
				const fallbackDraft = [
					gitContext?.commitMessage
						? `Shipped: ${gitContext.commitMessage}`
						: 'Today I learned something while building:',
					...(writtenInsight ? ['', reflection] : []),
					'',
				].join('\n');

				try {
					const options = await generateAiPostOptions(writtenInsight, 'linkedin', gitContext);
					if (options.length) {
						await this.panel?.webview.postMessage({type: 'draftOptions', options});
						await this.postStatus('Pick a direction to keep editing.');
						return;
					}
					const draft = await generateAiPostDraft(writtenInsight, 'linkedin', gitContext) ?? fallbackDraft;
					await updateActivePost(this.context, {draft});
					await this.refresh('Draft ready for your review.');
				} catch (error) {
					console.error('Error generating LoreCode draft:', error);
					await updateActivePost(this.context, {draft: fallbackDraft});
					await this.refresh('Copilot was unavailable, so LoreCode made a simple draft.');
				}
				return;
			}

			if (message.command === 'chooseDraftOption') {
				await updateActivePost(this.context, {draft: message.value?.trim() ?? ''});
				await this.refresh('Draft ready for your review.');
				await this.panel?.webview.postMessage({type: 'navigate', view: 'create', mode: 'draft'});
				return;
			}

			if (message.command === 'createDraftOptions') {
				const drafts = message.drafts?.map((draft) => draft.trim()).filter(Boolean) ?? [];
				if (!drafts.length) return;
				await createDraftPostsFromOptions(this.context, drafts);
				await this.refresh(drafts.length === 1 ? 'Draft ready for your review.' : `${drafts.length} drafts created.`);
				await this.panel?.webview.postMessage({type: 'navigate', view: 'create', mode: 'draft'});
				return;
			}

			if (message.command === 'combineDraftOptions') {
				const options = message.options?.filter((option) => option?.draft?.trim() && option?.label?.trim()) ?? [];
				if (options.length < 2) {
					await this.postStatus('Choose at least two directions to create one story.');
					return;
				}
				const post = await getActivePost(this.context);
				const gitContext = await collectWorkspaceGitContext(post.commitIds);
				await this.postStatus('Writing one story from your selected directions...');
				const draft = await generateAiCombinedDraft(options, message.value?.trim() || post.insight, 'linkedin', gitContext) ?? options[0].draft;
				await updateActivePost(this.context, {draft});
				await this.refresh('Combined draft ready for your review.');
				await this.panel?.webview.postMessage({type: 'navigate', view: 'create', mode: 'draft'});
				return;
			}

			if (message.command === 'saveCommitSelection') {
				await updateActivePost(this.context, {commitIds: message.commitIds ?? []});
				await this.refresh('Work context updated.');
				return;
			}

			if (message.command === 'saveDraft') {
				await updateActivePost(this.context, {draft: message.value?.trim() ?? ''});
				await this.refresh('Draft saved.');
				return;
			}

			if (message.command === 'copyDraft') {
				const draft = (await getActivePost(this.context)).draft;
				if (!draft) {
					await this.postStatus('Create a draft before copying it.');
					return;
				}

				await vscode.env.clipboard.writeText(draft);
				await this.postStatus('Draft copied to your clipboard.');
				return;
			}

			if (message.command === 'selectImage') {
				const selection = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					filters: {Images: ['jpg', 'jpeg', 'png']},
					openLabel: 'Attach image',
				});
				const imageUri = selection?.[0];
				if (!imageUri) return;

				const file = await vscode.workspace.fs.stat(imageUri);
				if (file.size > 10 * 1024 * 1024) {
					await this.postStatus('Choose an image smaller than 10 MB.');
					return;
				}

				await updateActivePost(this.context, {
					imagePath: imageUri.fsPath,
					imageName: path.basename(imageUri.fsPath),
					imageAltText: undefined,
				});
				await this.refresh('Image attached. It stays local until you publish.');
				return;
			}

			if (message.command === 'removeImage') {
				await updateActivePost(this.context, {imagePath: undefined, imageName: undefined, imageAltText: undefined});
				await this.refresh('Image removed.');
				return;
			}

			if (message.command === 'saveImageAltText') {
				await updateActivePost(this.context, {imageAltText: message.value?.trim() ?? ''});
				return;
			}

			if (message.command === 'publishPost') {
				const connectionId = await this.context.secrets.get('lorecode.linkedinConnectionId');
				if (!connectionId || !message.value?.trim()) {
					await this.postStatus('Connect LinkedIn and add text before publishing.');
					return;
				}
				const post = await getActivePost(this.context);
				await updateActivePost(this.context, {
					...(message.source === 'draft' ? {draft: message.value.trim()} : {insight: message.value.trim()}),
					...(post.imagePath ? {imageAltText: message.altText?.trim() ?? ''} : {}),
				});
				try {
					await this.postStatus('Publishing to LinkedIn...');
					const response = post.imagePath
						? await this.publishImagePost(connectionId, message.value.trim(), post.imagePath, post.imageName, message.altText)
						: await fetch(`${apiBaseUrl}/linkedin/publish`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({connectionId, text: message.value.trim()})});
					const result = (await response.json()) as {published?: boolean; error?: string};
					if (result.published) await updateActivePost(this.context, {publishedAt: Date.now()});
					if (!result.published && result.error?.includes('expired')) await this.refresh('Your LinkedIn connection expired. Reconnect from the LoreCode sidebar.');
					await this.panel?.webview.postMessage({type: 'publishResult', published: Boolean(result.published), message: result.error});
					await this.postStatus(result.published ? 'Published to LinkedIn.' : result.error ?? 'LinkedIn could not publish this post.');
				} catch (error) {
					console.error('Error publishing to LinkedIn:', error);
					await this.postStatus(error instanceof Error ? error.message : 'LoreCode could not reach LinkedIn. Try again shortly.');
				}
			}
		});

	}

	private async refresh(status?: string): Promise<void> {
		if (!this.panel) {
			return;
		}

		const post = await getActivePost(this.context);
		const commits = await listWorkspaceCommits();
		const selectedCommitIds = post.commitIds ?? commits.slice(0, 1).map((commit) => commit.id);
		const imageUrl = this.getImagePreviewUrl(post.imagePath);
		const gitContext = await collectWorkspaceGitContext(selectedCommitIds);
		const connectionId = await this.context.secrets.get('lorecode.linkedinConnectionId');
		let linkedIn: LinkedInStatus = {connected: false};
		try {
			linkedIn = connectionId ? await getLinkedInStatus(connectionId) : linkedIn;
		} catch (error) {
			console.error('Error loading LinkedIn review status:', error);
		}
		await this.panel.webview.postMessage({
			type: 'state',
			reflection: post.insight,
			draft: post.draft,
			imageUrl,
			imageName: post.imageName,
			imageAltText: post.imageAltText,
			gitContext: gitContext && {
				commitMessage: gitContext.commitMessage,
				changedFiles: gitContext.changedFiles,
				fileCount: gitContext.fileCount,
				stats: gitContext.stats,
			},
			commits,
			selectedCommitIds,
			linkedIn,
			status,
		});
		await this.refreshSidebar();
	}

	private async publishImagePost(
		connectionId: string,
		text: string,
		imagePath: string,
		imageName?: string,
		altText?: string,
	): Promise<Response> {
		const contentType = imageContentType(imagePath);
		if (!contentType) {
			throw new Error('LoreCode only supports PNG and JPEG images.');
		}

		let imageBytes: Uint8Array;
		try {
			imageBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(imagePath));
		} catch {
			throw new Error('The attached image is no longer available. Add it again.');
		}

		const form = new FormData();
		form.append('connectionId', connectionId);
		form.append('text', text);
		form.append('altText', altText?.trim() ?? '');
		form.append('image', new Blob([imageBytes], {type: contentType}), imageName ?? path.basename(imagePath));

		return fetch(`${apiBaseUrl}/linkedin/publish-image`, {method: 'POST', body: form});
	}

	private getImagePreviewUrl(imagePath?: string): string | undefined {
		if (!this.panel || !imagePath) return undefined;

		this.panel.webview.options = {
			...this.panel.webview.options,
			localResourceRoots: [vscode.Uri.file(path.dirname(imagePath))],
		};
		return this.panel.webview.asWebviewUri(vscode.Uri.file(imagePath)).toString();
	}

	private async postStatus(status: string): Promise<void> {
		if (this.panel) {
			await this.panel.webview.postMessage({type: 'status', status});
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomUUID();
		return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<style>${this.workspaceStyles()}</style>
</head>
<body>
	${this.workspaceMarkup()}
	<script nonce="${nonce}">${this.workspaceScript()}</script>
</body>
</html>`;
	}

	private workspaceStyles(): string {
		return `
			body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); margin: 0; }
			.app { min-height: 100vh; }
			main { box-sizing: border-box; display: flex; flex-direction: column; margin: 0 auto; max-width: 860px; min-height: 100vh; padding: 28px 32px 24px; width: 100%; }
			.view { display: none; flex: 1; }
			.view.active { display: block; }
			h1 { font-size: 26px; font-weight: 600; margin: 0 0 8px; }
			p { color: var(--vscode-descriptionForeground); line-height: 1.55; margin: 0 0 22px; }
			textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; box-sizing: border-box; color: var(--vscode-input-foreground); font: 14px/1.55 var(--vscode-font-family); min-height: 220px; padding: 14px; resize: vertical; width: 100%; }
			textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
			.primary { align-self: flex-end; background: var(--vscode-button-background); border: 0; border-radius: 5px; color: var(--vscode-button-foreground); cursor: pointer; font: inherit; margin-top: 16px; padding: 9px 14px; }
			.primary:hover { background: var(--vscode-button-hoverBackground); }
			.published { background: var(--vscode-testing-iconPassed) !important; color: var(--vscode-editor-background) !important; }
			.secondary { background: var(--vscode-button-secondaryBackground); border: 0; border-radius: 5px; color: var(--vscode-button-secondaryForeground); cursor: pointer; font: inherit; margin: 16px 8px 0 0; padding: 9px 14px; }
			#editor-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
			#insight-actions, #draft-actions { align-items: center; display: flex; flex-wrap: wrap; }
			#insight-actions[hidden], #draft-actions[hidden] { display: none; }
			#draft-actions[hidden] { display: none; }
			#media-actions { align-items: center; display: flex; flex-wrap: wrap; margin-left: auto; }
			#media-actions .secondary { margin-right: 0; }
			#remove-image { margin: 16px 0 0 6px; }
			#git-context { align-items: center; color: var(--vscode-descriptionForeground); display: flex; font-size: 12px; gap: 8px; margin-top: 10px; }
			#git-context[hidden] { display: none; }
			.context-link { background: transparent; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0; }
			.context-link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
			#commit-picker { background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent); inset: 0; padding: 20px; position: fixed; z-index: 5; }
			#commit-picker[hidden] { display: none; }
			.picker-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 7px; box-shadow: 0 10px 28px rgba(0, 0, 0, .35); margin: 8vh auto 0; max-width: 620px; }
			.picker-head, .picker-footer { padding: 16px 18px; }
			.picker-head { border-bottom: 1px solid var(--vscode-editorWidget-border); }
			.picker-head h2 { font-size: 16px; margin: 0 0 5px; }
			.picker-head p { font-size: 12px; margin: 0; }
			#commit-list { max-height: 340px; overflow-y: auto; padding: 8px; }
			.commit-option { align-items: flex-start; border-radius: 4px; cursor: pointer; display: flex; gap: 10px; padding: 9px 10px; }
			.commit-option:hover { background: var(--vscode-list-hoverBackground); }
			.commit-option input { appearance: none; background: var(--vscode-checkbox-background); border: 1px solid var(--vscode-checkbox-border); border-radius: 2px; height: 13px; margin-top: 3px; position: relative; width: 13px; }
			.commit-option input:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
			.commit-option input:checked::after { border: solid var(--vscode-button-foreground); border-width: 0 2px 2px 0; content: ''; height: 6px; left: 3px; position: absolute; top: 1px; transform: rotate(45deg); width: 3px; }
			.commit-option input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
			.commit-option strong { display: block; font-weight: 500; }
			.commit-option span { color: var(--vscode-descriptionForeground); display: block; font-size: 12px; margin-top: 2px; }
			.picker-footer { align-items: center; border-top: 1px solid var(--vscode-editorWidget-border); display: flex; }
			#commit-count { color: var(--vscode-descriptionForeground); flex: 1; font-size: 12px; }
			.picker-footer .secondary, .picker-footer .primary { margin-top: 0; }
			#draft-options { display: grid; gap: 12px; }
			.draft-option { border: 1px dashed var(--vscode-editorWidget-border); border-radius: 7px; cursor: pointer; padding: 14px; }
			.draft-option:hover { border-color: var(--vscode-focusBorder); }
			.draft-option-header { align-items: center; display: flex; gap: 9px; margin-bottom: 8px; }
			.draft-option-header h2 { flex: 1; font-size: 13px; font-weight: 600; margin: 0; }
			.option-checkbox { appearance: none; background: var(--vscode-checkbox-background); border: 1px solid var(--vscode-checkbox-border); border-radius: 2px; height: 13px; position: relative; width: 13px; }
			.option-checkbox:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
			.option-checkbox:checked::after { border: solid var(--vscode-button-foreground); border-width: 0 2px 2px 0; content: ''; height: 6px; left: 3px; position: absolute; top: 1px; transform: rotate(45deg); width: 3px; }
			.draft-option p { color: var(--vscode-editor-foreground); font-size: 13px; margin: 0 0 12px; white-space: pre-wrap; }
			.option-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
			.option-actions .secondary, .option-actions .primary { margin: 0; }
			.option-actions span { color: var(--vscode-descriptionForeground); flex: 1; font-size: 12px; }
			.icon-button { background: transparent; border: 0; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px; }
			.icon-button:hover { color: var(--vscode-editor-foreground); }
			.icon-button svg { display: block; height: 14px; width: 14px; }
			.footer-actions { align-items: center; display: flex; justify-content: flex-end; margin-top: auto; padding-top: 24px; }
			.footer-actions .primary { margin-top: 0; }
			.footer-actions .secondary { margin: 0; }
			.copy-button { align-items: center; display: inline-flex; gap: 6px; margin-right: auto !important; }
			.copy-button svg { height: 14px; width: 14px; }
			.footer { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 16px; min-height: 18px; }
			.empty { border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; color: var(--vscode-descriptionForeground); padding: 14px; white-space: pre-wrap; }
			#review-image { border-radius: 6px; display: block; margin-top: 20px; max-height: 500px; max-width: 100%; object-fit: contain; }
			#review-image[hidden] { display: none; }
			#alt-text-group { margin-top: 16px; }
			#alt-text-group[hidden] { display: none; }
			#alt-text-group label { color: var(--vscode-descriptionForeground); display: block; font-size: 12px; margin-bottom: 6px; }
			#alt-text { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-sizing: border-box; color: var(--vscode-input-foreground); font: inherit; padding: 8px 10px; width: 100%; }
			@media (max-width: 560px) { main { padding: 28px 20px; } }
		`;
	}

	private workspaceMarkup(): string {
		return `
			<div class="app">
				<main>
					<section class="view active" id="create">
						<h1 id="create-title">What’s worth sharing today?</h1>
						<p id="create-copy">Pick the commits behind it. Add context if it helps.</p>
						<textarea id="editor" placeholder="A problem you solved, choice you made, or lesson you learned."></textarea>
						<div id="git-context" hidden>
							<span id="git-context-summary"></span>
							<button class="context-link" id="choose-commits" type="button">Choose commits</button>
						</div>
						<div id="editor-actions">
							<div id="insight-actions">
								<button class="primary" id="generate-draft">Generate story ideas</button>
								<button class="secondary" id="save-reflection">Save insight</button>
							</div>
						<div id="draft-actions" hidden>
							<button class="secondary" id="back-to-options" hidden>Back to options</button>
							<button class="secondary" id="edit-input">Edit input</button>
								<button class="secondary" id="regenerate-draft">Regenerate</button>
								<button class="secondary" id="save-draft">Save changes</button>
							</div>
							<div id="media-actions">
								<button class="secondary" id="select-image">Add image</button>
								<button class="icon-button" id="remove-image" aria-label="Remove image" title="Remove image" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/></svg></button>
							</div>
						</div>
					</section>
					<section class="view" id="publish">
						<h1>Preview & publish</h1>
						<p>This is the exact text LoreCode will send. Nothing posts automatically.</p>
						<div class="empty" id="review-content">
							<div id="review-text"></div>
							<img id="review-image" alt="Attached image" hidden>
						</div>
						<div id="alt-text-group" hidden>
							<label for="alt-text">Image description <span>(optional)</span></label>
							<input id="alt-text" type="text" maxlength="4086" placeholder="Describe the image for screen readers">
						</div>
						<p class="footer" id="review-account">Checking LinkedIn connection...</p>
						<button class="secondary" id="back-to-draft">Back to edit</button>
					</section>
					<section class="view" id="options">
						<h1>Pick what to share</h1>
						<p>Choose one or more directions from the work you selected.</p>
						<div id="draft-options"></div>
						<div class="option-actions"><span id="option-selection-count">No options selected</span><button class="secondary" id="create-separate-drafts" disabled>Create separate drafts</button><button class="primary" id="create-combined-draft" disabled>Create one story</button></div>
					</section>
					<div class="footer" id="status"></div>
						<div class="footer-actions" id="footer-actions">
						<button class="secondary copy-button" id="copy-draft" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 1h8v2H5v8H3V1zm3 4h7v10H6V5zm1 1v8h5V6H7z"/></svg><span>Copy draft</span></button>
						<button class="primary" id="review-publish">Preview & publish</button>
						<button class="primary" id="publish-linkedin" hidden disabled>Publish to LinkedIn</button>
						</div>
						<div id="commit-picker" hidden>
							<div class="picker-card" role="dialog" aria-modal="true" aria-labelledby="commit-picker-title">
								<div class="picker-head"><h2 id="commit-picker-title">Choose the work to include</h2><p>Select every commit that belongs to this story.</p></div>
								<div id="commit-list"></div>
								<div class="picker-footer"><span id="commit-count"></span><button class="secondary" id="cancel-commits">Cancel</button><button class="primary" id="apply-commits">Use selected commits</button></div>
							</div>
						</div>
				</main>
			</div>
		`;
	}

	private workspaceScript(): string {
		return `
			const vscode = acquireVsCodeApi();
			const editor = document.getElementById('editor');
			const status = document.getElementById('status');
			const createTitle = document.getElementById('create-title');
			const createCopy = document.getElementById('create-copy');
			const insightActions = document.getElementById('insight-actions');
			const draftActions = document.getElementById('draft-actions');
			const backToOptionsButton = document.getElementById('back-to-options');
			const reviewTextElement = document.getElementById('review-text');
			const reviewImage = document.getElementById('review-image');
			const altTextGroup = document.getElementById('alt-text-group');
			const altTextInput = document.getElementById('alt-text');
			const reviewAccount = document.getElementById('review-account');
			const reviewButton = document.getElementById('review-publish');
			const publishButton = document.getElementById('publish-linkedin');
			const copyButton = document.getElementById('copy-draft');
			const selectImageButton = document.getElementById('select-image');
			const removeImageButton = document.getElementById('remove-image');
			const gitContextElement = document.getElementById('git-context');
			const gitContextSummary = document.getElementById('git-context-summary');
			const chooseCommitsButton = document.getElementById('choose-commits');
			const commitPicker = document.getElementById('commit-picker');
			const commitList = document.getElementById('commit-list');
			const commitCount = document.getElementById('commit-count');
			const draftOptionsElement = document.getElementById('draft-options');
			const optionSelectionCount = document.getElementById('option-selection-count');
			const separateDraftsButton = document.getElementById('create-separate-drafts');
			const createCombinedDraftButton = document.getElementById('create-combined-draft');

			let insight = '';
			let draft = '';
			let reviewText = '';
			let imageUrl = '';
			let imageName = '';
			let mode = 'insight';
			let isGenerating = false;
			let gitContext;
			let commits = [];
			let selectedCommitIds = [];
			let savedCommitIds = [];
			let draftOptions = [];
			let selectedDraftOptionIndexes = [];

			function renderGitContext() {
				const hasCommits = commits.length > 0;
				gitContextElement.hidden = !hasCommits;
				const hasContext = Boolean(gitContext?.commitMessage);
				if (!hasContext) {
					gitContextSummary.textContent = 'Context: no commits selected';
					return;
				}

				const commitLabel = selectedCommitIds.length === 1 ? 'commit' : 'commits';
				const fileLabel = gitContext.fileCount === 1 ? 'file changed' : 'files changed';
				gitContextSummary.textContent = 'Context: ' + selectedCommitIds.length + ' ' + commitLabel + ' · ' + gitContext.fileCount + ' ' + fileLabel;
			}

			function renderCommitPicker() {
				commitList.replaceChildren();
				commits.forEach(commit => {
					const row = document.createElement('label');
					row.className = 'commit-option';
					const checkbox = document.createElement('input');
					checkbox.type = 'checkbox';
					checkbox.checked = selectedCommitIds.includes(commit.id);
					checkbox.addEventListener('change', () => {
						selectedCommitIds = checkbox.checked
							? [...selectedCommitIds, commit.id]
							: selectedCommitIds.filter(id => id !== commit.id);
						renderCommitCount();
					});
					const copy = document.createElement('div');
					const title = document.createElement('strong');
					title.textContent = commit.title;
					const meta = document.createElement('span');
					meta.textContent = commit.date + ' · ' + commit.fileCount + (commit.fileCount === 1 ? ' file changed' : ' files changed');
					copy.append(title, meta);
					row.append(checkbox, copy);
					commitList.appendChild(row);
				});
				renderCommitCount();
			}

			function renderCommitCount() {
				commitCount.textContent = selectedCommitIds.length + (selectedCommitIds.length === 1 ? ' commit selected' : ' commits selected');
			}

			function selectedDraftOptions() {
				return selectedDraftOptionIndexes.map(index => draftOptions[index]).filter(Boolean);
			}

			function renderOptionActions() {
				const count = selectedDraftOptionIndexes.length;
				optionSelectionCount.textContent = count === 0 ? 'No options selected' : count + (count === 1 ? ' option selected' : ' options selected');
				separateDraftsButton.disabled = count === 0;
				createCombinedDraftButton.disabled = count < 2;
			}

			function renderDraftOptions(options) {
				draftOptions = options;
				selectedDraftOptionIndexes = [];
				draftOptionsElement.replaceChildren();
				options.forEach((option, index) => {
					const card = document.createElement('article');
					card.className = 'draft-option';
					const header = document.createElement('div');
					header.className = 'draft-option-header';
					const checkbox = document.createElement('input');
					checkbox.className = 'option-checkbox';
					checkbox.type = 'checkbox';
					checkbox.setAttribute('aria-label', 'Select ' + option.label);
					checkbox.addEventListener('change', () => {
						selectedDraftOptionIndexes = checkbox.checked
							? [...selectedDraftOptionIndexes, index]
							: selectedDraftOptionIndexes.filter(selected => selected !== index);
						renderOptionActions();
					});
					card.addEventListener('click', event => {
						if (event.target === checkbox) return;
						checkbox.checked = !checkbox.checked;
						checkbox.dispatchEvent(new Event('change'));
					});
					const label = document.createElement('h2');
					label.textContent = option.label;
					const text = document.createElement('p');
					text.textContent = option.draft;
					header.append(checkbox, label);
					card.append(header, text);
					draftOptionsElement.appendChild(card);
				});
				renderOptionActions();
			}

			function renderImage() {
				selectImageButton.textContent = imageName ? 'Replace image' : 'Add image';
				removeImageButton.hidden = !imageName;
				const hasImage = Boolean(imageUrl);
				reviewImage.hidden = !hasImage;
				if (hasImage) {
					reviewImage.src = imageUrl;
				} else {
					reviewImage.removeAttribute('src');
				}
			}

			function renderPreview() {
				reviewTextElement.textContent = reviewText || draft || insight || 'Write something before you publish.';
				renderImage();
			}

			function showView(view) {
				document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === view));
				reviewButton.hidden = view !== 'create';
				publishButton.hidden = view !== 'publish';
				copyButton.hidden = view !== 'create' || mode !== 'draft';
				altTextGroup.hidden = view !== 'publish' || !imageUrl;
				if (view === 'publish') {
					renderPreview();
				}
			}

			function showMode(nextMode) {
				mode = nextMode;
				const isDraft = mode === 'draft';
				createTitle.textContent = isDraft ? 'Shape your LinkedIn draft' : 'What’s worth sharing today?';
				createCopy.textContent = isDraft ? 'Edit it until it sounds like you. Your original insight is still safe.' : 'Pick the commits behind it. Add context if it helps.';
				editor.value = isDraft ? draft : insight;
				editor.placeholder = isDraft ? 'Your LinkedIn draft' : 'A problem you solved, choice you made, or lesson you learned.';
				insightActions.hidden = isDraft;
				draftActions.hidden = !isDraft;
				backToOptionsButton.hidden = !isDraft || draftOptions.length === 0;
				copyButton.hidden = !isDraft;
			}

			document.getElementById('save-reflection').addEventListener('click', () => {
				vscode.postMessage({command: 'saveReflection', value: editor.value});
			});
			document.getElementById('generate-draft').addEventListener('click', () => {
				insight = editor.value;
				isGenerating = true;
				vscode.postMessage({command: 'generateDraft', value: insight});
			});
			document.getElementById('regenerate-draft').addEventListener('click', () => {
				isGenerating = true;
				vscode.postMessage({command: 'generateDraft', value: insight});
			});
			document.getElementById('save-draft').addEventListener('click', () => {
				vscode.postMessage({command: 'saveDraft', value: editor.value});
			});
			document.getElementById('copy-draft').addEventListener('click', () => {
				vscode.postMessage({command: 'copyDraft'});
			});
			document.getElementById('select-image').addEventListener('click', () => {
				vscode.postMessage({command: 'selectImage'});
			});
			document.getElementById('remove-image').addEventListener('click', () => {
				vscode.postMessage({command: 'removeImage'});
			});
			chooseCommitsButton.addEventListener('click', () => {
				renderCommitPicker();
				commitPicker.hidden = false;
			});
			document.getElementById('cancel-commits').addEventListener('click', () => {
				selectedCommitIds = [...savedCommitIds];
				commitPicker.hidden = true;
			});
			document.getElementById('apply-commits').addEventListener('click', () => {
				commitPicker.hidden = true;
				vscode.postMessage({command: 'saveCommitSelection', commitIds: selectedCommitIds});
			});
			altTextInput.addEventListener('blur', () => {
				vscode.postMessage({command: 'saveImageAltText', value: altTextInput.value});
			});
			document.getElementById('edit-input').addEventListener('click', () => {
				draft = editor.value;
				vscode.postMessage({command: 'saveDraft', value: draft});
				showMode('insight');
			});
			backToOptionsButton.addEventListener('click', () => {
				showView('options');
			});
			reviewButton.addEventListener('click', () => {
				if (mode === 'draft') {
					draft = editor.value;
				} else {
					insight = editor.value;
				}
				reviewText = editor.value;
				showView('publish');
			});
			document.getElementById('back-to-draft').addEventListener('click', () => {
				showView('create');
				showMode('draft');
			});
			separateDraftsButton.addEventListener('click', () => {
				vscode.postMessage({command: 'createDraftOptions', drafts: selectedDraftOptions().map(option => option.draft)});
			});
			createCombinedDraftButton.addEventListener('click', () => {
				vscode.postMessage({command: 'combineDraftOptions', options: selectedDraftOptions()});
			});
			publishButton.addEventListener('click', () => {
				if (publishButton.dataset.confirm !== 'true') {
					publishButton.dataset.confirm = 'true';
					publishButton.textContent = 'Confirm publish to LinkedIn';
					status.textContent = 'This will publish publicly to LinkedIn.';
					return;
				}

				publishButton.disabled = true;
				publishButton.textContent = 'Publishing…';
				vscode.postMessage({command: 'publishPost', value: reviewText || draft || insight, source: mode, altText: altTextInput.value});
			});

			window.addEventListener('message', event => {
				const message = event.data;
				if (message.type === 'state') {
					insight = message.reflection || '';
					draft = message.draft || '';
					imageUrl = message.imageUrl || '';
					imageName = message.imageName || '';
					altTextInput.value = message.imageAltText || '';
					gitContext = message.gitContext;
					commits = message.commits || [];
					selectedCommitIds = message.selectedCommitIds || [];
					savedCommitIds = [...selectedCommitIds];
					if (isGenerating && draft) {
						isGenerating = false;
						showMode('draft');
					} else {
						showMode(mode);
					}
					reviewAccount.textContent = message.linkedIn?.connected ? message.linkedIn.displayName || 'LinkedIn connected' : 'Connect LinkedIn before publishing.';
					publishButton.disabled = !message.linkedIn?.connected;
					status.textContent = message.status || '';
					renderImage();
					renderGitContext();
				}
				if (message.type === 'status') {
					status.textContent = message.status;
				}
				if (message.type === 'publishResult') {
					publishButton.textContent = message.published ? 'Published ✓' : 'Couldn’t publish';
					publishButton.classList.toggle('published', message.published);
					publishButton.disabled = true;
				}
				if (message.type === 'draftOptions') {
					isGenerating = false;
					renderDraftOptions(message.options || []);
					showView('options');
				}
				if (message.type === 'navigate') {
					showView(message.view);
					if (message.mode) showMode(message.mode);
				}
			});

			vscode.postMessage({command: 'ready'});
		`;
	}
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const lorecodeViewProvider = new LoreCodeViewProvider(context);
	const lorecodeWorkspacePanel = new LoreCodeWorkspacePanel(
		context,
		() => lorecodeViewProvider.refresh(),
	);

	context.subscriptions.push(
	vscode.window.registerWebviewViewProvider(
		'lorecode.today',
		lorecodeViewProvider,
	),
);

	const openWorkspace = vscode.commands.registerCommand(
		'lorecode.openWorkspace',
		(view?: 'create' | 'publish') => {
			lorecodeWorkspacePanel.open(view);
		},
	);

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "lorecode" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand(
		'lorecode.reflectOnToday',
		async () => {
			const reflection = await vscode.window.showInputBox({
				prompt: 'What did you learn, build or get unstuck today?',
				placeHolder: 'I learned how to use the VS Code API to create an extension!',
				ignoreFocusOut: true,
			});

			if (!reflection?.trim()) {
				return;
			}

			await context.workspaceState.update('lorecode.latestReflection', reflection.trim());

			vscode.window.showInformationMessage('Your reflection has been saved. Nice work!');
		},
	);

	const viewLatestReflection = vscode.commands.registerCommand(
		'lorecode.viewLatestReflection',
		async () => {
			const reflection = context.workspaceState.get<string>('lorecode.latestReflection');

			if (!reflection) {
				vscode.window.showInformationMessage('No reflection yet. Start with LoreCode: Reflect on Today.');
				return;
			}

			vscode.window.showInformationMessage(`Your latest reflection: ${reflection}`);
		},
	);


	const copyLatestDraft = vscode.commands.registerCommand(
		'lorecode.copyLatestDraft',
		async () => {
			const draft = context.workspaceState.get<string>('lorecode.latestDraft');

			if (!draft) {
				vscode.window.showInformationMessage('Create a draft before copying one.');
				return;
			}

			await vscode.env.clipboard.writeText(draft);

			vscode.window.showInformationMessage(
				'Latest draft copied to clipboard.',
			);
		},
	);

	const connectLinkedIn = vscode.commands.registerCommand(
		'lorecode.connectLinkedIn',
		async () => {
			let connectionId = await context.secrets.get('lorecode.linkedinConnectionId');

			if (!connectionId) {
				connectionId = randomUUID();
				await context.secrets.store('lorecode.linkedinConnectionId', connectionId);
			}

			const connectUrl = vscode.Uri.parse(
				`${apiBaseUrl}/auth/linkedin/start?connection_id=${encodeURIComponent(connectionId)}`,
			);
			await vscode.env.openExternal(connectUrl);

			const connected = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Waiting for LinkedIn approval...',
					cancellable: true,
				},
				async (_progress, token) => {
					const deadline = Date.now() + 10 * 60 * 1000;

					while (!token.isCancellationRequested && Date.now() < deadline) {
						try {
							if (await isLinkedInConnected(connectionId)) {
								return true;
							}
						} catch (error) {
							console.error('Error waiting for LinkedIn connection:', error);
						}

						await delay(2_000);
					}

					return false;
				},
			);

			if (connected) {
				vscode.window.showInformationMessage('LinkedIn is connected to LoreCode.');
				return;
			}

			vscode.window.showInformationMessage(
				'LinkedIn is still waiting for approval. You can try connecting again whenever you are ready.',
			);
		},
	);

	const checkLinkedInConnection = vscode.commands.registerCommand(
		'lorecode.checkLinkedInConnection',
		async () => {
			const connectionId = await context.secrets.get('lorecode.linkedinConnectionId');

			if (!connectionId) {
				vscode.window.showInformationMessage(
					'LinkedIn is not connected yet. Start with LoreCode: Connect LinkedIn.',
				);
				return;
			}

			try {
				if (await isLinkedInConnected(connectionId)) {
					vscode.window.showInformationMessage('LinkedIn is connected to LoreCode.');
					return;
				}

				vscode.window.showInformationMessage(
					'LinkedIn is not connected yet. Run LoreCode: Connect LinkedIn to try again.',
				);
			} catch (error) {
				console.error('Error checking LinkedIn connection:', error);
				vscode.window.showErrorMessage('LoreCode could not check LinkedIn right now.');
			}
		},
	);

	const draftPostFromLatestReflection = vscode.commands.registerCommand(
		'lorecode.draftPostFromLatestReflection',
		async () => {
			const reflection = context.workspaceState.get<string>('lorecode.latestReflection');

			if (!reflection) {
				vscode.window.showInformationMessage(
					'Add a reflection before drafting a post.',
				);
				return;
			}


			const contextChoice = await vscode.window.showQuickPick(
				[
					{
						label: 'Reflection only',
						description: 'Draft from your words only',
						id: 'reflection',
					},
					{
						label: 'Reflection + latest commit',
						description: 'Include the latest commit message',
						id: 'latestCommit',
					},
				],
				{
					placeHolder: 'What should LoreCode use for this draft?',
				},
			);
			if (!contextChoice) {
				return;
			}

			const platformChoice = await vscode.window.showQuickPick(
				[
					{
						label: 'LinkedIn',
						description: 'Thoughtful, professional, and concise',
						id: 'linkedin',
					},
					{
						label: 'X',
						description: 'Short, punchy, and engaging',
						id: 'x',
					},

				],
				{
					placeHolder: 'Where are you sharing this?',
				},

			);

			if (!platformChoice) {
				return;
			}

			const platform = platformChoice.id === 'x' ? 'x': 'linkedin';

			const gitContext =
			contextChoice.id === 'latestCommit'
			? await collectWorkspaceGitContext()
			: undefined;

			const fallbackDraft = [
				gitContext?.commitMessage
				? `Shipped: ${gitContext.commitMessage}`
				: 'Today I learned something while building:',
				'',
				reflection,
			].join('\n');

			let draft = fallbackDraft;

			try {
				const aiDraft = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'LoreCode is writing your draft...',
					},
					() => generateAiPostDraft(reflection, platform, gitContext),
				);

				if (aiDraft) {
					draft = aiDraft;
				} else {
					vscode.window.showInformationMessage(
						'Copilot is unavailable, so LoreCode used a simple draft instead.',
					);
				};

			} catch (error) {
				console.error('Error generating LoreCode draft:', error)


			vscode.window.showInformationMessage(
				'LoreCode used a simple draft because Copilot couldnt respond.',
			);
		}


			await context.workspaceState.update('lorecode.latestDraft', draft);

			const document = await vscode.workspace.openTextDocument({
				content: draft,
				language: 'markdown',
			});

			await vscode.window.showTextDocument(document, {
				preview: false,
			});
		},
	);

	context.subscriptions.push(
		disposable,
		viewLatestReflection,
		draftPostFromLatestReflection,
		copyLatestDraft,
		connectLinkedIn,
		checkLinkedInConnection,
		openWorkspace,
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
