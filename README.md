# CodeLore

Turn today’s work into a story worth sharing.

CodeLore is a VS Code extension for developers who build in public. It turns selected Git work and optional context into a few grounded post ideas, then gives you a calm place to refine, preview, and publish one to LinkedIn.

You own the final words. Nothing is published automatically.

## What it does

- Select the commits that belong to one story.
- Add a short note when the interesting part is not obvious from Git.
- Generate grounded story ideas such as a feature update, build log, problem solved, or lesson learned.
- Combine ideas into one story or save separate drafts.
- Edit, copy, preview, add an optional image, and publish to LinkedIn.
- Keep a local history of drafts and published posts.

## How it works

1. Open **CodeLore** from the Activity Bar and create a new post.
2. Choose the commits behind the work.
3. Add context if it helps, then select **Generate story ideas**.
4. Pick a direction, make it sound like you, then preview and publish.

When no note is provided, CodeLore stays conservative and generates a factual feature update or build log. Add a real problem, decision, or lesson to unlock richer story directions.

## Privacy and data

- Git context stays local until you explicitly generate ideas.
- For generation, CodeLore sends selected commit titles, changed file names, and high-level change summaries to the VS Code language model. It does not send raw source code or diffs.
- Your optional note and the text you choose to publish are sent only when you use the relevant action.
- LinkedIn publishing requires an explicit connection and final publish confirmation.
- LinkedIn connection references are stored with VS Code Secret Storage. You can disconnect at any time.

## Requirements

- VS Code `1.134.0` or later
- Git, for commit-based context
- GitHub Copilot Chat or another VS Code language-model provider, for story generation
- A LinkedIn account, only if you want to publish directly

## Develop locally

```bash
git clone https://github.com/toonshi/codelore.git
cd codelore
npm install
code .
```

Press `F5` in VS Code to start an Extension Development Host. Use **Developer: Reload Window** there after making changes.

Useful commands:

```bash
npm run compile
npm run test:unit
```

## Status

CodeLore is an early release. LinkedIn is supported today. X support is planned next.

## Contributing

Issues, ideas, and honest feedback are welcome. See the [roadmap](https://github.com/toonshi/codelore/projects) for what is coming next.

## License

[MIT](LICENSE)
