import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/spec-kit-repo.service", () => ({
  adapterTarget: vi.fn(() => "local-target"),
  getSpecKitRepoAdapter: vi.fn(),
  upsertSpecKitFile: vi.fn(),
}));

import {
  assignSpecKitTaskIds,
  buildSpecKitFeatureFiles,
  buildSpecKitTasksMarkdown,
} from "@/services/spec-kit-generate.service";
import type { DocumentDraft, TaskDraft } from "@/services/proposal.service";

describe("spec-kit-generate.service", () => {
  it("assigns Spec Kit task ids without changing visible titles", () => {
    const drafts: TaskDraft[] = [
      {
        uuid: "draft-1",
        title: "Create auth table",
        description: "Create schema",
        storyPoints: 2,
      },
      {
        uuid: "draft-2",
        title: "Implement login",
        description: "Build endpoint",
        storyPoints: 1,
        dependsOnDraftUuids: ["draft-1"],
      },
    ];

    const result = assignSpecKitTaskIds(drafts);

    expect(result.taskIdByDraftUuid).toEqual({ "draft-1": "T001", "draft-2": "T002" });
    expect(result.taskDrafts[0].title).toBe("Create auth table");
    expect(result.taskDrafts[0].description).toContain("Spec Kit task: T001");
    expect(result.taskDrafts[1].description).toContain("Spec Kit task: T002");
  });

  it("builds tasks.md with dependencies", () => {
    const tasksMarkdown = buildSpecKitTasksMarkdown({
      proposalTitle: "Authentication",
      proposalUuid: "proposal-1",
      featureDir: "specs/001-auth",
      taskIdByDraftUuid: { "draft-1": "T001", "draft-2": "T002" },
      taskDrafts: [
        { uuid: "draft-1", title: "Create auth table" },
        { uuid: "draft-2", title: "Implement login", dependsOnDraftUuids: ["draft-1"] },
      ],
    });

    expect(tasksMarkdown).toContain("# Tasks: Authentication");
    expect(tasksMarkdown).toContain("- [ ] T001 Create auth table");
    expect(tasksMarkdown).toContain("- [ ] T002 Implement login (depends on T001)");
  });

  it("builds Spec Kit files from Chorus document and task drafts", () => {
    const documentDrafts: DocumentDraft[] = [
      { uuid: "doc-1", type: "prd", title: "Auth PRD", content: "Users can sign in with email." },
      { uuid: "doc-2", type: "tech_design", title: "Auth Plan", content: "Use existing API routes." },
    ];
    const taskDrafts: TaskDraft[] = [{ uuid: "draft-1", title: "Implement login" }];
    const files = buildSpecKitFeatureFiles({
      proposal: {
        uuid: "proposal-1",
        companyUuid: "company-1",
        projectUuid: "project-1",
        title: "Authentication",
        description: "Login feature",
        status: "draft",
        documentDrafts,
        taskDrafts,
      },
      featureDir: "specs/001-auth",
      documentDrafts,
      taskDrafts,
      taskIdByDraftUuid: { "draft-1": "T001" },
    });

    expect(files.map((file) => file.path)).toEqual([
      "specs/001-auth/spec.md",
      "specs/001-auth/plan.md",
      "specs/001-auth/tasks.md",
    ]);
    expect(files[0].content).toContain("# Auth PRD");
    expect(files[1].content).toContain("# Auth Plan");
    expect(files[2].content).toContain("- [ ] T001 Implement login");
  });
});
