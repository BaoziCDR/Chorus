import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import {
  appendSpecKitFeatureProvenance,
  defaultSpecKitFeatureDir,
  extractSpecKitFeatureDir,
  extractSpecKitTaskId,
  normalizeSpecKitFeatureDir,
} from "@/lib/spec-kit";
import type { DocumentDraft, TaskDraft } from "@/services/proposal.service";
import * as activityService from "@/services/activity.service";
import {
  adapterTarget,
  getSpecKitRepoAdapter,
  upsertSpecKitFile,
  type SpecKitRepoWriteResult,
} from "@/services/spec-kit-repo.service";

export interface SpecKitGeneratedFile {
  path: string;
  content: string;
}

export interface GenerateSpecKitFeatureParams {
  companyUuid: string;
  proposalUuid: string;
  featureDir?: string | null;
  actorType: string;
  actorUuid: string;
}

export interface GenerateSpecKitFeatureResult {
  proposalUuid: string;
  featureDir: string;
  files: SpecKitRepoWriteResult[];
  taskIdByDraftUuid: Record<string, string>;
}

interface ProposalLike {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  status: string;
  documentDrafts: unknown;
  taskDrafts: unknown;
}

function markdownBlock(title: string, content: string): string {
  return [`# ${title.trim() || "Untitled"}`, "", content.trim()].join("\n");
}

function joinDraftContents(drafts: DocumentDraft[]): string | null {
  const usable = drafts.filter((draft) => draft.content?.trim());
  if (usable.length === 0) return null;
  return usable.map((draft) => markdownBlock(draft.title, draft.content)).join("\n\n---\n\n");
}

function fallbackSpec(proposal: ProposalLike): string {
  return [
    `# ${proposal.title}`,
    "",
    "## Overview",
    "",
    proposal.description?.trim() || "Generated from a Chorus Proposal.",
  ].join("\n");
}

function fallbackPlan(proposal: ProposalLike): string {
  return [
    `# Implementation Plan: ${proposal.title}`,
    "",
    "## Source",
    "",
    `Generated from Chorus Proposal ${proposal.uuid}.`,
    "",
    "## Approach",
    "",
    proposal.description?.trim() || "Use the approved Chorus proposal and task list as the implementation plan.",
  ].join("\n");
}

function nextTaskId(used: Set<string>, start: number): { taskId: string; next: number } {
  let index = start;
  while (true) {
    const taskId = `T${String(index).padStart(3, "0")}`;
    index += 1;
    if (!used.has(taskId)) {
      used.add(taskId);
      return { taskId, next: index };
    }
  }
}

function appendTaskProvenance(description: string | undefined | null, taskId: string): string {
  const base = description?.trim() ?? "";
  if (extractSpecKitTaskId(null, base)) return base;
  const provenance = `Spec Kit task: ${taskId}`;
  return base ? `${base}\n\n${provenance}` : provenance;
}

