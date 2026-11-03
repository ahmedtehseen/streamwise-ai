# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at
`ahmedtehseen/streamwise-ai`. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Add a label: `gh issue edit <number> --add-label "..."`
- Remove a label: `gh issue edit <number> --remove-label "..."`
- Close: explain the outcome in a comment, then run `gh issue close <number>`.
- Use GitHub sub-issues and native issue dependencies when supported.
- If native dependencies are unavailable, record `Blocked by: #<number>` at
  the beginning of the issue body.

Infer the repository from the configured Git remote. Before creating an issue,
verify the destination with:

`gh repo view --json nameWithOwner`

Only create issues in `ahmedtehseen/streamwise-ai`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill terminology

When a skill says “publish to the issue tracker,” create a GitHub issue.

When a skill says “fetch the relevant ticket,” read the corresponding GitHub
issue, including its labels and comments.
