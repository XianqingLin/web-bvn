/** 节点择优纯逻辑单测（docs/server-selection.md §3）。 */
import { describe, expect, it } from 'vitest';
import {
  decide, score, SELECT_TTL_MS,
  type NodeManifest, type NodePreference, type ProbeResult,
} from '../src/node-select.js';

const manifest: NodeManifest = {
  version: 1,
  autoSelectEnabled: true,
  matchNode: 'cn',
  nodes: [
    { id: 'cn', name: '国内', url: 'wss://cn', enabled: true },
    { id: 'cf', name: '外服', url: 'wss://cf', enabled: true },
    { id: 'off', name: '下线', url: 'wss://off', enabled: false },
  ],
};
const probe = (nodeId: string, ok: boolean, p50: number, p95 = p50, queue = 0): ProbeResult =>
  ({ nodeId, ok, rttP50: p50, rttP95: p95, queue });

describe('score 评分', () => {
  it('失败节点得 Infinity', () => {
    expect(score(probe('x', false, 0))).toBe(Infinity);
  });
  it('抖动越大分越高，负载越大分越高', () => {
    const steady = score(probe('x', true, 50, 55));
    const jittery = score(probe('x', true, 50, 120));
    const loaded = score(probe('x', true, 50, 55, 4));
    expect(jittery).toBeGreaterThan(steady);
    expect(loaded).toBeGreaterThan(steady);
  });
});

describe('decide 决策', () => {
  const auto: NodePreference = { mode: 'auto' };

  it('强制地址优先级最高，跳过择优', () => {
    const sel = decide(manifest, auto, 'ws://forced', [probe('cn', true, 10)]);
    expect(sel.reason).toBe('forced');
    expect(sel.url).toBe('ws://forced');
  });

  it('auto：探测结果按评分选最优（国内 RTT 低胜出）', () => {
    const sel = decide(manifest, auto, null, [probe('cn', true, 100), probe('cf', true, 900)]);
    expect(sel.nodeId).toBe('cn');
    expect(sel.reason).toBe('auto');
  });

  it('auto：抖动惩罚能翻盘（p95 不稳的节点落败）', () => {
    const sel = decide(manifest, auto, null, [
      probe('cn', true, 100, 400), // 评分 100 + 300 = 400
      probe('cf', true, 150, 160), // 评分 150 + 10 = 160 → 胜
    ]);
    expect(sel.nodeId).toBe('cf');
  });

  it('auto：缓存有效期内沿用 lastResult（免测速场景）', () => {
    const pref: NodePreference = {
      mode: 'auto',
      lastResult: { nodeId: 'cf', rttP50: 900, jitter: 10, at: Date.now() },
    };
    const sel = decide(manifest, pref, null, [], Date.now());
    expect(sel.nodeId).toBe('cf');
    expect(sel.reason).toBe('auto');
  });

  it('auto：缓存过期则忽略，按新探测结果选', () => {
    const pref: NodePreference = {
      mode: 'auto',
      lastResult: { nodeId: 'cf', rttP50: 900, jitter: 10, at: Date.now() - SELECT_TTL_MS - 1 },
    };
    const sel = decide(manifest, pref, null, [probe('cn', true, 100)], Date.now());
    expect(sel.nodeId).toBe('cn');
  });

  it('autoSelectEnabled=false：不走择优，退回 matchNode', () => {
    const off = { ...manifest, autoSelectEnabled: false };
    const sel = decide(off, auto, null, [probe('cn', true, 100), probe('cf', true, 50)]);
    expect(sel.nodeId).toBe('cn');
    expect(sel.reason).toBe('fallback');
  });

  it('manual：锁定节点（即使 RTT 高）', () => {
    const pref: NodePreference = { mode: 'manual', manualId: 'cf' };
    const sel = decide(manifest, pref, null, [probe('cn', true, 100), probe('cf', true, 900)]);
    expect(sel.nodeId).toBe('cf');
    expect(sel.reason).toBe('manual');
  });

  it('manual：锁定节点不可用 → 降级到可用最优（fallback）', () => {
    const pref: NodePreference = { mode: 'manual', manualId: 'cf' };
    const sel = decide(manifest, pref, null, [probe('cf', false, 0), probe('cn', true, 100)]);
    expect(sel.nodeId).toBe('cn');
    expect(sel.reason).toBe('fallback');
  });

  it('disabled 节点不参与选择与兜底', () => {
    const pref: NodePreference = { mode: 'manual', manualId: 'off' };
    const sel = decide(manifest, pref, null, [probe('off', false, 0), probe('cf', true, 200)]);
    expect(sel.nodeId).toBe('cf');
  });

  it('全部探测失败且无缓存 → matchNode 兜底', () => {
    const sel = decide(manifest, auto, null, [probe('cn', false, 0), probe('cf', false, 0)]);
    expect(sel.nodeId).toBe('cn');
    expect(sel.reason).toBe('fallback');
  });
});
