/**
 * Agent discovery types are shared with the subagents extension so task-related prompts
 * and helpers stay aligned with the live named-agent contract.
 */

export type { AgentConfig, AgentDiscoveryResult, AgentScope } from "../subagents/agents.js";
export { discoverAgents, formatAgentList } from "../subagents/agents.js";
