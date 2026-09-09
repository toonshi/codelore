# LoreCode MCP server

This local MCP server brings LoreCode's grounded Git context and post-writing
guardrails to Claude Code and other MCP hosts. It does not publish anything and
does not call a model itself: the connected host creates the final wording.

## Run locally

```bash
cd apps/mcp
npm install
npm run start
```

The server uses standard input/output, so do not print logs to standard output.

## Claude Code configuration

Add a project-scoped MCP server entry that starts from this repository:

```json
{
  "mcpServers": {
    "lorecode": {
      "command": "npm",
      "args": ["run", "start", "--prefix", "/absolute/path/to/codelore/apps/mcp"]
    }
  }
}
```

Restart Claude Code, then ask it to use `lorecode_collect_git_context` before
drafting an update. Pass an absolute repository path to the Git tools.

## Tools

- `lorecode_list_recent_commits`
- `lorecode_collect_git_context`
- `lorecode_create_post_prompt`
- `lorecode_check_post`

The server reads only the repository path supplied to a Git tool. It does not
upload source code or publish to social platforms.
