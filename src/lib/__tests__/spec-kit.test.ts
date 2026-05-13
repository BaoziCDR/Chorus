import { describe, expect, it } from "vitest";
import {
  appendSpecKitFeatureProvenance,
  defaultSpecKitFeatureDir,
  extractSpecKitFeatureDir,
  extractSpecKitTaskId,
  parseSpecKitTasksMarkdown,
} from "@/lib/spec-kit";

const TASKS_MD = `# Tasks

## Phase 1: Setup

- [ ] T001 Create project structure per implementation plan
- [ ] T002 [P] Add config in \`src/config.ts\`

## Phase 2: User Story 1 - Login (Priority: P1)

- [ ] T003 [US1] Implement login API in src/app/api/login/route.ts
- [ ] T004 [US1] Add login tests in src/app/api/login/route.test.ts (depends on T003)
`;

describe("parseSpecKitTasksMarkdown", () => {
  it("parses task ids, paths, priorities, and dependencies", () => {
    const result = parseSpecKitTasksMarkdown(TASKS_MD, "specs/001-login/tasks.md");

    expect(result.count).toBe(4);
    expect(result.warnings).toEqual([]);
    expect(result.tasks[1]).toMatchObject({
      taskId: "T002",
      parallel: true,
      paths: ["src/config.ts"],
      storyPoints: 1,
    });
    expect(result.tasks[2]).toMatchObject({
      taskId: "T003",
      story: "US1",
      priority: "high",
      dependsOnTaskIds: ["T002"],
    });
    expect(result.tasks[3]).toMatchObject({
      taskId: "T004",
      dependsOnTaskIds: ["T003"],
    });
  });

  it("reports a warning when no tasks match", () => {
    const result = parseSpecKitTasksMarkdown("# Empty", "tasks.md");

    expect(result.count).toBe(0);
    expect(result.warnings[0]).toContain("No Spec Kit task lines matched");
  });

  it("handles native Chorus provenance helpers", () => {
    const description = appendSpecKitFeatureProvenance("Summary", "specs/001-login");

    expect(description).toContain("Spec Kit feature dir: specs/001-login");
    expect(extractSpecKitFeatureDir(description)).toBe("specs/001-login");
    expect(extractSpecKitFeatureDir("Spec Kit feature dir: ../unsafe")).toBeNull();
    expect(extractSpecKitTaskId("Implement login", "Spec Kit task: T012")).toBe("T012");
    expect(defaultSpecKitFeatureDir("proposal-12345678-aaaa", "Login Flow!")).toBe("specs/chorus-proposal-login-flow");
  });
});
