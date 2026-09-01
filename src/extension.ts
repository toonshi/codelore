
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const apiBaseUrl = 'https://codelore-api.codelore.workers.dev';

async function isLinkedInConnected(connectionId: string): Promise<boolean> {
	const response = await fetch(
		`${apiBaseUrl}/auth/linkedin/status?connection_id=${encodeURIComponent(connectionId)}`,
	);
	const result = (await response.json()) as {connected: boolean};

	return response.ok && result.connected;
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


class CodeLoreViewProvider
	implements vscode.TreeDataProvider<vscode.TreeItem>
{
	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): vscode.TreeItem[] {
		return [
			this.createAction(
				'Connect LinkedIn',
				'codelore.connectLinkedIn',
				'link-external',
			),
			this.createAction(
				'Reflect on Today',
				'codelore.reflectOnToday',
				'comment',
			),
			this.createAction(
				'Draft Post',
				'codelore.draftPostFromLatestReflection',
				'megaphone',
			),
			this.createAction(
				'View Latest Reflection',
				'codelore.viewLatestReflection',
				'note',
			),
			this.createAction(
				'Copy Latest Draft',
				'codelore.copyLatestDraft',
				'copy',
			),
		];
	}

	private createAction(
		label: string,
		command: string,
		icon: string,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(label);

		item.command = {
			command,
			title: label,
		};

		item.iconPath = new vscode.ThemeIcon(icon);

		return item;
	}
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const codeloreViewProvider = new CodeLoreViewProvider();

	context.subscriptions.push(
	vscode.window.registerTreeDataProvider(
		'codelore.today',
		codeloreViewProvider,
	),
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
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
