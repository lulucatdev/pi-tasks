# Tasks V2 Final Specification

Status: Final pre-implementation
Owner: pi-tools
Scope: replace the current named-agent `task` model with a root-only parallel `tasks` model

## 1. Decision

This document is the final pre-implementation specification for the new `tasks` system.

The system SHALL use `tasks` as a root-only parallel execution primitive.

The system MAY also expose `task` as a root-only single-task convenience wrapper over `tasks`.

The system SHALL NOT use named subagents for task execution.

A task worker is not an agent identity. A task worker is only an isolated execution unit created by the current root agent.

Each task MAY have an optional human-readable `name`.
Each task MUST have a system-generated 6-digit numeric `id`.

Task workers MUST inherit the root agent's execution environment, except they MUST NOT have access to `tasks`.

Nested task creation is forbidden.

## 2. Why This Exists

The current task model leaks internal dispatch details into the user experience:
- named subagents such as `general` or `scout`
- source and scope metadata such as `user`, `project`, `both`, `unknown`
- registry lookup failures that appear as task failures
- UI output such as `ERR general (unknown)` that exposes the wrong abstraction

This specification removes those concepts from task execution.

The new model is intentionally simple:
- one root agent
- many parallel leaf workers
- task identity comes from the work item itself, not from worker roles

## 3. Goals

The implementation MUST satisfy all of the following:

- provide a true fan-out / fan-in primitive for parallel work
- allow one `tasks(...)` call to launch many workers in parallel
- remove agent identity, source, and scope from task execution and task UI
- give each task a useful display identity through `name + id`
- make task output easy to attribute in partial updates, logs, and final results
- prohibit nested orchestration so the topology stays one level deep
- preserve the root agent as the only planner and orchestrator

## 4. Non-Goals

This version SHALL NOT include:

- named subagents
- agent categories such as `general`, `scout`, `reviewer`, `planner`
- `agent`, `agentScope`, or `agentSource` fields
- nested tasks
- task graphs or DAGs
- task-to-task communication
- role-specific prompts for different task workers
- a separate planner plugin or planner agent
- a complex async orchestration API

This version MAY include a root-only `task` wrapper as syntax sugar for launching exactly one task worker.

## 5. Core Mental Model

There is only one agent identity in the system: the current root agent.

`tasks` is not an agent selector.
`tasks` is not a role selector.
`tasks` is not a workflow DSL.

`tasks` is a runtime primitive that allows the root agent to submit one or more work items and have them executed as isolated leaf workers.

The root agent is responsible for:
- deciding whether to parallelize
- splitting work into task items
- choosing helpful task names
- interpreting the returned results
- deciding whether to launch another round of tasks

A task worker is responsible only for:
- executing its assigned work item
- returning output or an explicit error
- terminating

## 6. Topology

The allowed execution topology is exactly:

```text
root agent
  ├─ task worker 1
  ├─ task worker 2
  ├─ task worker 3
  └─ ...
```

The following topology is forbidden:

```text
root agent
  └─ task worker A
       └─ task worker B
```

This is a deliberate design constraint. The system is root-orchestrated and leaf-only.

## 7. Terminology

### Root Agent
The current main execution context. Only the root agent may invoke `tasks`.

### Task Worker
An isolated execution context created by `tasks` to perform a single work item.

### Task Spec
The input object describing one requested work item.

### Task Run
The runtime instance of a task spec, including generated `id`, lifecycle state, and result.

### Name
An optional human-readable label describing the work item.

### ID
A system-generated 6-digit numeric string identifying a task run within the current session.

## 8. Tool Contract

### Tool Names

Primary tool:
- `tasks`

Optional convenience wrapper:
- `task`

### Input Shape

```ts
type TaskInput = {
  task: string
  name?: string
  cwd?: string
}

type TasksInput = {
  tasks: TaskSpec[]
}

type TaskSpec = {
  task: string
  name?: string
  cwd?: string
}
```

### Input Rules

The implementation MUST enforce the following:

- `tasks` is required
- `tasks` MUST contain at least one item
- each `task` MUST be a non-empty string
- each `name`, if present, MUST be a non-empty string
- `cwd` is optional and defaults to the root agent current working directory
- the runtime MAY enforce a maximum task count per call
- the runtime MUST support at least 8 tasks in a single call
- exceeding the limit MUST return a clear explicit error

