export interface SpecKitParsedTask {
  taskId: string;
  completed: boolean;
  phase: string;
  phaseIndex: number;
  story: string | null;
  parallel: boolean;
  title: string;
  rawDescription: string;
  paths: string[];
  dependsOnTaskIds: string[];
  priority: "low" | "medium" | "high";
  storyPoints: number;
  description: string;
  acceptanceCriteriaItems: Array<{ description: string; required: boolean }>;
}

export interface SpecKitParseResult {
  source: string;
  count: number;
  tasks: SpecKitParsedTask[];
  warnings: string[];
}

const taskRe = /^- \[([ xX])\]\s+(T\d{3,})\s+((?:\[[^\]]+\]\s+)*)?(.*)$/;

export function normalizeSpecKitFeatureDir(featureDir: string): string {
  const normalized = featureDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("featureDir is required");
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("featureDir must be a relative Spec Kit feature path");
  }
  return normalized;
}

export function extractSpecKitFeatureDir(description: string | null | undefined): string | null {
  if (!description) return null;
  const line = description.split(/\r?\n/).map((value) => value.trim()).find((value) => /^Spec Kit feature dir:\s*.+/i.test(value));
  if (!line) return null;
  try {
    return normalizeSpecKitFeatureDir(line.replace(/^Spec Kit feature dir:\s*/i, ""));
  } catch {
    return null;
  }
}

export function appendSpecKitFeatureProvenance(description: string | null | undefined, featureDir: string): string {
  const normalized = normalizeSpecKitFeatureDir(featureDir);
  const base = description?.trim() ?? "";
  const provenance = `Spec Kit feature dir: ${normalized}`;
  if (!base) return provenance;
  if (base.split(/\r?\n/).some((line) => line.trim() === provenance)) return base;
  return `${base}\n\n${provenance}`;
}

export function extractSpecKitTaskId(title: string | null | undefined, description: string | null | undefined): string | null {
  const match = `${title ?? ""}\n${description ?? ""}`.match(/\bT\d{3,}\b/);
  return match?.[0] ?? null;
}

export function defaultSpecKitFeatureDir(proposalUuid: string, title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = slug || "feature";
  return `specs/chorus-${proposalUuid.slice(0, 8)}-${suffix}`;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function extractPaths(description: string): string[] {
  const paths: string[] = [];
  for (const match of description.matchAll(/`([^`]+\.[A-Za-z0-9]+)`/g)) {
    paths.push(match[1]);
  }
  for (const match of description.matchAll(/(?:^|\s)((?:\.{0,2}\/)?[A-Za-z0-9_.[\]-]+(?:\/[A-Za-z0-9_.[\]-]+)*\.[A-Za-z0-9]+)(?=\s|$|[),.;:])/g)) {
    paths.push(match[1]);
  }
  return uniq(paths);
}

function explicitDependencies(description: string): string[] {
  const deps: string[] = [];
  for (const match of description.matchAll(/\bdepends?\s+on\s+((?:T\d{3,}[\s,]*)+)/gi)) {
    for (const dep of match[1].matchAll(/T\d{3,}/g)) {
      deps.push(dep[0]);
    }
  }
  return uniq(deps);
}

function priorityFor(task: { phase: string; story: string | null; rawDescription: string }): "low" | "medium" | "high" {
  const haystack = `${task.phase} ${task.story ?? ""} ${task.rawDescription}`.toLowerCase();
  if (haystack.includes("critical") || haystack.includes("foundational") || haystack.includes("mvp") || task.story === "US1") {
    return "high";
  }
  if (haystack.includes("polish") || haystack.includes("cleanup")) {
    return "low";
  }
  return "medium";
}

export function parseSpecKitTasksMarkdown(markdown: string, source = "tasks.md"): SpecKitParseResult {
  const lines = markdown.split(/\r?\n/);
  const tasks: SpecKitParsedTask[] = [];
  const warnings: string[] = [];
  let phase = "";
  let phaseIndex = 0;
  let lastTaskIdByPhase: string | null = null;
  let lastPhaseLastTaskId: string | null = null;

  for (const rawLine of lines) {
    const heading = rawLine.match(/^##\s+(.+)$/);
    if (heading) {
      if (lastTaskIdByPhase) {
        lastPhaseLastTaskId = lastTaskIdByPhase;
      }
      phase = heading[1].trim();
      phaseIndex += 1;
      lastTaskIdByPhase = null;
      continue;
    }

    const match = rawLine.match(taskRe);
    if (!match) continue;

    const [, checkbox, taskId, rawTags = "", rawDescription] = match;
    const tags = [...rawTags.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const parallel = tags.includes("P");
    const story = tags.find((tag) => /^US\d+$/i.test(tag))?.toUpperCase() ?? null;
    const paths = extractPaths(rawDescription);
    const deps = explicitDependencies(rawDescription);

    if (deps.length === 0) {
      if (lastPhaseLastTaskId) {
        deps.push(lastPhaseLastTaskId);
      }
      if (!parallel && lastTaskIdByPhase) {
        deps.push(lastTaskIdByPhase);
      }
    }

    const tagPrefix = [`[${taskId}]`, story ? `[${story}]` : ""].filter(Boolean).join(" ");
    const shortTitle = rawDescription.replace(/\s*\(depends?\s+on[^)]*\)/i, "").trim();
    const taskBase = {
      phase,
      story,
      rawDescription,
    };
    const pathLine = paths.length ? `\n\nPaths: ${paths.join(", ")}` : "";
    const storyLine = story ? `\n\nUser story: ${story}` : "";

    tasks.push({
      taskId,
      completed: checkbox.toLowerCase() === "x",
      phase,
      phaseIndex,
      story,
      parallel,
      title: `${tagPrefix} ${shortTitle}`,
      rawDescription,
      paths,
      dependsOnTaskIds: uniq(deps.filter((dep) => dep !== taskId)),
      priority: priorityFor(taskBase),
      storyPoints: parallel ? 1 : 2,
      description: `Source: ${source}\nSpec Kit task: ${taskId}\nPhase: ${phase}${storyLine}\nParallel: ${parallel ? "yes" : "no"}${pathLine}\n\n${rawDescription}`,
      acceptanceCriteriaItems: [
        {
          description: `Complete ${taskId} as described in ${source}.`,
          required: true,
        },
        {
          description: "Report validation evidence and changed files in Chorus before submitting for verification.",
          required: true,
        },
      ],
    });
    lastTaskIdByPhase = taskId;
  }

  if (tasks.length === 0) {
    warnings.push("No Spec Kit task lines matched '- [ ] T001 ...' format.");
  }

  const knownIds = new Set(tasks.map((task) => task.taskId));
  for (const task of tasks) {
    for (const dep of task.dependsOnTaskIds) {
      if (!knownIds.has(dep)) {
        warnings.push(`${task.taskId} depends on missing task ${dep}.`);
      }
    }
  }

  return {
    source,
    count: tasks.length,
    tasks,
    warnings,
  };
}
