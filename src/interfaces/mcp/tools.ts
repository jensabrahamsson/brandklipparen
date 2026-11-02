// Closed versioned MCP tool registry with published input schemas
// (S-028, K-025, K-026, K-508, M-15). The registry holds solely reading
// tools over the shared application service; every new tool passes the
// security review in K-026 before release. Input validation uses plain
// checks plus smart constructors with the same limits as the REST adapter
// (A-16): address length cap, block length cap and strict rejection of
// extra fields. Contract-derived strings stay data: tool outputs wrap the
// canonical assessment text in a content block marked for the user, never
// as instructions to the client model.
import { Address, BlockNumber } from "../../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
} from "../../domain/types.ts";

// Same boundary caps as the REST adapter, so tool inputs face the same
// limits as REST inputs (K-026).
export const MCP_MAX_ADDRESS_CHARS = 1024;
export const MCP_MAX_BLOCK_CHARS = 64;

// Names that mark a secret: an argument carrying one is turned away before
// analysis, mirroring the REST key-in-URL-or-body rule (M-10).
const SECRET_LIKE = /key|token|secret|password|auth/i;

// Closed tool list, versioned per tool (K-025, M-15). The MVP exposes
// reading tools over the same service; the list grows solely through the
// reviewed path in K-026.
export const TOOL_LIST_VERSION = "1.3.0";
export const ASSESS_TOKEN_TOOL = "assess_token";
export const ASSESS_TOKEN_VERSION = "1.0.0";
// Registry exposure (S-046, K-031, P-10): one registry-derived reading
// tool returning the same manifest list as GET /v1/plugins. Per-plugin
// tools are the S-048 stretch item; the MVP keeps this small closed list.
export const LIST_PLUGINS_TOOL = "list_plugins";
export const LIST_PLUGINS_VERSION = "1.0.0";
// Plugin docs exposure (S-056, K-033, P-16): one registry-derived reading
// tool returning the same validated docs record as GET /v1/plugins/:id/docs.
// A resource form stays out of scope: this closed tool list is the reviewed
// surface (K-026).
export const GET_PLUGIN_DOCS_TOOL = "get_plugin_docs";
export const GET_PLUGIN_DOCS_VERSION = "1.0.0";
// Stored CI audit report read view (S-058, K-516): one registry-derived
// reading tool returning the same stored report as GET
// /v1/plugins/:id/audit. The read view triggers no audit.
export const GET_PLUGIN_AUDIT_TOOL = "get_plugin_audit";
export const GET_PLUGIN_AUDIT_VERSION = "1.0.0";
// On-request Muse contract assessment (S-038, K-305, K-309): a separate
// reading tool over the shared assessment service. Scores and evidence
// pass through untouched; the assessment lands in its own labelled field.
export const REQUEST_ASSESSMENT_TOOL = "request_assessment";
export const REQUEST_ASSESSMENT_VERSION = "1.0.0";
// Opt-in investigation loop (S-075, K-036, P-37): a separate reading tool
// over the shared investigation service. The deterministic analysis runs
// first and freezes; the trace and the citation-checked narrative land in
// their own fields and never move scores or evidence.
export const INVESTIGATE_TOKEN_TOOL = "investigate_token";
export const INVESTIGATE_TOKEN_VERSION = "1.0.0";
// Point-in-time on-chain features (session A): a separate reading tool
// over the shared on-chain service. Serving-mode features at the current
// block (or a pinned block), display data only, never scored.
export const ONCHAIN_FEATURES_TOOL = "onchain_features";
export const ONCHAIN_FEATURES_VERSION = "1.0.0";
// Sentence-level explanation overlay (S-094, K-302): a separate reading
// tool over the shared explain service. The deterministic analysis runs
// first and stands; the citation-checked narrative lands in its own
// field, never moving scores or evidence. Read-only.
export const EXPLAIN_TOKEN_TOOL = "explain_token";
export const EXPLAIN_TOKEN_VERSION = "1.0.0";
// Per-function code explanation overlay (VS-B3): a separate reading tool
// over the shared explain-code service. The frozen function lines for the
// requested view (decompiled or verified source) travel beside the
// selector-filtered evidence meanings; the summary and line-anchored
// notes land in their own fields, never moving scores or evidence.
export const EXPLAIN_FUNCTION_TOOL = "explain_function";
export const EXPLAIN_FUNCTION_VERSION = "1.0.0";
// Snippet deepening per selector (S-095, K-008): a separate reading tool
// quoting the local pipeline's own emission for one dispatcher entry.
// Display text only, never scored.
export const GET_DECOMPILED_FUNCTION_TOOL = "get_decompiled_function";
export const GET_DECOMPILED_FUNCTION_VERSION = "1.0.0";
// Verified contract sources (VS-B2): a separate reading tool returning
// the summarised source record (status, match, compiler, functions) with
// full file content only for a requested function range. Display data
// only, never scored and never part of the analysis.
export const GET_VERIFIED_SOURCE_TOOL = "get_verified_source";
export const GET_VERIFIED_SOURCE_VERSION = "1.0.0";
// Extended-proof diagnostics (VS-B1, main spec B-3): a separate reading
// tool returning the per-detector proof reports with code locations.
// Display data only, never scored and never part of the analysis.
export const GET_PROOF_TRACE_TOOL = "get_proof_trace";
export const GET_PROOF_TRACE_VERSION = "1.0.0";
// New-token listings (E-11, DX-B1): a separate reading tool merging the
// on-chain new-pair list with the market listing promotions. Display
// data only, never scored and never starting an analysis.
export const LIST_NEW_TOKENS_TOOL = "list_new_tokens";
export const LIST_NEW_TOKENS_VERSION = "1.0.0";

