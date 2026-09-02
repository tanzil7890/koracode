// Phase 12.4 security tests: deny-by-default profile, egress pinning,
// telemetry-off contract, and injection resistance of the tool surface.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { EgressDeniedError, assertAllowedUrl, policyFromEnv } from "../src/egress"
import { FORBIDDEN_TOOL_IDS, MANAGED_WORKFLOW_PROFILE, profileAllows, UNTRUSTED_CONTENT_POLICY } from "../src/profile"
import { WORKFLOW_READ_TOOLS, ToolDeniedError, assertReadOnlySurface, resolveTool } from "../src/tools"

const POLICY = { allowedOrigins: ["https://kora.internal:8000", "https://api.anthropic.com"] }

describe("managed profile is deny-by-default (step 7)", () => {
  test("wildcard is false and only workflow_* tools are allowed", () => {
    expect(MANAGED_WORKFLOW_PROFILE.tools["*"]).toBe(false)
    const allowed = Object.entries(MANAGED_WORKFLOW_PROFILE.tools)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id)
    expect(allowed.sort()).toEqual(WORKFLOW_READ_TOOLS.map((tool) => tool.id).sort())
    for (const id of allowed) expect(id.startsWith("workflow_")).toBe(true)
  })

  test.each(FORBIDDEN_TOOL_IDS.map((id) => [id] as const))("forbidden tool %s is denied", (toolId) => {
    expect(profileAllows(MANAGED_WORKFLOW_PROFILE, toolId)).toBe(false)
  })

  test("an unknown future tool is denied by the wildcard, not by enumeration", () => {
    expect(profileAllows(MANAGED_WORKFLOW_PROFILE, "some_new_tool_2027")).toBe(false)
  })

  test("the markdown profile artifact carries the identical tool map", () => {
    const markdown = readFileSync(join(import.meta.dir, "..", "profile", "managed-workflow.md"), "utf-8")
    expect(markdown).toContain('"*": false')
    for (const tool of WORKFLOW_READ_TOOLS) expect(markdown).toContain(`${tool.id}: true`)
    for (const forbidden of FORBIDDEN_TOOL_IDS) {
      expect(markdown).not.toContain(`${forbidden}: true`)
    }
    expect(markdown).toContain("UNTRUSTED DATA")
  })

  test("the system policy marks page/tool/model content untrusted (step 13)", () => {
    expect(MANAGED_WORKFLOW_PROFILE.prompt).toContain(UNTRUSTED_CONTENT_POLICY)
    expect(UNTRUSTED_CONTENT_POLICY).toContain("authorizes every tool call server-side")
  })
})

describe("tool surface resists injection (steps 7/13)", () => {
  test.each(["bash", "edit", "write", "webfetch", "browser_execute", "Bash", "workflow_publish", "../bash"])(
    "resolving %s throws ToolDenied",
    (toolId) => {
      expect(() => resolveTool(toolId)).toThrow(ToolDeniedError)
    },
  )

  test("every allowlisted tool resolves and is a read (GET) operation", () => {
    for (const tool of WORKFLOW_READ_TOOLS) {
      expect(resolveTool(tool.id).id).toBe(tool.id)
    }
  })

  test("a build that registers an extra tool fails the surface guard", () => {
    expect(() => assertReadOnlySurface([...WORKFLOW_READ_TOOLS.map((t) => t.id), "bash"])).toThrow(ToolDeniedError)
    expect(() => assertReadOnlySurface(WORKFLOW_READ_TOOLS.map((t) => t.id))).not.toThrow()
  })
})

describe("egress pinning (step 8)", () => {
  test.each([
    "https://evil.example/exfil",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "ftp://kora.internal:8000/x",
    "https://user:pass@kora.internal:8000/x",
    "https://kora.internal:9999/other-port",
  ])("%s is denied", (url) => {
    expect(() => assertAllowedUrl(url, POLICY)).toThrow(EgressDeniedError)
  })

  test("the pinned control-plane and model origins are allowed", () => {
    expect(assertAllowedUrl("https://kora.internal:8000/internal/kora/v1/runs/x", POLICY).origin).toBe(
      "https://kora.internal:8000",
    )
    expect(assertAllowedUrl("https://api.anthropic.com/v1/messages", POLICY).origin).toBe("https://api.anthropic.com")
  })

  test("policyFromEnv builds the allowlist from exactly two declared sources", () => {
    const policy = policyFromEnv({
      KORA_CONTROL_PLANE_URL: "https://kora.internal:8000",
      KORA_ALLOWED_MODEL_ORIGINS: "https://api.anthropic.com, https://models.internal:8443",
    })
    expect(policy.allowedOrigins).toEqual([
      "https://kora.internal:8000",
      "https://api.anthropic.com",
      "https://models.internal:8443",
    ])
  })
})

describe("telemetry and update egress are hard-off (step 8)", () => {
  test("the environment contract disables every known telemetry channel", () => {
    const env = MANAGED_WORKFLOW_PROFILE.environment
    expect(env["OPENCODE_DISABLE_TELEMETRY"]).toBe("1")
    expect(env["OPENCODE_DISABLE_AUTOUPDATE"]).toBe("1")
    expect(env["OPENCODE_PURE"]).toBe("1")
    expect(env["DO_NOT_TRACK"]).toBe("1")
    expect(env["LMNR_PROJECT_API_KEY"]).toBe("")
    expect(env["ANONYMIZED_TELEMETRY"]).toBe("false")
  })
})
