# part-m2-multica-issue-payload step 1

## Changes

- Updated the live HTTP board client to post built-in Multica issue payloads for `create_task`:
  - `title`: redacted action title
  - `description`: redacted action body
  - `status`: `todo`
  - `priority`: `medium`
- Updated the live HTTP board client to post built-in Multica comment payloads for `add_comment`:
  - `content`: redacted action body
  - `type`: `comment`
- Kept explicit endpoint URL selection, safe HTTP URL validation, response id/url parsing, and redaction behavior.
- Updated board publish config validation:
  - `create_task.payload.title` remains `$action.title`.
  - `create_task.payload.description` remains `$action.body`.
  - Optional `status` must be `todo`.
  - Optional `priority` must be one of `none`, `low`, `medium`, `high`, `urgent`; `normal` is rejected.
  - `add_comment.payload.content` remains `$action.body`.
  - Optional `type` must be `comment`.
- Updated `config/multica/board-publish.example.json` priority from `normal` to `medium`.
- Updated offline config warning text to say live mode still uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading the config file.

## Test Status

RED:

```powershell
npm run test:unit -- src/agents/http-clients.test.ts src/agents/board-publish-config.test.ts src/cli/kl.test.ts
```

Result: failed as expected. 3 test files failed, 7 tests failed, 106 tests passed. Failures covered the old internal board payload, the old warning text, and missing Multica payload constant validation.

GREEN:

```powershell
npm run test:unit -- src/agents/http-clients.test.ts src/agents/board-publish-config.test.ts src/cli/kl.test.ts
```

Result: passed. 3 test files passed, 113 tests passed.

## Next Step

- Run final verification and review the diff before the coordinator uploads this slice to GitHub.
