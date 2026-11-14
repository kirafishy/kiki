# Prompt cache stability

Keep provider request prefixes stable when runtime descriptions or extension state change. `agent/llmRequester/promptCacheWindow.ts` owns the requester's in-memory snapshots; `llmRequesterService.ts` binds them to the context-window epoch, profile render generation, and prompt binding revision. Compaction, model-window changes, profile rebinding, and destructive context splices discard those snapshots.

## Tools and loaded schemas

Default tools keep their exact descriptions across ordinary turns while their ordered names, parameter schemas, deferred flags, and resolved prompt-field values and variables remain unchanged. Each active turn retains its tool snapshot. A new turn checks the structural signature and refreshes it when tools or schemas change. Explicit tool overrides and operation requests use their supplied or current tools directly.

For non-Kimi Anthropic requests, loaded schemas become chronological user text in `<dynamic_tool_schemas>`. The provider merges that text after the selecting call's tool results; it never adds it to the top-level system blocks. OpenAI protocols retain their system-role projection, and Kimi retains native message tool schemas. Tool selection's historical disabled-tool filtering still applies.

## Live extension sections

For ordinary turn requests without an explicit system-prompt override, the first extension section text remains in the system prompt for the window. A changed rendering adds a user-role `<system-reminder>` containing the replacement state. Empty text explicitly reports that no sections are active.

These reminders exist only in the request projection. Retain each reminder at its original history boundary so later requests preserve the earlier prefix. Place a new reminder before the active step's trailing partial assistant placeholder: that placeholder will become the response to the request. Completed tool results stay before the reminder, preserving tool-call/result adjacency. Operation requests and explicit system-prompt overrides continue using the live rendering directly.

Pass the canonical context references, rather than the projected reminder history, to token measurement. The anchor records full provider usage, including the request-only reminders, so later request budgets and automatic compaction include that cost.

Regression coverage lives in `test/agent/llmRequester/llmRequesterService.test.ts`, `test/agent/llmRequester/dynamicToolProjection.test.ts`, and `test/kosong/provider/composition.test.ts`. Keep their prefix, partial-response, tool-result, and token-anchor assertions when changing request preparation.
