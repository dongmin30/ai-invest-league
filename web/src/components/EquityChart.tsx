import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import type { EquitySeries } from '@shared/api-types';
import { formatDateTime, formatPctPoints } from '../lib/format';
import { useTheme, type ResolvedTheme } from '../lib/theme';

// Fixed-order categorical palette (validated for adjacent-pair CVD separation).
// AI agents take slots in participant order; the viewer always uses ink, other humans gray.
const AI_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
// Dark-mode variants are lightened so every line keeps contrast on the slate-800 card.
const AI_COLORS_DARK = ['#5aa2f0', '#f58a5c', '#3fd0a0', '#f0b52e', '#f09bbd', '#4cc24c', '#9a8cf2', '#f06b6a'];
const ME_COLOR = '#0f172a';
const ME_COLOR_DARK = '#f1f5f9';
const GRID = { light: '#e5e7eb', dark: '#334155' };
const AXIS = { light: '#cbd5e1', dark: '#475569' };
const TICK = { light: '#64748b', dark: '#94a3b8' };
const REF = { light: '#94a3b8', dark: '#64748b' };
const DOT_RING = { light: '#fff', dark: '#1e293b' };
const HUMAN_COLOR = '#a3a3a3';

interface SeriesStyle {
  key: string;
  series: EquitySeries;
  color: string;
  width: number;
  isMe: boolean;
}

type Row = { ts: number } & Record<string, number>;

function styleSeries(series: EquitySeries[], myParticipantId: number | null, theme: ResolvedTheme): SeriesStyle[] {
  const palette = theme === 'dark' ? AI_COLORS_DARK : AI_COLORS;
  const meColor = theme === 'dark' ? ME_COLOR_DARK : ME_COLOR;
  const ai = series.filter((s) => s.kind === 'ai').sort((a, b) => a.participant_id - b.participant_id);
  return series.map((s) => {
    const isMe = s.participant_id === myParticipantId;
    const aiIndex = ai.indexOf(s);
    const color = isMe ? meColor : aiIndex >= 0 ? palette[aiIndex % palette.length] : HUMAN_COLOR;
    return { key: `p${s.participant_id}`, series: s, color, width: isMe || aiIndex >= 0 ? 2 : 1.25, isMe };
  });
}

function ChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const entries = [...payload]
    .filter((p) => typeof p.value === 'number')
    .sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="max-w-[16rem] rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-slate-700 dark:text-slate-200">{formatDateTime(Number(label))}</div>
      <ul className="space-y-0.5">
        {entries.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
              <span className="truncate">{p.name}</span>
            </span>
            <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatPctPoints(Number(p.value))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EquityChart({ series, myParticipantId }: { series: EquitySeries[]; myParticipantId: number | null }) {
  const { resolved } = useTheme();
  const styles = useMemo(() => styleSeries(series, myParticipantId, resolved), [series, myParticipantId, resolved]);

  const rows = useMemo(() => {
    const byTs = new Map<number, Row>();
    for (const s of series) {
      for (const p of s.points) {
        const row = byTs.get(p.ts) ?? ({ ts: p.ts } as Row);
        row[`p${s.participant_id}`] = Number((p.return_rate * 100).toFixed(3));
        byTs.set(p.ts, row);
      }
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }, [series]);

  if (rows.length < 2) {
    return <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">수익률 기록이 아직 충분하지 않습니다. 스냅샷은 10분마다 저장됩니다.</p>;
  }

  // Draw humans first so AI lines and the viewer's line sit on top.
  const ordered = [...styles].sort((a, b) => Number(a.color !== HUMAN_COLOR) - Number(b.color !== HUMAN_COLOR) || Number(a.isMe) - Number(b.isMe));
  const hasOtherHumans = styles.some((s) => s.color === HUMAN_COLOR);

  return (
    <div>
      <div className="h-64 sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={GRID[resolved]} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => formatDateTime(v)}
              tick={{ fontSize: 11, fill: TICK[resolved] }}
              tickLine={false}
              axisLine={{ stroke: AXIS[resolved] }}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => `${v}%`}
              tick={{ fontSize: 11, fill: TICK[resolved] }}
              tickLine={false}
              axisLine={false}
              width={60}
            />
            <ReferenceLine y={0} stroke={REF[resolved]} />
            <Tooltip content={ChartTooltip} cursor={{ stroke: REF[resolved], strokeDasharray: '3 3' }} />
            {ordered.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.isMe ? `${s.series.display_name} (나)` : s.series.display_name}
                type="monotone"
                stroke={s.color}
                strokeWidth={s.width}
                dot={false}
                activeDot={{ r: 4, stroke: DOT_RING[resolved], strokeWidth: 2 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-slate-300">
        {styles
          .filter((s) => s.color !== HUMAN_COLOR)
          .map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded" style={{ backgroundColor: s.color }} />
              {s.isMe ? `${s.series.display_name} (나)` : s.series.display_name}
            </li>
          ))}
        {hasOtherHumans && (
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ backgroundColor: HUMAN_COLOR }} />
            다른 참가자 (상위 10명)
          </li>
        )}
      </ul>
    </div>
  );
}
