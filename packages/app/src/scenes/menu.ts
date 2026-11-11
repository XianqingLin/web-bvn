/**
 * 主菜单（切片 14 骨架）：标题 + 单机训练 / 联机对战 两个入口。
 */
import { Container } from 'pixi.js';
import type { Scene, SceneCtx } from './scene.js';
import { makeButton, makeLabel, makePanel, UI_H, UI_W } from '../ui.js';
import type { Flow } from '../flow.js';
import { SetupScene } from './setup.js';
import { NetScene } from './net.js';

export class MenuScene implements Scene {
  readonly name = 'menu';

  constructor(private readonly flow: Flow) {}

  enter({ root, switchTo }: SceneCtx): void {
    const ui = new Container();
    root.addChild(ui);

    // 背景
    const bg = makePanel(UI_W, UI_H, { color: 0x0a0e1a, alpha: 1 });
    ui.addChild(bg);

    const title = makeLabel('死神 VS 火影', { size: 56, color: 0xffffff, bold: true });
    title.anchor.set(0.5);
    title.position.set(UI_W / 2, 160);
    const sub = makeLabel('BVN Web —— 确定性帧同步重构版', { size: 16, color: 0x7a86a0 });
    sub.anchor.set(0.5);
    sub.position.set(UI_W / 2, 208);
    ui.addChild(title, sub);

    const soloBtn = makeButton('单机训练', () => {
      this.flow.mode = 'solo';
      switchTo(new SetupScene(this.flow));
    });
    soloBtn.position.set(UI_W / 2 - 100, 300);
    const netBtn = makeButton('联机对战', () => {
      this.flow.mode = 'net';
      switchTo(new NetScene(this.flow));
    });
    netBtn.position.set(UI_W / 2 - 100, 360);
    ui.addChild(soloBtn, netBtn);

    const hint = makeLabel(
      'P1 键位：WASD 移动 / J 攻击 / K 跳 / L 瞬步 / U 技 / I 必杀 / O 辅助',
      { size: 13, color: 0x66708a },
    );
    hint.anchor.set(0.5, 1);
    hint.position.set(UI_W / 2, UI_H - 16);
    ui.addChild(hint);
  }

  exit(): void {}
}