### Examples

Valid:

```ts
tasks({
  tasks: [
    { name: "find-schemas", task: "Locate all schema files related to interview coach" },
    { name: "trace-controller-flow", task: "Trace controller -> context -> schema flow" },
    { name: "tests", task: "Find tests covering this path" }
  ]
})
```

Also valid:

```ts
tasks({
  tasks: [
    { task: "Locate all schema files related to interview coach" }
  ]
})
```

Also valid when the convenience wrapper is exposed:

```ts
task({
  name: "find-schemas",
  task: "Locate all schema files related to interview coach"
})
```

Invalid:

```ts
tasks({ tasks: [] })
```

Invalid:

```ts
tasks({
  tasks: [
    { name: "", task: "Locate all schema files" }
  ]
})
```

## 9. Task Identity

### 9.1 Name

`name` is optional task metadata.

`name` SHALL be interpreted as a label for the work item, not a label for the worker.

`name` MAY be used for:
- UI display
- streamed output attribution
- logs
- summaries
- root-agent reasoning and fan-in synthesis

`name` MUST NOT be used for:
- agent selection
- prompt role selection
- permissions
- tool filtering
- model selection
- uniqueness

Good examples:
- `find-schemas`
- `trace-controller-flow`
- `tests`
- `extract-finalization-path`

Bad examples:
- `general`
- `scout`
- `planner`

Those bad examples describe worker identity instead of work-item meaning.

### 9.2 ID

Each task run MUST receive an `id` generated by the runtime.

The `id` rules are mandatory:
- exactly 6 characters
- all characters are decimal digits
- represented as a string, not an integer
- leading zeroes MUST be preserved
- generated automatically by the runtime
- unique within the current session
- collisions MUST be handled by regeneration before task run creation completes

Examples:
- `042731`
- `518204`
- `091553`

`id` is the stable machine reference.
`name` is optional human context.

### 9.3 Display Identity

The canonical display format SHALL be:
- if `name` exists: `{name} · {id}`
- otherwise: `task · {id}`

Examples:
- `find-schemas · 042731`
- `trace-controller-flow · 518204`
- `task · 091553`

The `id` MUST always be displayed.
The `name` MUST NOT replace the `id`.

## 10. Execution Semantics

When the root agent invokes `tasks`, the runtime MUST do the following in order:

1. validate the input
2. allocate a task run for each task spec
3. generate a 6-digit numeric `id` for each task run
4. create one isolated worker per task run
5. submit all workers as one parallel launch set
6. wait for all workers to finish
7. return structured final results to the root agent

The runtime MUST NOT silently degrade a single `tasks(...)` call into model-driven serial `task` dispatch.

Parallelism is a semantic property of the tool, not an optimization hint.

## 11. Parallelism Rules

The following are mandatory:

- all tasks from one `tasks(...)` call MUST be treated as one parallel submission set
- the root agent MUST be able to request multiple tasks in one call
- the runtime MAY apply internal worker scheduling or concurrency limits
- internal scheduling MUST NOT change the external API semantics
- the implementation MUST NOT emulate parallelism by requiring repeated model calls

If the runtime needs to queue some workers because of local resource limits, that is allowed, but the API remains a single batched parallel submission from the root agent perspective.

## 12. Environment Inheritance

Each task worker MUST inherit the root agent's current execution environment, including:

- current model
- current provider configuration
- current system prompt
- current appended system prompt
- current working directory unless overridden by task `cwd`
- current toolset, except for `tasks`
- current extensions, skills, and custom tools
- current aggregated `AGENTS.md` context
- current sandbox restrictions
- current network restrictions
- current approval restrictions
- the minimal necessary summarized conversational context

Each task worker MUST NOT inherit:
- `tasks`

This design means task workers inherit execution authority, but not orchestration authority.

## 13. Root-Only Rule

Only the root agent may invoke `tasks`.

The implementation MUST enforce this in two layers:

1. exposure layer
- task workers MUST NOT see `tasks` in their visible tool list

2. runtime enforcement layer
- if a task worker somehow attempts to invoke `tasks`, the runtime MUST reject the call explicitly

Required error messages:
- `Only the root agent can create tasks`
- `Nested task invocation is not allowed`

