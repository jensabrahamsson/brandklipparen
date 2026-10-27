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
export const TOOL_LIST_VERSION = "1.1.0";
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
// On-request Muse contract assessment (S-038, K-305, K-309): a separate
// reading tool over the shared assessment service. Scores and evidence
// pass through untouched; the assessment lands in its own labelled field.
export const REQUEST_ASSESSMENT_TOOL = "request_assessment";
export const REQUEST_ASSESSMENT_VERSION = "1.0.0";

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


