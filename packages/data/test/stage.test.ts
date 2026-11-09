import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { compileMapStage } from '../src/stage.js';
import { loadMapPackage } from '../src/load.node.js';

const BAKED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../baked');

describe('compileMapStage（MapPackage → core 舞台几何）', () => {
  it('KonohaMura：边界/主地面/死亡线/平台段（快照守卫）', () => {
    const pkg = loadMapPackage(BAKED_DIR, 'KonohaMura');
    const { stage, p1Spawn, p2Spawn } = compileMapStage(pkg);
    expect(stage.leftBound).toBe(0);
    expect(stage.rightBound).toBe(1000);
    expect(stage.groundY).toBe(570);
    expect(stage.bottomY).toBe(600);
    expect(p1Spawn).toEqual({ x: 387.85, y: 570 });
    expect(p2Spawn).toEqual({ x: 638.85, y: 570 });
    // 平台段按 xFrom 升序，形状为 {xFrom,xTo,y}（name 不进 core）
    expect(stage.floors.length).toBe(9);
    for (let i = 1; i < stage.floors.length; i++) {
      expect(stage.floors[i]!.xFrom).toBeGreaterThanOrEqual(stage.floors[i - 1]!.xFrom);
    }
    expect(stage.floors[0]).toEqual({ xFrom: 29.05, xTo: 153.4, y: 459.35 });
  });

  it('无出生点标注的地图 → spawns 为 null（合成包单测；当前 baked 均有出生点）', () => {
    const { p1Spawn, p2Spawn } = compileMapStage({
      schema: 'bvn/map@1',
      id: 'synthetic',
      name: 'synthetic',
      source: { kind: 'runtime-dump', path: 'x', hash: 'x' },
      bgm: '',
      fileUrl: '',
      gameSize: { x: 800, y: 600 },
      left: 0,
      right: 1000,
      bottom: 600,
      playerBottom: 570,
      p1pos: null,
      p2pos: null,
      floors: [],
    });
    expect(p1Spawn).toBeNull();
    expect(p2Spawn).toBeNull();
  });
});

describe('loadMapPackage（加载器校验门禁）', () => {
  it('全部 baked 地图通过校验', () => {
    const ids = [
      'DanGai', 'Forest', 'GenSe', 'GoteiJusantai', 'HotSpring', 'KirinoMura',
      'KonohaMura', 'Roof', 'Rukongai', 'Seireitei', 'ShumatsuNoTani', 'Sokyoku',
      'UchihaMura', 'UchinaruSekai', 'ZangetsuHaka',
    ];
    for (const id of ids) {
      expect(() => loadMapPackage(BAKED_DIR, id)).not.toThrow();
    }
  });

  it('不存在/坏 schema 抛错', () => {
    expect(() => loadMapPackage(BAKED_DIR, 'NoSuchMap')).toThrow(/读取失败|ENOENT/);
  });
});