## 14. Worker Lifecycle

The runtime lifecycle states are:

```ts
type TaskStatus = "queued" | "running" | "success" | "error" | "aborted"
```

Meaning:
- `queued`: task run has been accepted and registered but has not started execution
- `running`: worker has started execution
- `success`: worker completed normally
- `error`: worker failed during bootstrap or runtime execution
- `aborted`: worker was canceled

### 14.1 Final Result Constraint

The final returned `results` MUST NOT contain `queued` or `running`.

The only allowed final states are:
- `success`
- `error`
- `aborted`

### 14.2 State Transitions

Allowed transitions:

```text
queued -> running
queued -> error
queued -> aborted
running -> success
running -> error
running -> aborted
```

Forbidden transitions:

```text
success -> *
error -> *
aborted -> *
```

Once a task reaches a terminal state, it MUST NOT transition again.

## 15. Result Contract

```ts
type TasksResult = {
  results: TaskResult[]
  summary: {
    total: number
    success: number
    error: number
    aborted: number
  }
}

type TaskResult = {
  id: string
  name?: string
  task: string
  cwd: string
  status: "success" | "error" | "aborted"
  output?: string
  error?: string
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    turns?: number
  }
}
```

The implementation MUST satisfy all of the following:

- `results` MUST preserve input order
- each returned item MUST include `id`, `task`, `cwd`, and final `status`
- `error` MUST be present when `status` is `error`
- `output` MAY be missing or empty when `status` is `success`
- `summary` MUST reflect the actual terminal counts in `results`

## 16. Streaming and Attribution

If the implementation supports streaming updates, each update MUST be attributable to exactly one task run.

Each streamed or partial message MUST carry task identity using the same canonical format:
- `{name} · {id}` if `name` exists
- `task · {id}` otherwise

This requirement applies to:
- progress messages
- partial output
- tool logs
- final messages
- errors

The system MUST NOT emit anonymous task output.

## 17. Empty Output Behavior

Empty output is not itself an error.

The implementation MUST follow these rules:
- if a worker completes normally with no textual output, final state is `success`
- UI MAY display `(no output)` only when the task succeeded and truly produced no textual output
- failed tasks MUST display an explicit failure reason
- bootstrap failures and runtime failures MUST NOT be collapsed into `(no output)`

This rule exists specifically to avoid regressions such as hidden failures appearing as empty output.

## 18. Error Model

The implementation SHOULD classify internal failures into these categories:
- `bootstrap_error`
- `runtime_error`
- `empty_result`

External behavior is mandatory:
- `bootstrap_error` MUST produce `status: "error"`
- `runtime_error` MUST produce `status: "error"`
- `empty_result` MUST NOT produce `status: "error"` by itself

User-visible error text MUST be explicit and concrete.

Good examples:
- `worker bootstrap failed`
- `process exited before producing output`
- `cwd does not exist`
- `task count exceeds maximum`
- `Nested task invocation is not allowed`

Forbidden user-facing ambiguity:
- `unknown`
- `invalid state`
- `(no output)` for a failed task
- any message that exposes agent source or scope metadata

## 19. Cancellation

If the user aborts an in-flight `tasks(...)` call, the runtime MUST:
- cancel all still-running workers
- preserve completed results where possible
- mark canceled workers as `aborted`
- avoid re-labeling cancellation as generic failure

If cancellation happens during bootstrap, affected task runs MUST still terminate into either `aborted` or `error` with an explicit reason.

## 20. Security and Permission Boundary

Task workers MUST NOT exceed the root agent's current authority.

Mandatory rules:
- workers inherit the root agent's current sandbox boundary
- workers inherit the root agent's current network boundary
- workers inherit the root agent's current approval boundary
- workers MUST NOT gain broader permissions through task spawning
- `tasks` MUST NOT function as a privilege escalation mechanism

The worker inherits the current authority snapshot, not the maximum possible authority of the runtime.

## 21. UI Requirements

Task UI MUST be fully de-agentized.

The UI MUST NOT display:
- agent names
- agent categories
- agent sources
- agent scopes
- `user`
- `project`
- `both`
- `unknown`

The UI MUST display:
- task identity using `name + id` or `task + id`
- task status
- the original task prompt in expanded view
- output or error

