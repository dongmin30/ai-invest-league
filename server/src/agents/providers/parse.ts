import { DecisionSchema, type Decision } from '../schema';
import { AgentError } from '../types';

/** Removes reasoning blocks and a surrounding Markdown code fence some models add. */
export function cleanModelText(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  out = out.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(out);
  return fenced ? fenced[1]!.trim() : out;
}

/** JSON.parse + DecisionSchema; any failure is an `invalid` AgentError that keeps the raw text. */
export function parseDecision(raw: string): Decision {
  let value: unknown;
  try {
    value = JSON.parse(cleanModelText(raw));
  } catch {
    throw new AgentError('invalid', '응답이 올바른 JSON이 아닙니다.', raw);
  }
  const result = DecisionSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new AgentError('invalid', `응답 형식 오류: ${detail}`, raw);
  }
  return result.data;
}
