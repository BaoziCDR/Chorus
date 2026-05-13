import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { child: () => ({ error: vi.fn() }) },
}));

import { extractSpecKitFeatureDir, extractSpecKitTaskId } from "@/lib/spec-kit";
import { patchSpecKitTaskCheckbox } from "@/services/spec-kit-sync.service";

describe("spec-kit-sync.service", () => {
  it("extracts Spec Kit feature provenance from proposal descriptions", () => {
    expect(extractSpecKitFeatureDir("Summary\n\nSpec Kit feature dir: specs/001-login\n")).toBe("specs/001-login");
  });

  it("rejects unsafe feature paths", () => {
    expect(extractSpecKitFeatureDir("Spec Kit feature dir: ../specs/001-login")).toBeNull();
    expect(extractSpecKitFeatureDir("Spec Kit feature dir: /tmp/specs/001-login")).toBeNull();
  });

  it("extracts the Spec Kit task id from title or description", () => {
    expect(extractSpecKitTaskId("[T012] Implement login", null)).toBe("T012");
    expect(extractSpecKitTaskId("Implement login", "Spec Kit task: T013")).toBe("T013");
  });

  it("patches only the matching incomplete checkbox", () => {
    const markdown = [
      "- [ ] T011 Previous task",
      "- [ ] T012 Implement login",
      "- [X] T013 Already complete",
    ].join("\n");

    const result = patchSpecKitTaskCheckbox(markdown, "T012");

    expect(result.changed).toBe(true);
    expect(result.found).toBe(true);
    expect(result.alreadyComplete).toBe(false);
    expect(result.content).toContain("- [X] T012 Implement login");
    expect(result.content).toContain("- [ ] T011 Previous task");
    expect(result.content).toContain("- [X] T013 Already complete");
  });

  it("returns unchanged when the task checkbox is already complete", () => {
    const result = patchSpecKitTaskCheckbox("- [X] T012 Implement login", "T012");

    expect(result.changed).toBe(false);
    expect(result.found).toBe(true);
    expect(result.alreadyComplete).toBe(true);
    expect(result.content).toBe("- [X] T012 Implement login");
  });

  it("reports when the task checkbox was not found", () => {
    const result = patchSpecKitTaskCheckbox("- [ ] T011 Previous task", "T012");

    expect(result.changed).toBe(false);
    expect(result.found).toBe(false);
    expect(result.alreadyComplete).toBe(false);
    expect(result.content).toBe("- [ ] T011 Previous task");
  });
});
