# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues at `nardinmarcus/quickshare`. Use the `gh` CLI from this checkout so the repository is inferred from the configured remote.

## Conventions

- Create an issue with `gh issue create --title "..." --body-file <file>`.
- Read an issue and its comments with `gh issue view <number> --comments`.
- List issues with `gh issue list`, using state and label filters appropriate to the task.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill vocabulary

- When a skill says “publish to the issue tracker”, create a GitHub issue.
- When a skill says “fetch the relevant ticket”, read the GitHub issue including comments and labels.