### 21.1 Collapsed View

Collapsed view MUST show:
- an overall summary line
- one line per task with identity and status

Example:
- `TASKS complete: 2 success, 1 error`
- `find-schemas · 042731`
- `trace-controller-flow · 518204`
- `tests · 091553 error`

### 21.2 Expanded View

Expanded view MUST show for each task:
- display identity
- terminal status
- original task text
- output or error
- optional usage metadata

Example:
- `find-schemas · 042731`
- `status: success`
- `task: Locate all schema files related to interview coach`
- `output: Found 4 schema files ...`

## 22. Slash Command

The system SHALL provide a dedicated user command for the task dashboard.

To avoid colliding with the `task` and `tasks` model tools, the command SHOULD be named `/tasks-ui`.

Initial command set:
- `/tasks-ui` — list recent task runs in the current session
- `/tasks-ui <id>` — show details for one task run
- `/tasks-ui abort <id>` — abort a running task run
- `/tasks-ui logs <id>` — show logs or output for one task run

The system SHALL NOT provide `/task` or `/tasks` slash commands that directly execute task workers.
Execution must come from root-agent reasoning followed by a tool call, not from bypassing the root agent with a slash command.

This slash command is user-facing and separate from the model tools.

The slash command MUST use the same task identity rules as the tool and UI.

## 23. Invalid Input and Required Errors

The implementation MUST produce explicit errors for:
- empty `tasks`
- empty `task` string
- invalid or inaccessible `cwd`
- task count exceeding the configured limit
- nested `tasks` invocation

Error messages MUST be direct, concrete, and actionable.

The implementation MUST NOT fall back to hidden defaults that make debugging harder.

## 24. Example

### Input

```ts
tasks({
  tasks: [
    {
      name: "find-schemas",
      task: "Locate all schema files related to interview coach"
    },
    {
      name: "trace-controller-flow",
      task: "Trace controller -> context -> schema flow"
    },
    {
      name: "tests",
      task: "Find tests covering this path"
    }
  ]
})
```

### Output

```json
{
  "results": [
    {
      "id": "042731",
      "name": "find-schemas",
      "task": "Locate all schema files related to interview coach",
      "cwd": "/Users/lucas/Developer/knowecon",
      "status": "success",
      "output": "Found 4 schema files ..."
    },
    {
      "id": "518204",
      "name": "trace-controller-flow",
      "task": "Trace controller -> context -> schema flow",
      "cwd": "/Users/lucas/Developer/knowecon",
      "status": "success",
      "output": "The flow is controller -> context -> schema ..."
    },
    {
      "id": "091553",
      "name": "tests",
      "task": "Find tests covering this path",
      "cwd": "/Users/lucas/Developer/knowecon",
      "status": "error",
      "error": "No matching tests found"
    }
  ],
  "summary": {
    "total": 3,
    "success": 2,
    "error": 1,
    "aborted": 0
  }
}
```

## 25. Implementation Consequences

The existing named-agent task system MUST be retired.

The following concepts are removed from task execution:
- `task` as a single-agent-dispatch abstraction over named subagents
- `agent`
- `agentScope`
- `agentSource`
- named subagent registries used for task execution
- task UI based on worker identity

Existing output such as `ERR general (unknown)` MUST disappear entirely.

Useful old labels MAY be migrated only if they describe work-item meaning and are stored as optional `name` values.

## 26. Acceptance Criteria

The implementation is not complete until all of the following are true:

- the root agent can call `task` for one isolated task item
- the root agent can call `tasks` with multiple task items in a single invocation
- all task items from one `tasks` invocation are launched in parallel semantics
- each task run gets a generated 6-digit numeric string `id`
- optional `name` is preserved through execution and result reporting
- task workers cannot invoke `tasks`
- task workers do not expose agent/source/scope metadata
- final results preserve input order
- failed tasks return explicit errors rather than `(no output)` or `unknown`
- TUI and slash command show `name + id` or `task + id`
- old named-agent task identity no longer appears anywhere in task UX

## 27. Deferred Work

The following are intentionally deferred and are not required for the first implementation:
- async batch handles or batch IDs
- retry support
- task priorities
- task dependencies
- richer incremental aggregation
- cross-task shared caches

Those can be considered later without changing the core model in this document.