function taskTitleForMarkdown(title: string): string {
  return title
    .replace(/^\s*\[?T\d{3,}\]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled task";
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function assignSpecKitTaskIds(taskDrafts: TaskDraft[]): {
  taskDrafts: TaskDraft[];
  taskIdByDraftUuid: Record<string, string>;
} {
  const used = new Set<string>();
  const taskIdByDraftUuid: Record<string, string> = {};
  let next = 1;

  const assigned = taskDrafts.map((draft) => {
    const existing = extractSpecKitTaskId(draft.title, draft.description);
    let taskId = existing && !used.has(existing) ? existing : null;
    if (taskId) {
      used.add(taskId);
    } else {
      const generated = nextTaskId(used, next);
      taskId = generated.taskId;
      next = generated.next;
    }

    taskIdByDraftUuid[draft.uuid] = taskId;
    return {
      ...draft,
      description: appendTaskProvenance(draft.description, taskId),
    };
  });

  return { taskDrafts: assigned, taskIdByDraftUuid };
}

export function buildSpecKitTasksMarkdown(params: {
  proposalTitle: string;
  proposalUuid: string;
  featureDir: string;
  taskDrafts: TaskDraft[];
  taskIdByDraftUuid: Record<string, string>;
}): string {
  const lines = [
    `# Tasks: ${params.proposalTitle}`,
    "",
    `**Input**: Chorus Proposal ${params.proposalUuid}`,
    `**Feature Dir**: ${params.featureDir}`,
    "",
    "## Phase 1: Implementation",
    "",
  ];

  for (const draft of params.taskDrafts) {
    const taskId = params.taskIdByDraftUuid[draft.uuid];
    if (!taskId) continue;
    const dependencyIds = (draft.dependsOnDraftUuids ?? [])
      .map((draftUuid) => params.taskIdByDraftUuid[draftUuid])
      .filter(isNonEmptyString);
    const parallelTag = dependencyIds.length === 0 && draft.storyPoints === 1 ? " [P]" : "";
    const dependencyText = dependencyIds.length > 0 ? ` (depends on ${dependencyIds.join(", ")})` : "";
    lines.push(`- [ ] ${taskId}${parallelTag} ${taskTitleForMarkdown(draft.title)}${dependencyText}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildSpecKitFeatureFiles(params: {
  proposal: ProposalLike;
  featureDir: string;
  documentDrafts: DocumentDraft[];
  taskDrafts: TaskDraft[];
  taskIdByDraftUuid: Record<string, string>;
}): SpecKitGeneratedFile[] {
  const prd = joinDraftContents(params.documentDrafts.filter((draft) => draft.type === "prd"));
  const techDesign = joinDraftContents(params.documentDrafts.filter((draft) => draft.type === "tech_design"));
  const research = joinDraftContents(params.documentDrafts.filter((draft) => draft.type === "adr"));
  const dataModel = joinDraftContents(params.documentDrafts.filter((draft) => draft.type === "spec"));
  const quickstart = joinDraftContents(params.documentDrafts.filter((draft) => draft.type === "guide"));

  const files: SpecKitGeneratedFile[] = [
    { path: `${params.featureDir}/spec.md`, content: prd || fallbackSpec(params.proposal) },
    { path: `${params.featureDir}/plan.md`, content: techDesign || fallbackPlan(params.proposal) },
    {
      path: `${params.featureDir}/tasks.md`,
      content: buildSpecKitTasksMarkdown({
        proposalTitle: params.proposal.title,
        proposalUuid: params.proposal.uuid,
        featureDir: params.featureDir,
        taskDrafts: params.taskDrafts,
        taskIdByDraftUuid: params.taskIdByDraftUuid,
      }),
    },
  ];

  if (research) files.push({ path: `${params.featureDir}/research.md`, content: research });
  if (dataModel) files.push({ path: `${params.featureDir}/data-model.md`, content: dataModel });
  if (quickstart) files.push({ path: `${params.featureDir}/quickstart.md`, content: quickstart });

  return files;
}

async function patchMaterializedTasks(params: {
  companyUuid: string;
  projectUuid: string;
  proposalUuid: string;
  taskDrafts: TaskDraft[];
  taskIdByDraftUuid: Record<string, string>;
}) {
  const tasks = await prisma.task.findMany({
    where: { companyUuid: params.companyUuid, proposalUuid: params.proposalUuid },
    select: { uuid: true, title: true, description: true },
    orderBy: { createdAt: "asc" },
  });

  for (let i = 0; i < Math.min(tasks.length, params.taskDrafts.length); i++) {
    const task = tasks[i];
    if (extractSpecKitTaskId(task.title, task.description)) continue;
    const taskId = params.taskIdByDraftUuid[params.taskDrafts[i].uuid];
    if (!taskId) continue;
    await prisma.task.update({
      where: { uuid: task.uuid },
      data: { description: appendTaskProvenance(task.description, taskId) },
    });
    eventBus.emitChange({
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      entityType: "task",
      entityUuid: task.uuid,
      action: "updated",
    });
  }
}

export async function generateSpecKitFeatureFromProposal(
  params: GenerateSpecKitFeatureParams,
): Promise<GenerateSpecKitFeatureResult> {
  const proposal = await prisma.proposal.findFirst({
    where: { uuid: params.proposalUuid, companyUuid: params.companyUuid },
  });
  if (!proposal) {
    throw new Error("Proposal not found");
  }

  const featureDir = normalizeSpecKitFeatureDir(
    params.featureDir || extractSpecKitFeatureDir(proposal.description) || defaultSpecKitFeatureDir(proposal.uuid, proposal.title),
  );
  const documentDrafts = Array.isArray(proposal.documentDrafts)
    ? (proposal.documentDrafts as unknown as DocumentDraft[])
    : [];
  const taskDrafts = Array.isArray(proposal.taskDrafts)
    ? (proposal.taskDrafts as unknown as TaskDraft[])
    : [];
  if (taskDrafts.length === 0) {
    throw new Error("Proposal must contain at least one task draft before generating Spec Kit files");
  }

  const adapter = getSpecKitRepoAdapter(proposal.projectUuid);
  if (!adapter) {
    throw new Error("Spec Kit repo adapter is disabled or misconfigured");
  }

  const assigned = assignSpecKitTaskIds(taskDrafts);
  const files = buildSpecKitFeatureFiles({
    proposal,
    featureDir,
    documentDrafts,
    taskDrafts: assigned.taskDrafts,
    taskIdByDraftUuid: assigned.taskIdByDraftUuid,
  });

  let writtenFiles: SpecKitRepoWriteResult[] = [];
  try {
    writtenFiles = [];
    for (const file of files) {
      writtenFiles.push(await upsertSpecKitFile({
        adapter,
        path: file.path,
        content: file.content,
        message: `chore(spec-kit): generate ${featureDir}`,
      }));
    }
  } catch (error) {
    await activityService.createActivity({
      companyUuid: proposal.companyUuid,
      projectUuid: proposal.projectUuid,
      targetType: "proposal",
      targetUuid: proposal.uuid,
      actorType: params.actorType,
      actorUuid: params.actorUuid,
      action: "speckit_generate_failed",
      value: {
        provider: adapter.provider,
        target: adapterTarget(adapter),
        featureDir,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
    throw error;
  }

  await prisma.proposal.update({
    where: { uuid: proposal.uuid },
    data: {
      description: appendSpecKitFeatureProvenance(proposal.description, featureDir),
      taskDrafts: assigned.taskDrafts as unknown as Prisma.InputJsonValue,
    },
  });
  eventBus.emitChange({
    companyUuid: proposal.companyUuid,
    projectUuid: proposal.projectUuid,
    entityType: "proposal",
    entityUuid: proposal.uuid,
    action: "updated",
  });

  if (proposal.status === "approved") {
    await patchMaterializedTasks({
      companyUuid: proposal.companyUuid,
      projectUuid: proposal.projectUuid,
      proposalUuid: proposal.uuid,
      taskDrafts: assigned.taskDrafts,
      taskIdByDraftUuid: assigned.taskIdByDraftUuid,
    });
  }

  await activityService.createActivity({
    companyUuid: proposal.companyUuid,
    projectUuid: proposal.projectUuid,
    targetType: "proposal",
    targetUuid: proposal.uuid,
    actorType: params.actorType,
    actorUuid: params.actorUuid,
    action: "speckit_generate_completed",
    value: {
      provider: adapter.provider,
      target: adapterTarget(adapter),
      featureDir,
      files: writtenFiles.map((file) => ({
        path: file.path,
        status: file.status,
        ...(file.absolutePath ? { absolutePath: file.absolutePath } : {}),
        ...(file.repo ? { repo: file.repo } : {}),
        ...(file.branch ? { branch: file.branch } : {}),
        ...(file.commitSha ? { commitSha: file.commitSha } : {}),
        ...(file.htmlUrl ? { htmlUrl: file.htmlUrl } : {}),
      })),
    },
  });

  return {
    proposalUuid: proposal.uuid,
    featureDir,
    files: writtenFiles,
    taskIdByDraftUuid: assigned.taskIdByDraftUuid,
  };
}
