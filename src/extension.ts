
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const apiBaseUrl = 'https://codelore-api.codelore.workers.dev';

type LinkedInStatus = {
	connected: boolean;
	displayName?: string | null;
	pictureUrl?: string | null;
};

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


async function generateAiPostDraft(
	reflection: string,
	platform: 'linkedin' | 'x',
	latestCommitMessage?: string,
): Promise<string | undefined> {
	const [model] = await vscode.lm.selectChatModels({
		vendor: 'copilot',
	});

	if (!model) {
		vscode.window.showErrorMessage('No AI model available for generating the post draft.');
		return undefined;
	}

	const selectedContext = latestCommitMessage
		? `Latest commit:\n${latestCommitMessage}\n\nReflection:\n${reflection}`
		: `Reflection:\n${reflection}`;


	const platformInstructions =
	     platform === 'x'
		 ? 'Write one X post under 280 characters. Make it sharp and direct.'
		 : 'Write a Linkedin post between 100 and 180 words. Make it thoughtful and easy to read.';
	const messages = [
		vscode.LanguageModelChatMessage.User(
			[
				platformInstructions,
				'Only use the facts in the provided context. Do not make up any facts.',
				'Make it personal, concise, authentic and natural.',
				'Focus on what the developer learned, or why the work mattered.',
				'Return only the post text. Do not add a title, commentary, or Markdown code fence.',
				'Use at most three relevant hashtags.',
				'',
				selectedContext,

			].join('\n'),
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


class CodeLoreViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async (message: {command: string}) => {
			if (message.command === 'connectLinkedIn') {
				await vscode.commands.executeCommand('codelore.connectLinkedIn');
				await this.refresh();
				return;
			}

			if (message.command === 'refresh') {
				await this.refresh();
				return;
			}

			if (message.command === 'reflect' || message.command === 'draft' || message.command === 'copy') {
				const commands: Record<string, string> = {
					reflect: 'codelore.openWorkspace',
					draft: 'codelore.openWorkspace',
					copy: 'codelore.copyLatestDraft',
				};
				const view = message.command === 'reflect' ? 'today' : 'drafts';
				await vscode.commands.executeCommand(commands[message.command], view);
			}
		});

		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.view) {
			return;
		}

		const connectionId = await this.context.secrets.get('codelore.linkedinConnectionId');

		try {
			const status = connectionId
				? await getLinkedInStatus(connectionId)
				: {connected: false};
			this.view.webview.postMessage({type: 'linkedinStatus', ...status});
		} catch (error) {
			console.error('Error refreshing CodeLore profile:', error);
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
	.privacy { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin-top: 24px; }
</style>
</head>
<body>
	<h1>CodeLore</h1>
	<p class="subtitle">Turn today’s work into a story worth sharing.</p>

	<p class="section">Publishing</p>
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

	<p class="section">Today</p>
	<div class="actions">
		<button data-command="reflect">Reflect on today</button>
		<button data-command="draft">Draft a post</button>
		<button data-command="copy">Copy latest draft</button>
	</div>

	<p class="privacy">Your work stays local until you choose to publish.</p>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const button = document.getElementById('linkedin-button');
	const title = document.getElementById('linkedin-title');
	const copy = document.getElementById('linkedin-copy');
	const mark = document.getElementById('linkedin-mark');

	button.addEventListener('click', () => vscode.postMessage({command: 'connectLinkedIn'}));
	document.querySelectorAll('[data-command]').forEach((item) => {
		item.addEventListener('click', () => vscode.postMessage({command: item.dataset.command}));
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
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

class CodeLoreWorkspacePanel {
	private panel: vscode.WebviewPanel | undefined;
	private activeView: 'today' | 'drafts' | 'publish' = 'today';

	constructor(private readonly context: vscode.ExtensionContext) {}

	open(view: 'today' | 'drafts' | 'publish' = 'today'): void {
		this.activeView = view;
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			void this.panel.webview.postMessage({type: 'navigate', view});
			void this.refresh();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'codelore.workspace',
			'CodeLore',
			vscode.ViewColumn.Active,
			{enableScripts: true, retainContextWhenHidden: true},
		);
		this.panel.webview.html = this.getHtml(this.panel.webview);
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
		this.panel.webview.onDidReceiveMessage(async (message: {command: string; value?: string}) => {
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

				await this.context.workspaceState.update('codelore.latestReflection', reflection);
				await this.refresh('Reflection saved.');
				return;
			}

			if (message.command === 'generateDraft') {
				const reflection = this.context.workspaceState.get<string>('codelore.latestReflection');
				if (!reflection) {
					await this.postStatus('Add a reflection first.');
					return;
				}

				await this.postStatus('Writing your LinkedIn draft...');
				const latestCommitMessage = await getLatestCommitMessage();
				const fallbackDraft = [
					latestCommitMessage
						? `Today I worked on ${latestCommitMessage}`
						: 'Today I learned something while building:',
					'',
					reflection,
					'',
					'#buildinpublic #devjourney #CodeLore',
				].join('\n');

				try {
					const draft = await generateAiPostDraft(reflection, 'linkedin', latestCommitMessage) ?? fallbackDraft;
					await this.context.workspaceState.update('codelore.latestDraft', draft);
					await this.refresh('Draft ready for your review.');
				} catch (error) {
					console.error('Error generating CodeLore draft:', error);
					await this.context.workspaceState.update('codelore.latestDraft', fallbackDraft);
					await this.refresh('Copilot was unavailable, so CodeLore made a simple draft.');
				}
				return;
			}

			if (message.command === 'saveDraft') {
				await this.context.workspaceState.update('codelore.latestDraft', message.value?.trim() ?? '');
				await this.refresh('Draft saved.');
				return;
			}

			if (message.command === 'copyDraft') {
				const draft = this.context.workspaceState.get<string>('codelore.latestDraft');
				if (!draft) {
					await this.postStatus('Create a draft before copying it.');
					return;
				}

				await vscode.env.clipboard.writeText(draft);
				await this.postStatus('Draft copied to your clipboard.');
			}
		});

	}

	private async refresh(status?: string): Promise<void> {
		if (!this.panel) {
			return;
		}

		await this.panel.webview.postMessage({
			type: 'state',
			reflection: this.context.workspaceState.get<string>('codelore.latestReflection') ?? '',
			draft: this.context.workspaceState.get<string>('codelore.latestDraft') ?? '',
			status,
		});
	}

	private async postStatus(status: string): Promise<void> {
		if (this.panel) {
			await this.panel.webview.postMessage({type: 'status', status});
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = randomUUID();
		return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); margin: 0; }
	.app { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: 100vh; }
	.sidebar { background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-panel-border); box-sizing: border-box; padding: 22px 12px; }
	.brand { font-size: 15px; font-weight: 600; margin: 0 0 20px 8px; }
	.nav { background: transparent; border: 0; color: var(--vscode-sideBar-foreground); cursor: pointer; font: inherit; padding: 9px 10px; text-align: left; width: 100%; }
	.nav.active, .nav:hover { background: var(--vscode-list-hoverBackground); border-radius: 4px; }
	main { box-sizing: border-box; display: flex; flex-direction: column; max-width: 860px; min-height: 100vh; padding: 48px; }
	.view { display: none; flex: 1; } .view.active { display: block; }
	h1 { font-size: 26px; font-weight: 600; margin: 0 0 8px; }
	p { color: var(--vscode-descriptionForeground); line-height: 1.55; margin: 0 0 22px; }
	textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; box-sizing: border-box; color: var(--vscode-input-foreground); font: 14px/1.55 var(--vscode-font-family); min-height: 220px; padding: 14px; resize: vertical; width: 100%; }
	textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
	.primary { align-self: flex-end; background: var(--vscode-button-background); border: 0; border-radius: 5px; color: var(--vscode-button-foreground); cursor: pointer; font: inherit; margin-top: 16px; padding: 9px 14px; }
	.primary:hover { background: var(--vscode-button-hoverBackground); }
	.secondary { background: var(--vscode-button-secondaryBackground); border: 0; border-radius: 5px; color: var(--vscode-button-secondaryForeground); cursor: pointer; font: inherit; margin: 16px 8px 0 0; padding: 9px 14px; }
	.footer { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 16px; min-height: 18px; }
	.empty { border: 1px dashed var(--vscode-editorWidget-border); border-radius: 8px; color: var(--vscode-descriptionForeground); padding: 24px; }
	@media (max-width: 560px) { .app { grid-template-columns: 1fr; } .sidebar { border-bottom: 1px solid var(--vscode-panel-border); border-right: 0; display: flex; gap: 6px; padding: 10px; } .brand { display: none; } .nav { width: auto; } main { padding: 28px 20px; } }
</style></head>
<body><div class="app"><aside class="sidebar"><div class="brand">CodeLore</div><button class="nav active" data-view="today">Today</button><button class="nav" data-view="drafts">Drafts</button><button class="nav" data-view="publish">Publish</button></aside>
<main>
	<section class="view active" id="today"><h1>Reflect on today</h1><p>Capture what you built, learned, or got unstuck on. It stays local until you decide to share it.</p><textarea id="reflection" placeholder="Today I learned..."></textarea><button class="primary" id="save-reflection">Save reflection</button></section>
	<section class="view" id="drafts"><h1>Draft your LinkedIn post</h1><p>CodeLore uses your reflection and latest commit message to make a thoughtful first draft.</p><textarea id="draft" placeholder="Your draft will appear here."></textarea><button class="primary" id="generate-draft">Generate draft</button><button class="secondary" id="save-draft">Save changes</button><button class="secondary" id="copy-draft">Copy draft</button></section>
	<section class="view" id="publish"><h1>Review before you publish</h1><p>Publishing will always show your exact final draft and require one clear confirmation. Nothing posts automatically.</p><div class="empty">Your LinkedIn publishing step is next.</div></section>
	<div class="footer" id="status"></div>
</main></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const reflection = document.getElementById('reflection'); const draft = document.getElementById('draft'); const status = document.getElementById('status');
	function showView(view) { document.querySelectorAll('.view').forEach(item => item.classList.toggle('active', item.id === view)); document.querySelectorAll('.nav').forEach(item => item.classList.toggle('active', item.dataset.view === view)); }
	document.querySelectorAll('.nav').forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
	document.getElementById('save-reflection').addEventListener('click', () => vscode.postMessage({command: 'saveReflection', value: reflection.value}));
	document.getElementById('generate-draft').addEventListener('click', () => vscode.postMessage({command: 'generateDraft'}));
	document.getElementById('save-draft').addEventListener('click', () => vscode.postMessage({command: 'saveDraft', value: draft.value}));
	document.getElementById('copy-draft').addEventListener('click', () => vscode.postMessage({command: 'copyDraft'}));
	window.addEventListener('message', event => { const message = event.data; if (message.type === 'state') { reflection.value = message.reflection || ''; draft.value = message.draft || ''; status.textContent = message.status || ''; } if (message.type === 'status') status.textContent = message.status; if (message.type === 'navigate') showView(message.view); });
	vscode.postMessage({command: 'ready'});
</script></body></html>`;
	}
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const codeloreViewProvider = new CodeLoreViewProvider(context);
	const codeloreWorkspacePanel = new CodeLoreWorkspacePanel(context);

	context.subscriptions.push(
	vscode.window.registerWebviewViewProvider(
		'codelore.today',
		codeloreViewProvider,
	),
);

	const openWorkspace = vscode.commands.registerCommand(
		'codelore.openWorkspace',
		(view?: 'today' | 'drafts' | 'publish') => {
			codeloreWorkspacePanel.open(view);
		},
	);

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "codelore" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand(
		'codelore.reflectOnToday',
		async () => {
			const reflection = await vscode.window.showInputBox({
				prompt: 'What did you learn, build or get unstuck today?',
				placeHolder: 'I learned how to use the VS Code API to create an extension!',
				ignoreFocusOut: true,
			});

			if (!reflection?.trim()) {
				return;
			}

			await context.workspaceState.update('codelore.latestReflection', reflection.trim());

			vscode.window.showInformationMessage('Your reflection has been saved. Nice work!');
		},
	);

	const viewLatestReflection = vscode.commands.registerCommand(
		'codelore.viewLatestReflection',
		async () => {
			const reflection = context.workspaceState.get<string>('codelore.latestReflection');

			if (!reflection) {
				vscode.window.showInformationMessage('No reflection yet. Start with CodeLore: Reflect on Today.');
				return;
			}

			vscode.window.showInformationMessage(`Your latest reflection: ${reflection}`);
		},
	);


	const copyLatestDraft = vscode.commands.registerCommand(
		'codelore.copyLatestDraft',
		async () => {
			const draft = context.workspaceState.get<string>('codelore.latestDraft');

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
		'codelore.connectLinkedIn',
		async () => {
			let connectionId = await context.secrets.get('codelore.linkedinConnectionId');

			if (!connectionId) {
				connectionId = randomUUID();
				await context.secrets.store('codelore.linkedinConnectionId', connectionId);
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
				vscode.window.showInformationMessage('LinkedIn is connected to CodeLore.');
				return;
			}

			vscode.window.showInformationMessage(
				'LinkedIn is still waiting for approval. You can try connecting again whenever you are ready.',
			);
		},
	);

	const checkLinkedInConnection = vscode.commands.registerCommand(
		'codelore.checkLinkedInConnection',
		async () => {
			const connectionId = await context.secrets.get('codelore.linkedinConnectionId');

			if (!connectionId) {
				vscode.window.showInformationMessage(
					'LinkedIn is not connected yet. Start with CodeLore: Connect LinkedIn.',
				);
				return;
			}

			try {
				if (await isLinkedInConnected(connectionId)) {
					vscode.window.showInformationMessage('LinkedIn is connected to CodeLore.');
					return;
				}

				vscode.window.showInformationMessage(
					'LinkedIn is not connected yet. Run CodeLore: Connect LinkedIn to try again.',
				);
			} catch (error) {
				console.error('Error checking LinkedIn connection:', error);
				vscode.window.showErrorMessage('CodeLore could not check LinkedIn right now.');
			}
		},
	);

	const draftPostFromLatestReflection = vscode.commands.registerCommand(
		'codelore.draftPostFromLatestReflection',
		async () => {
			const reflection = context.workspaceState.get<string>('codelore.latestReflection');

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
					placeHolder: 'What should CodeLore use for this draft?',
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

			const latestCommitMessage =
			contextChoice.id === 'latestCommit'
			? await getLatestCommitMessage()
			: undefined;

			const fallbackDraft = [
				latestCommitMessage
				? `Today I worked on ${latestCommitMessage}`
				: 'Today I learned something while building:',
				'',
				reflection,
				'',
				'#buildinpublic #devjourney #CodeLore',
			].join('\n');

			let draft = fallbackDraft;

			try {
				const aiDraft = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'CodeLore is writing your draft...',
					},
					() => generateAiPostDraft(reflection, platform, latestCommitMessage),
				);

				if (aiDraft) {
					draft = aiDraft;
				} else {
					vscode.window.showInformationMessage(
						'Copilot is unavailable, so CodeLore used a simple draft instead.',
					);
				};

			} catch (error) {
				console.error('Error generating CodeLore draft:', error)


			vscode.window.showInformationMessage(
				'CodeLore used a simple draft because Copilot couldnt respond.',
			);
		}


			await context.workspaceState.update('codelore.latestDraft', draft);

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
