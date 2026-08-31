// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

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

			const draft = [
				'Today I learned something while building:',
				'',
				reflection,
				'',
				'Small lesson but one I will carry into the next thing I build.',
				'',
				'#buildinpublic #100DaysOfCode #CodeLore #devlife',
			].join('\n');

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
