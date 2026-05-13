import { describe, expect, it, vi, beforeEach } from "vitest";

const mockCreateProposal = vi.hoisted(() => vi.fn());

vi.mock("@/services/proposal.service", () => ({
  createProposal: (...args: unknown[]) => mockCreateProposal(...args),
}));

import {
  buildSpecKitDocumentDrafts,
  buildSpecKitTaskDrafts,
  importSpecKitFeature,
} from "@/services/spec-kit.service";
import { parseSpecKitTasksMarkdown } from "@/lib/spec-kit";

const LONG_DOC = "Spec Kit document content. ".repeat(10);
const TASKS_MD = `# Tasks

## Phase 1: Setup

- [ ] T001 Create project structure
- [ ] T002 Implement service in src/service.ts (depends on T001)
`;

describe("spec-kit.service", () => {
  beforeEach(() => {
    mockCreateProposal.mockReset();
  });

  it("maps Spec Kit documents to Chorus document drafts", () => {
    const drafts = buildSpecKitDocumentDrafts("specs/001-login", {
      specMd: "spec",
      planMd: "plan",
      dataModelMd: "model",
      contracts: [{ path: "contracts/openapi.yaml", content: "openapi" }],
    });

    expect(drafts.map((draft) => [draft.type, draft.title])).toEqual([
      ["prd", "Spec Kit Spec: 001-login"],
      ["tech_design", "Spec Kit Plan: 001-login"],
      ["spec", "Spec Kit Data Model: 001-login"],
      ["spec", "Spec Kit Contract: openapi.yaml"],
    ]);
  });

  it("translates Spec Kit task ids to draft dependencies", () => {
    const parsed = parseSpecKitTasksMarkdown(TASKS_MD, "specs/001-login/tasks.md");
    const { taskDrafts, taskIdToDraftUuid } = buildSpecKitTaskDrafts(parsed);

    expect(taskDrafts).toHaveLength(2);
    expect(taskDrafts[1].dependsOnDraftUuids).toEqual([taskIdToDraftUuid.T001]);
  });

  it("creates a native speckit proposal with provenance", async () => {
    mockCreateProposal.mockResolvedValue({
      uuid: "proposal-1",
      status: "draft",
      documentDrafts: [],
      taskDrafts: [],
    });

    await importSpecKitFeature({
      companyUuid: "company-1",
      projectUuid: "project-1",
      title: "Login",
      description: "Import login feature",
      featureDir: "specs/001-login",
      documents: { specMd: LONG_DOC, planMd: LONG_DOC },
      tasksMarkdown: TASKS_MD,
      createdByUuid: "agent-1",
      createdByType: "agent",
    });

    expect(mockCreateProposal).toHaveBeenCalledWith(expect.objectContaining({
      inputType: "speckit",
      inputUuids: [],
      description: "Import login feature\n\nSpec Kit feature dir: specs/001-login",
      documentDrafts: expect.arrayContaining([
        expect.objectContaining({ type: "prd" }),
        expect.objectContaining({ type: "tech_design" }),
      ]),
      taskDrafts: expect.arrayContaining([
        expect.objectContaining({ title: "[T001] Create project structure" }),
        expect.objectContaining({ title: "[T002] Implement service in src/service.ts" }),
      ]),
    }));
  });
});
