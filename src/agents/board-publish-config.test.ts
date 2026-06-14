import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { validateBoardPublishConfig } from "./board-publish-config.js";

const projectRoot = process.cwd();
const liveClientWarning =
  "board publish config is an offline candidate; agent-day --live currently uses explicit endpoint flags and built-in Multica issue/comment payloads rather than reading this config file.";

interface BoardPublishConfigFixture {
  readonly actions: {
    readonly create_task: {
      readonly payload: {
        readonly priority?: unknown;
      };
    };
  };
}

describe("M2 board publish config", () => {
  test("checked-in example defines the inferred Multica publish contract", async () => {
    const config = JSON.parse(await readProjectFile("config/multica/board-publish.example.json")) as unknown;

    const result = validateBoardPublishConfig(config);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([liveClientWarning]);
    expect(result.summary).toEqual({
      contractStatus: "inferred_live_smoke_pending",
      apiBaseUrl: "http://127.0.0.1:8080",
      appBaseUrl: "http://127.0.0.1:3000",
      workspaceSlug: "daily-plan",
      actions: ["create_task", "add_comment"],
      commentRequiresIssueId: true
    });
    expect((config as BoardPublishConfigFixture).actions.create_task.payload.priority).toBe("medium");
  });

  test("rejects secrets, filesystem paths, and non-http endpoints", () => {
    const result = validateBoardPublishConfig({
      contractStatus: "inferred_live_smoke_pending",
      apiBaseUrl: "file:///G:/multica-ai-multica-https-github-com/api?token=real-token",
      appBaseUrl: "https://user:real-secret@example.com/app",
      workspace: {
        slug: "/home/holly/multica",
        id: "Bearer real-token"
      },
      actions: {
        create_task: {
          method: "POST",
          endpointUrl: "http://127.0.0.1:8080/api/issues?token=real-token",
          payload: {
            title: "$action.title",
            description: "$action.body"
          }
        },
        add_comment: {
          method: "POST",
          endpointTemplate: "G:\\multica-ai-multica-https-github-com\\comments",
          payload: {
            content: "$action.body"
          }
        }
      }
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "board publish config apiBaseUrl must be an http or https URL.",
        "board publish config appBaseUrl must not include URL credentials.",
        "board publish config actions.add_comment.endpointTemplate must be an http or https URL.",
        "board publish config must not contain secret-like value at apiBaseUrl.",
        "board publish config must not contain filesystem-like value at apiBaseUrl.",
        "board publish config must not contain secret-like value at appBaseUrl.",
        "board publish config must not contain filesystem-like value at workspace.slug.",
        "board publish config must not contain secret-like value at workspace.id.",
        "board publish config must not contain secret-like value at actions.create_task.endpointUrl.",
        "board publish config must not contain filesystem-like value at actions.add_comment.endpointTemplate."
      ])
    );
  });

  test("rejects missing actions and comment templates without an issue id placeholder", () => {
    const result = validateBoardPublishConfig({
      contractStatus: "inferred_live_smoke_pending",
      apiBaseUrl: "http://127.0.0.1:8080",
      appBaseUrl: "http://127.0.0.1:3000",
      workspace: {
        slug: "daily-plan",
        id: ""
      },
      actions: {
        create_task: {
          method: "GET",
          endpointUrl: "http://127.0.0.1:8080/api/issues",
          payload: {
            title: "$action.title"
          }
        },
        add_comment: {
          method: "POST",
          endpointTemplate: "http://127.0.0.1:8080/api/issues/comments",
          payload: {
            content: "$action.body"
          }
        }
      }
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "board publish config actions.create_task.method must be POST.",
        "board publish config actions.create_task.payload.description must be $action.body.",
        "board publish config actions.add_comment.endpointTemplate must include {issueId}."
      ])
    );
  });

  test("rejects unsupported Multica issue and comment payload constants", () => {
    const result = validateBoardPublishConfig({
      contractStatus: "inferred_live_smoke_pending",
      apiBaseUrl: "http://127.0.0.1:8080",
      appBaseUrl: "http://127.0.0.1:3000",
      workspace: {
        slug: "daily-plan",
        id: ""
      },
      actions: {
        create_task: {
          method: "POST",
          endpointUrl: "http://127.0.0.1:8080/api/issues",
          payload: {
            title: "$action.title",
            description: "$action.body",
            status: "doing",
            priority: "normal"
          }
        },
        add_comment: {
          method: "POST",
          endpointTemplate: "http://127.0.0.1:8080/api/issues/{issueId}/comments",
          payload: {
            content: "$action.body",
            type: "status"
          }
        }
      }
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "board publish config actions.create_task.payload.status must be todo when present.",
        "board publish config actions.create_task.payload.priority must be one of none, low, medium, high, urgent when present.",
        "board publish config actions.add_comment.payload.type must be comment when present."
      ])
    );
  });

  test.each([
    ["array priority", ["medium"]],
    ["object priority", { value: "medium" }]
  ])("rejects non-string create_task payload priority: %s", (_label, priority) => {
    const result = validateBoardPublishConfig({
      contractStatus: "inferred_live_smoke_pending",
      apiBaseUrl: "http://127.0.0.1:8080",
      appBaseUrl: "http://127.0.0.1:3000",
      workspace: {
        slug: "daily-plan",
        id: ""
      },
      actions: {
        create_task: {
          method: "POST",
          endpointUrl: "http://127.0.0.1:8080/api/issues",
          payload: {
            title: "$action.title",
            description: "$action.body",
            priority
          }
        },
        add_comment: {
          method: "POST",
          endpointTemplate: "http://127.0.0.1:8080/api/issues/{issueId}/comments",
          payload: {
            content: "$action.body"
          }
        }
      }
    });

    expect(result.errors).toContain(
      "board publish config actions.create_task.payload.priority must be one of none, low, medium, high, urgent when present."
    );
  });
});

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}
