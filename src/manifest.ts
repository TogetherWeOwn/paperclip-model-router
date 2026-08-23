import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { ROUTER_CONFIG_SCHEMA } from "./config/schema.js";
import {
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PLUGIN_VERSION,
  ROUTE_KEYS,
  TOOL_NAMES,
} from "./constants.js";

/**
 * One global install, one config row per company.
 *
 * Paperclip plugin installation is instance-level: there is no per-company
 * install table and no per-company enable switch (PLUGIN_SPEC.md §8). Company
 * differences live entirely in `instanceConfigSchema`, which the host stores per
 * (pluginId, companyId). That is what makes "install once, serve every company"
 * true, and it is why nothing company-specific may be hardcoded here.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Model Router",
  description:
    "Chooses the cheapest model that clears a hard quality floor and every capability, provider and quota constraint. Paperclip names a model; OmniRoute resolves the provider.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
    "api.routes.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: ROUTER_CONFIG_SCHEMA as unknown as Record<string, unknown>,
  tools: [
    {
      name: TOOL_NAMES.selectModel,
      displayName: "Select a model",
      description:
        "Return the cheapest model that clears this company's quality floor and constraints for a described task, with the full reasoning trace.",
      parametersSchema: {
        type: "object",
        required: ["companyId"],
        properties: {
          companyId: { type: "string", description: "Company whose routing config applies" },
          taskClass: { type: "string", description: "Task class key from this company's config" },
          summary: { type: "string", description: "Short description, used for the Rule 0 check" },
          issueId: { type: "string", description: "Issue this work belongs to" },
          requiredCapabilities: {
            type: "array",
            items: { type: "string" },
            description: "Capabilities the task genuinely requires. A hard gate, not a preference.",
          },
          requiredContextTokens: { type: "integer", minimum: 1 },
          estimatedInputTokens: { type: "integer", minimum: 1 },
          estimatedOutputTokens: { type: "integer", minimum: 1 },
          signals: {
            type: "object",
            additionalProperties: { type: "number" },
            description: "Task signals scored against this company's tiering weights",
          },
          pinnedModelId: { type: "string" },
          pinReason: { type: "string" },
        },
      },
    },
  ],
  apiRoutes: [
    {
      routeKey: ROUTE_KEYS.routeIssue,
      method: "POST",
      path: "/issues/:issueId/route",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: ROUTE_KEYS.companyConfig,
      method: "GET",
      path: "/effective-config",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "none",
      // The host only resolves company from a body key, a query key, or an
      // issue param — not from a path param. Query it is.
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
};

export default manifest;