export type JsonSchema = {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly inputSchema: JsonSchema;
};

// Published input schema for assess_token (K-026). Shape and caps match the
// REST boundary: a contract address plus an optional block pinned to
// "latest" or a non-negative integer. No additional properties are allowed.
export const ASSESS_TOKEN_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["address"]),
  properties: Object.freeze({
    address: Object.freeze({
      type: "string",
      description: "Contract address as 0x followed by 40 hex characters.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
    block: Object.freeze({
      description: "Block context: latest or a non-negative integer.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
  }),
});

export const REQUEST_ASSESSMENT_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["address"]),
  properties: Object.freeze({
    address: Object.freeze({
      type: "string",
      description: "Contract address as 0x followed by 40 hex characters.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
    block: Object.freeze({
      description: "Block context: latest or a non-negative integer.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
  }),
});

// Published input schema for investigate_token (S-075, K-026): the same
// address and block gate as assess_token, so the investigation request
// faces identical limits.
export const INVESTIGATE_TOKEN_INPUT_SCHEMA: JsonSchema = REQUEST_ASSESSMENT_INPUT_SCHEMA;

// Published input schema for list_plugins (S-046, K-026): no arguments.
// Unknown or secret-like fields are turned away like any other tool input.
export const LIST_PLUGINS_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([]),
  properties: Object.freeze({}),
});

// Published input schema for get_plugin_docs (S-056, K-026): the plugin id
// only. Unknown or secret-like fields are turned away like any other tool
// input.
export const GET_PLUGIN_DOCS_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["id"]),
  properties: Object.freeze({
    id: Object.freeze({
      type: "string",
      description: "Registered plugin id, for example dev.brandklipparen.capability.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
  }),
});

export const GET_PLUGIN_AUDIT_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["id"]),
  properties: Object.freeze({
    id: Object.freeze({
      type: "string",
      description: "Registered plugin id, for example dev.brandklipparen.capability.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
  }),
});

