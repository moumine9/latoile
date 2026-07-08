# latoile

## Intermediary layer: GitLab + Jira context for LLMs

This repository now defines a minimal **Context Bridge** between:
- **GitLab**: merge requests, branches, commits
- **Jira**: tasks, subtasks, bugs, Confluence documentation links

The goal is to provide one normalized payload that an LLM can consume without querying both systems independently.

### Unified context model

```json
{
  "work_item": {
    "id": "JIRA-123",
    "type": "task|subtask|bug",
    "title": "Short summary",
    "status": "In Progress",
    "assignee": "user",
    "parent_id": "JIRA-100"
  },
  "gitlab": {
    "merge_request": {
      "id": 42,
      "title": "feat: improve checkout validation",
      "state": "opened",
      "source_branch": "feature/JIRA-123-checkout-validation",
      "target_branch": "main",
      "url": "https://gitlab.example.com/group/project/-/merge_requests/42"
    },
    "branch": {
      "name": "feature/JIRA-123-checkout-validation",
      "last_commit_sha": "abc123..."
    },
    "commits": [
      {
        "sha": "abc123...",
        "title": "feat: add checkout guard",
        "author": "user",
        "timestamp": "2026-07-08T10:00:00Z"
      }
    ]
  },
  "documentation": [
    {
      "source": "confluence",
      "title": "Checkout validation design",
      "url": "https://confluence.example.com/display/TEAM/Checkout+Validation"
    }
  ],
  "traceability": {
    "links": [
      {
        "jira_key": "JIRA-123",
        "merge_request_id": 42,
        "commit_sha": "abc123..."
      }
    ]
  }
}
```

### Minimal bridge behavior

1. Resolve Jira issue (`task/subtask/bug`) and parent relationships.
2. Resolve GitLab branch, commits, and merge request related to the Jira key.
3. Attach relevant Confluence links.
4. Output one normalized JSON context object (example above) for LLM prompts.

### Suggested linking rules

- Branch names should include the Jira key (`feature/JIRA-123-*`).
- Merge request title/description should include the Jira key.
- Commit messages should include the Jira key when possible.
- Confluence links should be attached through Jira issue links or labels.
