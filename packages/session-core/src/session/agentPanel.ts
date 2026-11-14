import type { AgentPanelMetrics } from '@kiki/protocol';
import type { AgentTokenUsage } from './agentTree';

export const UNKNOWN_AGENT_PANEL_METRICS: AgentPanelMetrics = Object.freeze({
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
  totalTokens: null, totalCostUsd: null, contextTokens: null, contextLimit: null,
  compactionCount: null,
});

export function panelTotalTokens(metrics: Pick<AgentPanelMetrics, 'totalTokens' | 'inputTokens' | 'outputTokens'>): number | null {
  if (metrics.totalTokens !== null) return metrics.totalTokens;
  return metrics.inputTokens === null || metrics.outputTokens === null ? null : metrics.inputTokens + metrics.outputTokens;
}

export function projectedAgentPanelMetrics(metrics: AgentPanelMetrics, total: AgentTokenUsage): AgentPanelMetrics {
  const inputTokens = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
  return {
    ...metrics, inputTokens, outputTokens: total.output,
    cacheReadTokens: total.inputCacheRead, cacheWriteTokens: total.inputCacheCreation,
    totalTokens: inputTokens + total.output, usagePartial: true, usageComplete: false,
  };
}

export function sumAgentTreeMetrics(
  agentIds: readonly string[],
  metrics: Readonly<Record<string, AgentPanelMetrics>>,
): { totalTokens: number | null; totalCostUsd: number | null } {
  const ids = [...new Set(agentIds)];
  const sum = (field: 'totalTokens' | 'totalCostUsd'): number | null => {
    if (ids.length === 0) return null;
    let result = 0;
    let known = false;
    for (const id of ids) {
      const metric = metrics[id];
      const value = metric === undefined ? null : field === 'totalTokens' ? panelTotalTokens(metric) : metric.totalCostUsd;
      if (value === null || value === undefined || !Number.isFinite(value) || value < 0) continue;
      known = true;
      result += value;
    }
    return known ? result : null;
  };
  return { totalTokens: sum('totalTokens'), totalCostUsd: sum('totalCostUsd') };
}