// Published input schema for explain_function (VS-B3): the address and
// block gate as assess_token, plus the 0x-prefixed 8-hex selector and the
// code view ("decompiled" or "source").
export const EXPLAIN_FUNCTION_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["address", "selector", "view"]),
  properties: Object.freeze({
    address: Object.freeze({
      type: "string",
      description: "Contract address as 0x followed by 40 hex characters.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
    block: Object.freeze({
      description: "Block context: latest or a non-negative integer.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
    selector: Object.freeze({
      type: "string",
      description: "Function selector as 0x followed by 8 hex characters.",
      minLength: 10,
      maxLength: 10,
    }),
    view: Object.freeze({
      type: "string",
      description: 'Code view: "decompiled" or "source".',
      enum: Object.freeze(["decompiled", "source"]),
    }),
  }),
});

// Published input schema for get_decompiled_function (S-095): the address
// and block gate as assess_token, plus the 0x-prefixed 8-hex selector.
export const GET_DECOMPILED_FUNCTION_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["address", "selector"]),
  properties: Object.freeze({
    address: Object.freeze({
      type: "string",
      description: "Contract address as 0x followed by 40 hex characters.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
    block: Object.freeze({
      description: "Block context: latest or a non-negative integer.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
    selector: Object.freeze({
      type: "string",
      description: "Function selector as 0x followed by 8 hex characters.",
      minLength: 10,
      maxLength: 10,
    }),
  }),
});

// Published input schema for get_verified_source (VS-B2): the address and
// block gate as assess_token, plus an optional function selector naming
// the one function range whose file content is returned.
export const GET_VERIFIED_SOURCE_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["address"]),
  properties: Object.freeze({
    address: Object.freeze({
      type: "string",
      description: "Contract address as 0x followed by 40 hex characters.",
      minLength: 1,
      maxLength: MCP_MAX_ADDRESS_CHARS,
    }),
    block: Object.freeze({
      description: "Block context: latest or a non-negative integer.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
    functionSelector: Object.freeze({
      type: "string",
      description: "Optional function selector as 0x followed by 8 hex characters: return that function range with file content.",
      minLength: 10,
      maxLength: 10,
    }),
  }),
});

// Published input schema for list_new_tokens (E-11, DX-B1): no required
// arguments. The optional chain names the listing network (ethereum
// only); the optional since trims to items created after that instant in
// milliseconds since the epoch.
export const LIST_NEW_TOKENS_INPUT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([]),
  properties: Object.freeze({
    chain: Object.freeze({
      type: "string",
      description: 'Listing network: "ethereum" only.',
      minLength: 1,
      maxLength: MCP_MAX_BLOCK_CHARS,
    }),
    since: Object.freeze({
      description: "Trim to items created after this instant in milliseconds since the epoch.",
      anyOf: Object.freeze([
        Object.freeze({ type: "string", minLength: 1, maxLength: MCP_MAX_BLOCK_CHARS }),
        Object.freeze({ type: "integer", minimum: 0 }),
      ]),
    }),
  }),
});

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: ASSESS_TOKEN_TOOL,
    description:
      "Assess the risk of a newly deployed ERC-20 token from its contract bytecode: calibrated probabilities, score and evidence with selectors. Read-only.",
    version: ASSESS_TOKEN_VERSION,
    inputSchema: ASSESS_TOKEN_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: REQUEST_ASSESSMENT_TOOL,
    description:
      "Request the Muse contract assessment for a token: the same probabilities, score and evidence as assess_token plus a separate Muse-generated assessment field labelled with provider and model id. Runs solely on request. Read-only.",
    version: REQUEST_ASSESSMENT_VERSION,
    inputSchema: REQUEST_ASSESSMENT_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: INVESTIGATE_TOKEN_TOOL,
    description:
      "Run the opt-in investigation loop for a token: the same probabilities, score and evidence as assess_token plus the investigation trace and citation-checked narrative in their own fields, labelled with provider and model id. Runs solely on request. Read-only.",
    version: INVESTIGATE_TOKEN_VERSION,
    inputSchema: INVESTIGATE_TOKEN_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: ONCHAIN_FEATURES_TOOL,
    description:
      "Read point-in-time on-chain features for a token: owner seat, LP buckets, holder concentration, liquidity size, deployer provenance and age at the current block or a pinned block. Display data only, never scored. Read-only.",
    version: ONCHAIN_FEATURES_VERSION,
    inputSchema: ASSESS_TOKEN_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: LIST_PLUGINS_TOOL,
    description:
      "List the registered detector plugins: id, version, display name, description, declared inputs, capabilities and weight. Same list as GET /v1/plugins. Read-only.",
    version: LIST_PLUGINS_VERSION,
    inputSchema: LIST_PLUGINS_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: GET_PLUGIN_DOCS_TOOL,
    description:
      "Read the validated PLUGIN.md docs for one registered plugin: id, version, section list and markdown. Same record as GET /v1/plugins/:id/docs. Read-only.",
    version: GET_PLUGIN_DOCS_VERSION,
    inputSchema: GET_PLUGIN_DOCS_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: GET_PLUGIN_AUDIT_TOOL,
    description:
      "Read the stored CI audit report for one registered plugin: deterministic state, advisory AI state with provider and model id, and human-review state. Same record as GET /v1/plugins/:id/audit. Read-only; triggers no audit.",
    version: GET_PLUGIN_AUDIT_VERSION,
    inputSchema: GET_PLUGIN_AUDIT_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: EXPLAIN_TOKEN_TOOL,
    description:
      "Explain a token assessment in plain language: the same probabilities, score and evidence as assess_token plus a separate sentence-level narrative with citations, labelled with provider and model id. Runs solely on request. Read-only; never changes the score or evidence.",
    version: EXPLAIN_TOKEN_VERSION,
    inputSchema: ASSESS_TOKEN_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: EXPLAIN_FUNCTION_TOOL,
    description:
      'Explain one contract function: pass address with selector (0xa9059cbb form) and view ("decompiled" or "source") for a short summary plus line-anchored notes with citations. Same record as POST /v1/explain-code. Read-only; never changes the score or evidence.',
    version: EXPLAIN_FUNCTION_VERSION,
    inputSchema: EXPLAIN_FUNCTION_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: GET_DECOMPILED_FUNCTION_TOOL,
    description:
      "Quote the decompiled source block for one dispatcher selector: entry pc plus numbered lines with exact instruction pcs. Same record as GET /v1/snippet. Read-only; display text only, never scored.",
    version: GET_DECOMPILED_FUNCTION_VERSION,
    inputSchema: GET_DECOMPILED_FUNCTION_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: GET_VERIFIED_SOURCE_TOOL,
    description:
      "Summarise the verified contract sources: status, match, compiler and located functions. Add functionSelector (0xa9059cbb form) to also return that function range with file content. Same origin as GET /v1/source. Read-only; display data only, never scored.",
    version: GET_VERIFIED_SOURCE_VERSION,
    inputSchema: GET_VERIFIED_SOURCE_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: GET_PROOF_TRACE_TOOL,
    description:
      "Read the extended-proof diagnostics for a token: one per-detector report with the code locations behind the findings. Same record as GET /v1/proof. Read-only; display data only, never scored.",
    version: GET_PROOF_TRACE_VERSION,
    inputSchema: ASSESS_TOKEN_INPUT_SCHEMA,
  }),
  Object.freeze({
    name: LIST_NEW_TOKENS_TOOL,
    description:
      "List newly listed tokens: on-chain new pairs plus market listing promotions, newest first with age, pair, liquidity and the deterministic risk result when already analysed. Display data only, never scored and never starts an analysis. Read-only.",
    version: LIST_NEW_TOKENS_VERSION,
    inputSchema: LIST_NEW_TOKENS_INPUT_SCHEMA,
  }),
]);

