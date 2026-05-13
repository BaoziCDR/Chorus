import { randomUUID } from "crypto";
import {
  appendSpecKitFeatureProvenance,
  normalizeSpecKitFeatureDir,
  parseSpecKitTasksMarkdown,
  type SpecKitParseResult,
} from "@/lib/spec-kit";
import {
  createProposal,
  type DocumentDraftInput,
  type ProposalResponse,
  type TaskDraftInput,
} from "./proposal.service";

export interface SpecKitContractInput {
  path: string;
  content: string;
  title?: string;
}

export interface SpecKitDocumentsInput {
  specMd?: string;
  planMd?: string;
  researchMd?: string;
  dataModelMd?: string;
  quickstartMd?: string;
  contracts?: SpecKitContractInput[];
}

export interface ImportSpecKitFeatureParams {
  companyUuid: string;
  projectUuid: string;
  title: string;
  description?: string | null;
  featureDir: string;
  documents: SpecKitDocumentsInput;
  tasksMarkdown: string;
  createdByUuid: string;
  createdByType?: "agent" | "user";
}

export interface ImportSpecKitFeatureResult {
  proposal: ProposalResponse;
  featureDir: string;
  documentDraftCount: number;
  taskDraftCount: number;
  taskIdToDraftUuid: Record<string, string>;
  warnings: string[];
}

function nonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function contractTitle(contract: SpecKitContractInput): string {
  if (nonEmpty(contract.title)) return contract.title.trim();
  const normalizedPath = contract.path.trim().replace(/\\/g, "/");
  const filename = normalizedPath.split("/").filter(Boolean).pop();
  return `Spec Kit Contract: ${filename || normalizedPath || "contract"}`;
}

export function buildSpecKitDocumentDrafts(featureDir: string, documents: SpecKitDocumentsInput): DocumentDraftInput[] {
  const drafts: DocumentDraftInput[] = [];
  const feature = featureDir.split("/").filter(Boolean).pop() ?? featureDir;

  if (nonEmpty(documents.specMd)) {
    drafts.push({ type: "prd", title: `Spec Kit Spec: ${feature}`, content: documents.specMd });
  }
  if (nonEmpty(documents.planMd)) {
    drafts.push({ type: "tech_design", title: `Spec Kit Plan: ${feature}`, content: documents.planMd });
  }
  if (nonEmpty(documents.researchMd)) {
    drafts.push({ type: "adr", title: `Spec Kit Research: ${feature}`, content: documents.researchMd });
  }
  if (nonEmpty(documents.dataModelMd)) {
    drafts.push({ type: "spec", title: `Spec Kit Data Model: ${feature}`, content: documents.dataModelMd });
  }
  if (nonEmpty(documents.quickstartMd)) {
    drafts.push({ type: "guide", title: `Spec Kit Quickstart: ${feature}`, content: documents.quickstartMd });
  }
  for (const contract of documents.contracts ?? []) {
    if (!nonEmpty(contract.content)) continue;
    drafts.push({ type: "spec", title: contractTitle(contract), content: contract.content });
  }

  return drafts;
}

export function buildSpecKitTaskDrafts(parseResult: SpecKitParseResult): {
  taskDrafts: TaskDraftInput[];
  taskIdToDraftUuid: Record<string, string>;
  warnings: string[];
} {
  const taskIdToDraftUuid: Record<string, string> = {};
  for (const task of parseResult.tasks) {
    taskIdToDraftUuid[task.taskId] = randomUUID();
  }

  const warnings = [...parseResult.warnings];
  const taskDrafts = parseResult.tasks.map((task) => {
    const dependsOnDraftUuids: string[] = [];
    for (const depTaskId of task.dependsOnTaskIds) {
      const draftUuid = taskIdToDraftUuid[depTaskId];
      if (draftUuid) {
        dependsOnDraftUuids.push(draftUuid);
      } else {
        warnings.push(`${task.taskId} dependency ${depTaskId} was not imported because it was missing from tasks.md.`);
      }
    }

    return {
      uuid: taskIdToDraftUuid[task.taskId],
      title: task.title,
      description: task.description,
      priority: task.priority,
      storyPoints: task.storyPoints,
      acceptanceCriteriaItems: task.acceptanceCriteriaItems,
      dependsOnDraftUuids,
    };
  });

  return { taskDrafts, taskIdToDraftUuid, warnings };
}

export async function importSpecKitFeature(params: ImportSpecKitFeatureParams): Promise<ImportSpecKitFeatureResult> {
  const featureDir = normalizeSpecKitFeatureDir(params.featureDir);
  const documentDrafts = buildSpecKitDocumentDrafts(featureDir, params.documents);
  if (documentDrafts.length === 0) {
    throw new Error("At least one Spec Kit document is required");
  }

  const parseResult = parseSpecKitTasksMarkdown(params.tasksMarkdown, `${featureDir}/tasks.md`);
  if (parseResult.tasks.length === 0) {
    throw new Error("tasksMarkdown did not contain any Spec Kit tasks");
  }

  const { taskDrafts, taskIdToDraftUuid, warnings } = buildSpecKitTaskDrafts(parseResult);
  const proposal = await createProposal({
    companyUuid: params.companyUuid,
    projectUuid: params.projectUuid,
    title: params.title.trim(),
    description: appendSpecKitFeatureProvenance(params.description, featureDir),
    inputType: "speckit",
    inputUuids: [],
    documentDrafts,
    taskDrafts,
    createdByUuid: params.createdByUuid,
    createdByType: params.createdByType ?? "agent",
  });

  return {
    proposal,
    featureDir,
    documentDraftCount: documentDrafts.length,
    taskDraftCount: taskDrafts.length,
    taskIdToDraftUuid,
    warnings,
  };
}
