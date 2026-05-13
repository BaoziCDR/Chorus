import path from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

export type SpecKitRepoAdapterKind = "local" | "github";

export interface SpecKitGeneratedFile {
  path: string;
  content: string;
}

export interface SpecKitRepoWriteResult {
  provider: SpecKitRepoAdapterKind;
  path: string;
  status: "created" | "updated";
  absolutePath?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  htmlUrl?: string;
}

export interface SpecKitLocalConfig {
  provider: "local";
  root: string;
}

export interface SpecKitGithubConfig {
  provider: "github";
  repo: string;
  owner: string;
  name: string;
  branch: string;
  token: string;
  apiUrl: string;
}

export type SpecKitRepoAdapter = SpecKitLocalConfig | SpecKitGithubConfig;

function projectEnvSuffix(projectUuid: string): string {
  return projectUuid.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function envForProject(name: string, projectUuid: string): string | undefined {
  return process.env[`${name}_${projectEnvSuffix(projectUuid)}`] || process.env[name];
}

function requestedAdapter(projectUuid: string): string | undefined {
  return (
    envForProject("CHORUS_SPECKIT_ADAPTER", projectUuid) ||
    envForProject("CHORUS_SPECKIT_WRITE_MODE", projectUuid) ||
    envForProject("CHORUS_SPECKIT_SYNC", projectUuid)
  );
}

function localConfig(projectUuid: string): SpecKitLocalConfig | null {
  const root = envForProject("CHORUS_SPECKIT_LOCAL_REPO", projectUuid) || process.cwd();
  return { provider: "local", root: path.resolve(root) };
}

function githubConfig(projectUuid: string): SpecKitGithubConfig | null {
  const repo = envForProject("CHORUS_SPECKIT_GITHUB_REPO", projectUuid);
  const token = envForProject("CHORUS_SPECKIT_GITHUB_TOKEN", projectUuid) || process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;

  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;

  return {
    provider: "github",
    repo,
    owner,
    name,
    branch: envForProject("CHORUS_SPECKIT_GITHUB_BRANCH", projectUuid) || "main",
    token,
    apiUrl: (envForProject("CHORUS_SPECKIT_GITHUB_API_URL", projectUuid) || "https://api.github.com").replace(/\/+$/, ""),
  };
}

export function getSpecKitRepoAdapter(projectUuid: string): SpecKitRepoAdapter | null {
  const mode = requestedAdapter(projectUuid);
  if (mode && ["off", "none", "disabled"].includes(mode)) return null;
  if (mode === "local") return localConfig(projectUuid);
  if (mode === "github") return githubConfig(projectUuid);

  return localConfig(projectUuid);
}

export function adapterTarget(adapter: SpecKitRepoAdapter): string {
  if (adapter.provider === "local") return adapter.root;
  return `${adapter.repo}@${adapter.branch}`;
}

function safeLocalPath(root: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Unsafe Spec Kit path: ${relativePath}`);
  }
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, ...normalized.split("/"));
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Spec Kit path escapes local repo: ${relativePath}`);
  }
  return absolutePath;
}

async function githubResponse(config: SpecKitGithubConfig, apiPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.apiUrl}${apiPath}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
}

async function githubJson<T>(config: SpecKitGithubConfig, apiPath: string, init?: RequestInit): Promise<T> {
  const response = await githubResponse(config, apiPath, init);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function encodeContentPath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function readGithubFile(config: SpecKitGithubConfig, filePath: string): Promise<{
  sha: string;
  content: string;
  encoding: string;
} | null> {
  const encodedPath = encodeContentPath(filePath);
  const response = await githubResponse(
    config,
    `/repos/${config.owner}/${config.name}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<{ sha: string; content: string; encoding: string }>;
}

export async function readSpecKitFile(adapter: SpecKitRepoAdapter, filePath: string): Promise<string | null> {
  if (adapter.provider === "local") {
    const absolutePath = safeLocalPath(adapter.root, filePath);
    try {
      return await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  const contentResponse = await readGithubFile(adapter, filePath);
  if (!contentResponse) return null;
  if (contentResponse.encoding !== "base64") {
    throw new Error(`Unsupported GitHub content encoding: ${contentResponse.encoding}`);
  }
  return Buffer.from(contentResponse.content.replace(/\s/g, ""), "base64").toString("utf8");
}

export async function upsertSpecKitFile(params: {
  adapter: SpecKitRepoAdapter;
  path: string;
  content: string;
  message: string;
}): Promise<SpecKitRepoWriteResult> {
  if (params.adapter.provider === "local") {
    const absolutePath = safeLocalPath(params.adapter.root, params.path);
    const existed = await readFile(absolutePath, "utf8").then(() => true).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, params.content, "utf8");
    return {
      provider: "local",
      path: params.path,
      status: existed ? "updated" : "created",
      absolutePath,
    };
  }

  const existing = await readGithubFile(params.adapter, params.path);
  const encodedPath = encodeContentPath(params.path);
  const updateResponse = await githubJson<{
    commit?: { sha?: string; html_url?: string };
  }>(
    params.adapter,
    `/repos/${params.adapter.owner}/${params.adapter.name}/contents/${encodedPath}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: params.message,
        content: Buffer.from(params.content, "utf8").toString("base64"),
        ...(existing?.sha ? { sha: existing.sha } : {}),
        branch: params.adapter.branch,
      }),
    },
  );

  return {
    provider: "github",
    path: params.path,
    status: existing ? "updated" : "created",
    repo: params.adapter.repo,
    branch: params.adapter.branch,
    commitSha: updateResponse.commit?.sha,
    htmlUrl: updateResponse.commit?.html_url,
  };
}
