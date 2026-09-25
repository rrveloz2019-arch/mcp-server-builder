// Shared types for the generated server. The generator fills these from the
// manifest; the runtime reads them. Nothing here talks to the network.
import type { z } from "zod/v4";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestTemplate {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ResponseBinding {
  itemsPath?: string;
  recordPath?: string;
  nextCursorPath?: string;
  /** Field map name resolved to the map itself; undefined means raw. */
  fields?: Record<string, string>;
}

export interface LongRunning {
  jobIdPath?: string;
  statusRequest: RequestTemplate;
  statusPath: string;
  doneValues: string[];
  failedValues?: string[];
  progressPath?: string;
  resultRequest?: RequestTemplate;
  pollIntervalMs: number;
  timeoutMs: number;
}

export type ToolKind = "read" | "write" | "destructive";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  scope?: string;
  idempotent: boolean;
  requireConfirmation: boolean;
  maxTotal?: number;
  deprecated: boolean;
  replacedBy?: string;
  request: RequestTemplate;
  response: ResponseBinding;
  longRunning?: LongRunning;
  /** Output shape: record, list, write (preview/done) or job. */
  shape: "record" | "list" | "write" | "job";
  input: z.ZodObject<any>;
  output: z.ZodObject<any>;
}

export interface ResourceDef {
  name: string;
  title: string;
  description: string;
  uri: string;
  mimeType: string;
  scope?: string;
  /** Path under assets/ for file resources. */
  file?: string;
  request?: RequestTemplate;
  response?: ResponseBinding;
  list?: RequestTemplate;
  listResponse?: ResponseBinding;
}

export interface PromptArg {
  description?: string;
  required: boolean;
  completeFrom?: string;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  scope?: string;
  args: Record<string, PromptArg>;
  template: string;
  embedResources: string[];
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  burst?: number;
}

export type UpstreamAuth =
  | { type: "none" }
  | { type: "api_key"; in: "header" | "query"; name: string; valueEnv: string }
  | { type: "bearer"; tokenEnv: string }
  | { type: "basic"; usernameEnv: string; passwordEnv: string }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientIdEnv: string; clientSecretEnv: string; scopes?: string[] };

export interface ApiKeyClient {
  clientId: string;
  keyHashEnv: string;
  scopes: string[];
  context: Record<string, string>;
  rateLimit?: RateLimitConfig;
}

export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  scopeClaim: string;
  contextClaims: Record<string, string>;
  rateLimit?: RateLimitConfig;
}

export interface ServerConfig {
  company: { name: string; defaultCurrency: string };
  server: {
    name: string;
    version: string;
    instructions?: string;
    transports: ("stdio" | "http")[];
    http: { port: number; path: string; publicUrl?: string };
  };
  api: {
    baseUrl: string;
    timeoutMs: number;
    headers: Record<string, string>;
    auth: UpstreamAuth;
    rateLimit?: RateLimitConfig;
  };
  access: {
    stdioScopes: string[];
    apiKeys: ApiKeyClient[];
    oauth?: OAuthConfig;
  };
  audit: {
    enabled: boolean;
    sink: "stderr" | "file" | "http";
    path?: string;
    url?: string;
    includeArguments: boolean;
    redactFields: string[];
  };
}

/** Who is calling. Built once per connection (stdio) or per HTTP request. */
export interface ClientIdentity {
  clientId: string;
  /** Key used for per-client rate limiting. */
  rateKey: string;
  scopes: Set<string>;
  context: Record<string, string>;
  rateLimit?: RateLimitConfig;
}
