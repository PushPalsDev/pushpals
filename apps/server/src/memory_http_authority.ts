import {
  MEMORY_HTTP_AUTHORITY_HEADER,
  MEMORY_HTTP_CALLER_HEADER,
  REPOSITORY_AGENT_MEMORY_NAMESPACES,
  type MemoryHttpAuthority,
  type MemoryHttpCallerService,
} from "shared";

export type MemoryHttpOperation = "put" | "get" | "search" | "invalidate" | "reinforce" | "prune";

export interface MemoryHttpAccessDecision {
  allowed: boolean;
  message?: string;
  callerService?: MemoryHttpCallerService;
  authority?: MemoryHttpAuthority | null;
}

const CALLER_SERVICES = new Set<MemoryHttpCallerService>([
  "server",
  "localbuddy",
  "remotebuddy",
  "workerpals",
  "source_control_manager",
  "repository_agent",
  "cli",
  "client",
]);

const INTERNAL_NAMESPACES = new Set<string>(REPOSITORY_AGENT_MEMORY_NAMESPACES);

function callerServiceFromHeader(value: string | null): MemoryHttpCallerService | null {
  const normalized = String(value ?? "").trim() as MemoryHttpCallerService;
  return CALLER_SERVICES.has(normalized) ? normalized : null;
}

function authorityFromHeader(value: string | null): MemoryHttpAuthority | null | "invalid" {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized === "repository_agent" || normalized === "server" ? normalized : "invalid";
}

/**
 * Enforces least privilege inside the local control plane. These headers are an
 * auditable process capability, not a security boundary against a malicious
 * process that already controls localhost.
 */
export function authorizeMemoryHttpRequest(input: {
  headers: Headers;
  operation: MemoryHttpOperation;
  namespace?: string | null;
  reinforcementOutcome?: string | null;
}): MemoryHttpAccessDecision {
  const callerService = callerServiceFromHeader(input.headers.get(MEMORY_HTTP_CALLER_HEADER));
  if (!callerService) {
    return { allowed: false, message: "A recognized memory caller service is required" };
  }

  const authority = authorityFromHeader(input.headers.get(MEMORY_HTTP_AUTHORITY_HEADER));
  if (authority === "invalid") {
    return { allowed: false, message: "The requested memory authority is not recognized" };
  }
  if (authority === "repository_agent" && callerService !== "repository_agent") {
    return { allowed: false, message: "RepositoryAgent memory authority is not valid here" };
  }
  if (authority === "server" && callerService !== "server") {
    return { allowed: false, message: "Server memory authority is not valid here" };
  }

  const namespace = String(input.namespace ?? "").trim();
  const isInternalNamespace = INTERNAL_NAMESPACES.has(namespace);
  const hasServerAuthority = callerService === "server" && authority === "server";
  if (input.operation === "prune" && (!namespace || isInternalNamespace) && !hasServerAuthority) {
    return {
      allowed: false,
      message: "Global and RepositoryAgent memory pruning is reserved for Server",
    };
  }
  const repositoryAgentConfirmation =
    input.operation === "reinforce" &&
    isInternalNamespace &&
    authority === "repository_agent" &&
    input.reinforcementOutcome === "confirmed";
  if (
    input.operation === "reinforce" &&
    isInternalNamespace &&
    !hasServerAuthority &&
    !repositoryAgentConfirmation
  ) {
    return {
      allowed: false,
      message: "RepositoryAgent memory reinforcement is reserved for Server",
    };
  }
  if (isInternalNamespace && authority !== "repository_agent" && authority !== "server") {
    return {
      allowed: false,
      message: `Memory namespace ${namespace} is internal to RepositoryAgent`,
    };
  }

  return { allowed: true, callerService, authority };
}

export function memoryHttpReinforcementOutcome(body: Record<string, unknown>): unknown {
  const input = body.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return (input as { outcome?: unknown }).outcome;
}

export function memoryHttpNamespace(
  operation: MemoryHttpOperation,
  body: Record<string, unknown>,
): string | null {
  const input =
    operation === "get"
      ? body.address
      : operation === "search"
        ? body.query
        : operation === "invalidate"
          ? body.selector
          : operation === "prune"
            ? body.options
            : body.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const scope = (input as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const namespace = (scope as { namespace?: unknown }).namespace;
  return typeof namespace === "string" ? namespace.trim() : null;
}
