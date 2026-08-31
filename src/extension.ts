
import * as vscode from 'vscode';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);


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


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

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
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
