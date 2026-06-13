# Part M1 Live Demo Step 2

What I did: opened the live demo pages in the in-app browser against the same scratch DB and verified public/private rendering signals.

Files modified: none in production.

Browser checks:

```json
{
  "/learn": {
    "heading": "Knowledge Loop learning",
    "title": "Knowledge Loop",
    "values": {
      "statusLabel": true,
      "masteryLabel": true
    }
  },
  "/wiki": {
    "heading": "Public wiki",
    "title": "Knowledge Loop",
    "values": {
      "publicWiki": true,
      "publicTitle": true,
      "privateTitle": false
    }
  },
  "/wiki/861": {
    "heading": "Moonshot AI",
    "title": "Knowledge Loop",
    "values": {
      "publicTitle": true,
      "provenance": true,
      "sourceTitle": true,
      "docRef": true,
      "adapterId": true
    }
  },
  "/wiki/1": {
    "heading": "",
    "title": "Knowledge Loop",
    "values": {
      "privateTitle": false
    }
  }
}
```

HTTP status checks from the live demo runner:

```json
{
  "learn": { "status": 200 },
  "wiki": { "status": 200 },
  "publicDetail": { "status": 200 },
  "privateDetail": { "status": 404, "hidesPrivateTitle": true }
}
```

Notes:

- The browser-visible private detail page did not include the private control page title.
- The HTTP runner verified `/wiki/1` returned status `404`; the default 404 body did not contain a stable literal `404` string, so the committed browser assertion records privacy absence rather than 404 copy.
- No Holly source body text is committed in this checkpoint.

Test status: passing.

Next step: record the frozen repo status blocker separately from the live demo pass.