export function findTool(name: string): ToolDefinition | null {
  const found = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  return found ?? null;
}

// Validated tool input: the address proof and the block context. Raw text
// stays at the boundary; the service takes validity as given (A-11).
export type AssessTokenInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
};

export type AssessInputError =
  | { readonly kind: "validation-error"; readonly message: string }
  | { readonly kind: "request-too-large"; readonly message: string }
  | { readonly kind: "key-in-url-or-body"; readonly message: string };

// Strict boundary check for token address arguments (A-16, M-15): the value
// must be a plain object with solely the published fields, within the same
// length caps as REST. Format proof comes from the smart constructors.
// Both reading tools share this gate, so assess_token and request_assessment
// face identical limits.
function parseTokenAddressInput(args: unknown): AssessInputError | { readonly input: AssessTokenInput } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "validation-error", message: "Invalid arguments: expected an object with address and block." };
  }
  const record = args as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (name !== "address" && name !== "block") {
      if (SECRET_LIKE.test(name)) {
        return {
          kind: "key-in-url-or-body",
          message: "API keys travel outside the tool arguments, never inside them.",
        };
      }
      return {
        kind: "validation-error",
        message: `Invalid argument: unknown field ${JSON.stringify(name)}.`,
      };
    }
  }
  const rawAddress = record["address"];
  if (typeof rawAddress !== "string" || rawAddress.length < 1) {
    return {
      kind: "validation-error",
      message: "Invalid address: expected 0x followed by 40 hex characters.",
    };
  }
  if (rawAddress.length > MCP_MAX_ADDRESS_CHARS) {
    return { kind: "request-too-large", message: "Request exceeds the input size limit." };
  }
  const rawBlock = record["block"];
  if (rawBlock !== undefined) {
    if (typeof rawBlock === "string" && rawBlock.length > MCP_MAX_BLOCK_CHARS) {
      return { kind: "request-too-large", message: "Request exceeds the input size limit." };
    }
    if (typeof rawBlock !== "string" && typeof rawBlock !== "number") {
      return {
        kind: "validation-error",
        message: "Invalid block: expected latest or a non-negative integer.",
      };
    }
  }
  const address = Address.parse(rawAddress);
  if (!address.ok) {
    return {
      kind: "validation-error",
      message: "Invalid address: expected 0x followed by 40 hex characters.",
    };
  }
  const block = parseBlock(rawBlock);
  if (block === null) {
    return {
      kind: "validation-error",
      message: "Invalid block: expected latest or a non-negative integer.",
    };
  }
  return { input: Object.freeze({ address: address.value, block }) };
}

