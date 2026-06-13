# Part M1 Live Demo Step 1

What I did: ran the M1 one-sitting live demo against a fresh scratch SQLite DB through the bearer-protected Next API.

Files modified: none in production.

Runtime:

- App: `next dev --webpack --hostname 127.0.0.1 --port 3124`
- Base URL: `http://127.0.0.1:3124`
- DB: `.ai/tmp/m1-live-demo/m1-live-demo-20260613-163938.db`
- Vault adapter: `holly-vault`
- Vault root: local Holly dataset path, read by runtime only.
- Token: local demo bearer token, not committed.

Checks:

```json
{
  "ingest": {
    "status": 200,
    "sourcesSeen": 525,
    "sourcesProcessed": 525,
    "sourcesFailed": 0,
    "chunksCreated": 4408,
    "conceptsCreated": 2141,
    "pagesCreated": 2141
  },
  "plan": {
    "status": 200,
    "date": "2026-06-13",
    "queueLength": 6423,
    "firstQuiz": {
      "conceptSlug": "moonshot-ai",
      "conceptName": "Moonshot AI"
    },
    "firstTeachback": {
      "conceptSlug": "moonshot-ai",
      "conceptName": "Moonshot AI"
    }
  },
  "quiz": {
    "status": 200,
    "conceptSlug": "moonshot-ai",
    "verdict": "correct",
    "masteryDelta": 0.1,
    "beforeScore": null,
    "afterScore": 0.22
  },
  "teachback": {
    "status": 200,
    "conceptSlug": "moonshot-ai",
    "score": 1,
    "gapsCount": 0,
    "masteryDelta": 0.12,
    "afterScore": 0.22,
    "pageId": 861
  },
  "mastery": {
    "status": 200,
    "rows": 1,
    "quizConceptChanged": true,
    "teachbackConceptPresent": true
  }
}
```

Public page promotion was intentionally narrow:

- promoted page id: `861`
- private control page id: `1`
- promoted concept: `moonshot-ai`
- page version: `1`
- citation count: `1`
- first citation resolved to a chunk and source through the local DB.
- committed evidence redacts the source title, doc ref, and chunk text to avoid publishing Holly dataset content.

Test status: passing.

Next step: record browser render smoke and current section 0 frozen-repo status.
