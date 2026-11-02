import type { AgentInfo } from '@shared/api-types';
import { PROVIDER_LABEL } from '../lib/format';
import { Badge } from './ui';

export function ProviderBadge({ agent }: { agent: Pick<AgentInfo, 'provider'> }) {
  const tone = agent.provider === 'claude' ? 'orange' : agent.provider === 'ollama' ? 'sky' : 'slate';
  return <Badge tone={tone}>{PROVIDER_LABEL[agent.provider]}</Badge>;
}

export function AgentStatus({ agent }: { agent: AgentInfo }) {
  return agent.enabled ? (
    <Badge tone="emerald">활성</Badge>
  ) : (
    <Badge tone="rose">비활성{agent.disabled_reason ? ` · ${agent.disabled_reason}` : ''}</Badge>
  );
}