export function parseAssessTokenInput(args: unknown): AssessInputError | { readonly input: AssessTokenInput } {
  return parseTokenAddressInput(args);
}

// Strict boundary check for request_assessment arguments: the same gate as
// assess_token, so the assessment request faces identical limits (K-026).
export function parseRequestAssessmentInput(args: unknown): AssessInputError | { readonly input: AssessTokenInput } {
  return parseTokenAddressInput(args);
}

// Strict boundary check for investigate_token arguments: the same gate as
// assess_token, so the investigation request faces identical limits (K-026).
export function parseInvestigateInput(args: unknown): AssessInputError | { readonly input: AssessTokenInput } {
  return parseTokenAddressInput(args);
}

// Strict boundary check for onchain_features arguments: the same gate as
// assess_token, so the on-chain read faces identical limits.
export function parseOnchainFeaturesInput(args: unknown): AssessInputError | { readonly input: AssessTokenInput } {
  return parseTokenAddressInput(args);
}

// Strict boundary check for list_plugins arguments (S-046, K-026): the
// value must be a plain object with no fields. Unknown fields are turned
// away; secret-like fields name the key rule like any other tool.
export function parseListPluginsInput(args: unknown): AssessInputError | { readonly empty: true } {
  if (args === undefined) {
    return { empty: true };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "validation-error", message: "Invalid arguments: list_plugins takes no arguments." };
  }
  for (const name of Object.keys(args)) {
    if (SECRET_LIKE.test(name)) {
      return {
        kind: "key-in-url-or-body",
        message: "API keys travel outside the tool arguments, never inside them.",
      };
    }
    return {
      kind: "validation-error",
      message: `Invalid argument: unknown field ${JSON.stringify(name)}.`,
    };
  }
  return { empty: true };
}

// Strict boundary check for get_plugin_docs arguments (S-056, K-026): the
// value must be a plain object carrying solely the plugin id. Unknown
// fields are turned away; secret-like fields name the key rule like any
// other tool.
// Strict boundary check for get_plugin_audit arguments (S-058, K-026):
// the value must be a plain object carrying solely the plugin id, the same
// shape as the docs tool. Unknown fields are turned away; secret-like
// fields name the key rule like any other tool.
export function parseGetPluginAuditInput(
  args: unknown,
): AssessInputError | { readonly id: string } {
  return parseGetPluginDocsInput(args);
}

export function parseGetPluginDocsInput(
  args: unknown,
): AssessInputError | { readonly id: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "validation-error", message: "Invalid arguments: expected an object with id." };
  }
  const record = args as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (name !== "id") {
      if (SECRET_LIKE.test(name)) {
        return {
          kind: "key-in-url-or-body",
          message: "API keys travel outside the tool arguments, never inside them.",
        };
      }
      return {
        kind: "validation-error",
        message: `Invalid argument: unknown field ${JSON.stringify(name)}.`,
      };
    }
  }
  const rawId = record["id"];
  if (typeof rawId !== "string" || rawId.length < 1 || rawId.length > MCP_MAX_ADDRESS_CHARS) {
    return { kind: "validation-error", message: "Invalid id: expected a registered plugin id." };
  }
  return { id: rawId };
}

