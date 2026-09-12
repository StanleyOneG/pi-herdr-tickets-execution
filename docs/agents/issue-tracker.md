# Issue tracker: GitHub

Issues and specs live in GitHub Issues for
`StanleyOneG/pi-herdr-tickets-execution`. Use the `gh` CLI.
Inside this clone, `gh` infers the repo from the git remote.

## Issue operations

- Create: `gh issue create --title "..." --body-file -`, supplying a heredoc for multiline bodies.
- Read with labels and comments: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`. Add label filters as needed.
- Comment: `gh issue comment <number> --body "..."`.
- Apply labels: `gh issue edit <number> --add-label "..."`.
- Remove labels: `gh issue edit <number> --remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests

PRs as a request surface: no.

GitHub shares numbering between issues and PRs. For an ambiguous
reference such as #42, try `gh pr view 42`, then `gh issue view 42`.

## Wayfinding operations

Used by `/wayfinder`.

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: link an issue to the map using GitHub sub-issues
  through `gh api`. If unavailable, use a task list in the map
  and put `Part of #<map>` at the top of the child body.
  Use `wayfinder:<type>` labels with research, prototype, grilling,
  or task as the type.
- Blocking: use native GitHub issue dependencies:
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Get the numeric database ID with
  `gh api repos/<owner>/<repo>/issues/<n> --jq .id`.
  If dependencies are unavailable, put
  `Blocked by: #<n>, #<n>` at the top of the child body.
- Frontier: inspect the map's open children in map order.
  Skip assigned tickets and tickets with open blockers.
  For native dependencies, check
  `issue_dependencies_summary.blocked_by`; for the fallback,
  check whether the referenced blockers are closed.
  Choose the first remaining ticket.
- Claim: `gh issue edit <n> --add-assignee @me`,
  as the session's first write.
- Resolve: comment with the answer, close the ticket, and append
  a context pointer with a gist link to the map's Decisions-so-far.
