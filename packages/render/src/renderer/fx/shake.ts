/**
 * ShakeFx —— 世界抖动/持续震屏（自 renderer.ts 拆出，纯搬移）：
 * 原版 EffectCtrler.shake/renderShakeX/Y/startShake/endShake 语义。
 * 输出 offX/offY 由编排器叠加到 world+bgFixed（原版 = gameStage 整体位移）。
 */
import type { SimSnapshot } from '@bvn/core';

export class ShakeFx {
  /** 世界抖动（原版 EffectCtrler.renderShakeX/Y：30fps 步进，pow 逐 2 帧线性衰减、
   *  direct 逐帧翻转；offset 应用到 world+bgFixed（原版 = gameStage 整体位移） */
  private st = {
    powX: 0,
    powY: 0,
    dxX: 1,
    dxY: 1,
    frameX: 0,
    frameY: 0,
    loseX: 0,
    loseY: 0,
    holdX: 0,
    holdY: 0,
  };
  private accMs = 0;
  /** 当前帧位移输出（编排器在相机变换之后叠加到 world+bgFixed） */
  offX = 0;
  offY = 0;
  /** 持续震屏 hold 归属（切片 52）：原版 EffectCtrler 全局单实例——后发
   *  startShake 覆盖前发的 hold，owner 供快照差分自动清理（doAction/doHurt/
   *  idle 统一 endShake 的渲染层近似）。 */
  private holdOwner: { kind: 'fighter' | 'assister'; id: number } | null = null;

  /** 抖动发起（原版 EffectCtrler.shake：pow 累加（已有则 +|pow|/2）、
   *  lose = ceil(pow / (time/1000×30)) 下限 1——30fps 内线性衰减到 0）。 */
  doShake(powX: number, powY: number, time: number): void {
    const s = this.st;
    if (powX !== 0) {
      if (s.powX === 0) {
        s.dxX = powX > 0 ? 1 : -1;
        s.powX = Math.abs(powX);
      } else {
        s.powX += Math.abs(powX) / 2;
      }
    }
    if (powY !== 0) {
      if (s.powY === 0) {
        s.dxY = powY > 0 ? 1 : -1;
        s.powY = Math.abs(powY);
      } else {
        s.powY += Math.abs(powY) / 2;
      }
    }
    if (time <= 0) time = 500;
    s.loseX = Math.max(1, Math.ceil(s.powX / ((time / 1000) * 30)));
    s.loseY = Math.max(1, Math.ceil(s.powY / ((time / 1000) * 30)));
  }

  /** 持续震屏（切片 52，原版 EffectCtrler.startShake：置 hold 保持项，
   *  advance 的 holdX/holdY 通道接入；单槽覆盖语义同原版全局 _shakeHoldX/Y）。 */
  startHold(x: number, y: number, owner: { kind: 'fighter' | 'assister'; id: number } | null): void {
    this.st.holdX = x;
    this.st.holdY = y;
    this.holdOwner = owner;
  }

  /** 持续震屏清除（原版 EffectCtrler.endShake：hold 清零 + gameStage 位移即时
   *  回零，pow 衰减项不受影响；advance 内 holdX/holdY 已参与 offset 合成）。 */
  endHold(): void {
    this.st.holdX = 0;
    this.st.holdY = 0;
    this.offX = 0;
    this.offY = 0;
    this.holdOwner = null;
  }

  /** 持续震屏自动清理（切片 52）：原版 FighterMcCtrler doAction/idle/doHurt
   *  统一 endShake——渲染层近似 = owner actionState 变化 / 死亡 / 快照缺席
   * （残影同款范式，先清后消费事件）；辅助 owner 无 actionState，仅
   *  退场（快照缺席）清。 */
  prescan(snap: SimSnapshot, prev: SimSnapshot): void {
    if (this.holdOwner === null) return;
    const o = this.holdOwner;
    let clear = false;
    if (o.kind === 'fighter') {
      const f = snap.state.fighters.find((x) => x.id === o.id);
      const p = prev.state.fighters.find((x) => x.id === o.id);
      clear =
        f === undefined || f.hp <= 0 || (p !== undefined && p.actionState !== f.actionState);
    } else {
      clear = !snap.state.assisters.some((x) => x.id === o.id);
    }
    if (clear) this.endHold();
  }

  /**
   * 抖动步进（镜像 EffectCtrler.renderShakeX/Y：30fps 帧；每帧 offset = (hold+pow)
   * ×direct、direct 逐帧翻转；pow 每 2 帧衰减 lose，衰减尽复位 offset 0。
   * X 轴先 frameX++ 后翻转，Y 轴先翻转后 frameY++（原版两函数的语序差）。
   */
  advance(dtMs: number): void {
    this.accMs += dtMs;
    while (this.accMs >= 1000 / 30) {
      this.accMs -= 1000 / 30;
      const s = this.st;
      const shakeX = s.holdX + s.powX;
      if (shakeX > 0) {
        this.offX = shakeX * s.dxX;
        let ended = false;
        if (s.powX > 0 && s.frameX % 2 === 0) {
          s.powX -= s.loseX;
          if (s.powX < s.loseX) {
            s.powX = 0;
            this.offX = 0;
            s.frameX = 0;
            s.loseX = 0;
            ended = true;
          }
        }
        if (!ended) {
          s.frameX++;
          s.dxX *= -1;
        }
      } else {
        this.offX = 0;
      }
      const shakeY = s.holdY + s.powY;
      if (shakeY > 0) {
        this.offY = shakeY * s.dxY;
        let ended = false;
        if (s.powY > 0 && s.frameY % 2 === 0) {
          s.powY -= s.loseY;
          if (s.powY < s.loseY) {
            s.powY = 0;
            this.offY = 0;
            s.frameY = 0;
            s.loseY = 0;
            ended = true;
          }
        }
        if (!ended) {
          s.dxY *= -1;
          s.frameY++;
        }
      } else {
        this.offY = 0;
      }
    }
  }

  dispose(): void {
    this.holdOwner = null;
    this.st.holdX = 0;
    this.st.holdY = 0;
  }
}