// Validated explain_token input: the same address proof and block context
// as assess_token, so the explanation request faces identical limits.
export type ExplainTokenInput = AssessTokenInput;

export function parseExplainTokenInput(args: unknown): AssessInputError | { readonly input: ExplainTokenInput } {
  return parseTokenAddressInput(args);
}

// Validated get_proof_trace input: the same address proof and block
// context as assess_token, so the proof read faces identical limits.
export type ProofTraceInput = AssessTokenInput;

export function parseProofTraceInput(args: unknown): AssessInputError | { readonly input: ProofTraceInput } {
  return parseTokenAddressInput(args);
}

// Validated function-scoped code input: the address proof and block
// context as assess_token, plus the 0x-prefixed 8-hex selector and the
// code view. Raw text stays at the boundary; the service takes validity
// as given (A-11).
export type ExplainFunctionInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly selector: string;
  readonly view: "decompiled" | "source";
};

export type DecompiledFunctionInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly selector: string;
};

export type VerifiedSourceInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly functionSelector?: string | undefined;
};

// Strict boundary check for selector-shaped arguments (S-095, VS-B3):
// the value must carry solely the published fields within the same caps
// as assess_token, and the selector must be 0x plus 8 hex characters.
// Format proof comes from the regex; unknown or secret-like fields fail
// like any other tool.
function parseSelectorInput(
  args: unknown,
  allowed: ReadonlySet<string>,
  usage: string,
): AssessInputError | { readonly record: Record<string, unknown> } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "validation-error", message: `Invalid arguments: expected an object with ${usage}.` };
  }
  const record = args as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (!allowed.has(name)) {
      if (SECRET_LIKE.test(name)) {
        return {
          kind: "key-in-url-or-body",
          message: "API keys travel outside the tool arguments, never inside them.",
        };
      }
      return {
        kind: "validation-error",
        message: `Invalid argument: unknown field ${JSON.stringify(name)}.`,
      };
    }
  }
  return { record };
}

function parseSelectorField(raw: unknown): string | null {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{8}$/.test(raw) ? raw : null;
}

function parseAddressAndBlock(
  record: Record<string, unknown>,
): AssessInputError | { readonly address: AddressType; readonly block: BlockNumberType | "latest" } {
  const rawAddress = record["address"];
  if (typeof rawAddress !== "string" || rawAddress.length < 1) {
    return {
      kind: "validation-error",
      message: "Invalid address: expected 0x followed by 40 hex characters.",
    };
  }
  if (rawAddress.length > MCP_MAX_ADDRESS_CHARS) {
    return { kind: "request-too-large", message: "Request exceeds the input size limit." };
  }
  const rawBlock = record["block"];
  if (rawBlock !== undefined) {
    if (typeof rawBlock === "string" && rawBlock.length > MCP_MAX_BLOCK_CHARS) {
      return { kind: "request-too-large", message: "Request exceeds the input size limit." };
    }
    if (typeof rawBlock !== "string" && typeof rawBlock !== "number") {
      return {
        kind: "validation-error",
        message: "Invalid block: expected latest or a non-negative integer.",
      };
    }
  }
  const address = Address.parse(rawAddress);
  if (!address.ok) {
    return {
      kind: "validation-error",
      message: "Invalid address: expected 0x followed by 40 hex characters.",
    };
  }
  const block = parseBlock(rawBlock as string | number | undefined);
  if (block === null) {
    return {
      kind: "validation-error",
      message: "Invalid block: expected latest or a non-negative integer.",
    };
  }
  return { address: address.value, block };
}

export function parseExplainFunctionInput(
  args: unknown,
): AssessInputError | { readonly input: ExplainFunctionInput } {
  const shaped = parseSelectorInput(args, new Set(["address", "block", "selector", "view"]), "address, selector and view");
  if ("kind" in shaped) {
    return shaped;
  }
  const base = parseAddressAndBlock(shaped.record);
  if ("kind" in base) {
    return base;
  }
  const selector = parseSelectorField(shaped.record["selector"]);
  if (selector === null) {
    return {
      kind: "validation-error",
      message: "Invalid selector: expected 0x followed by 8 hex characters.",
    };
  }
  const view = shaped.record["view"];
  if (view !== "decompiled" && view !== "source") {
    return {
      kind: "validation-error",
      message: 'Invalid view: expected "decompiled" or "source".',
    };
  }
  return { input: Object.freeze({ address: base.address, block: base.block, selector, view }) };
}

export function parseDecompiledFunctionInput(
  args: unknown,
): AssessInputError | { readonly input: DecompiledFunctionInput } {
  const shaped = parseSelectorInput(args, new Set(["address", "block", "selector"]), "address and selector");
  if ("kind" in shaped) {
    return shaped;
  }
  const base = parseAddressAndBlock(shaped.record);
  if ("kind" in base) {
    return base;
  }
  const selector = parseSelectorField(shaped.record["selector"]);
  if (selector === null) {
    return {
      kind: "validation-error",
      message: "Invalid selector: expected 0x followed by 8 hex characters.",
    };
  }
  return { input: Object.freeze({ address: base.address, block: base.block, selector }) };
}

export function parseVerifiedSourceInput(
  args: unknown,
): AssessInputError | { readonly input: VerifiedSourceInput } {
  const shaped = parseSelectorInput(
    args,
    new Set(["address", "block", "functionSelector"]),
    "address with an optional functionSelector",
  );
  if ("kind" in shaped) {
    return shaped;
  }
  const base = parseAddressAndBlock(shaped.record);
  if ("kind" in base) {
    return base;
  }
  const rawSelector = shaped.record["functionSelector"];
  if (rawSelector === undefined) {
    return { input: Object.freeze({ address: base.address, block: base.block }) };
  }
  const selector = parseSelectorField(rawSelector);
  if (selector === null) {
    return {
      kind: "validation-error",
      message: "Invalid functionSelector: expected 0x followed by 8 hex characters.",
    };
  }
  return { input: Object.freeze({ address: base.address, block: base.block, functionSelector: selector }) };
}

// Validated list_new_tokens input: the optional chain (ethereum only)
// and the optional since instant (milliseconds since the epoch, as a
// digit string or a non-negative integer).
export type ListNewTokensInput = {
  readonly chain: "ethereum";
  readonly sinceMs?: number | undefined;
};

export function parseListNewTokensInput(
  args: unknown,
): AssessInputError | { readonly input: ListNewTokensInput } {
  if (args === undefined) {
    return { input: Object.freeze({ chain: "ethereum" as const }) };
  }
  const shaped = parseSelectorInput(args, new Set(["chain", "since"]), "an optional chain and since");
  if ("kind" in shaped) {
    return shaped;
  }
  const rawChain = shaped.record["chain"];
  if (rawChain !== undefined && rawChain !== "ethereum") {
    return { kind: "validation-error", message: "Invalid chain: expected ethereum." };
  }
  const rawSince = shaped.record["since"];
  if (rawSince === undefined) {
    return { input: Object.freeze({ chain: "ethereum" as const }) };
  }
  if (typeof rawSince === "string") {
    if (rawSince.length > MCP_MAX_BLOCK_CHARS || !/^\d+$/.test(rawSince)) {
      return { kind: "validation-error", message: "Invalid since: expected milliseconds since the epoch." };
    }
    return { input: Object.freeze({ chain: "ethereum" as const, sinceMs: Number(rawSince) }) };
  }
  if (typeof rawSince === "number") {
    if (!Number.isSafeInteger(rawSince) || rawSince < 0) {
      return { kind: "validation-error", message: "Invalid since: expected milliseconds since the epoch." };
    }
    return { input: Object.freeze({ chain: "ethereum" as const, sinceMs: rawSince }) };
  }
  return { kind: "validation-error", message: "Invalid since: expected milliseconds since the epoch." };
}

// Block context shared with the REST adapter: latest, a string of digits or
// a non-negative integer. Returns null for an invalid block.
function parseBlock(raw: string | number | undefined): BlockNumberType | "latest" | null {
  if (raw === undefined || raw === "latest") {
    return "latest";
  }
  if (typeof raw === "number") {
    const parsed = BlockNumber.of(raw);
    return parsed.ok ? parsed.value : null;
  }
  if (/^\d+$/.test(raw)) {
    const parsed = BlockNumber.of(Number(raw));
    return parsed.ok ? parsed.value : null;
  }
  return null;
}


