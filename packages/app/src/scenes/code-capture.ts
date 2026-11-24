/**
 * 房码隐藏采集输入：视觉隐藏的 `<input inputmode=numeric>` 覆在画布上采集键入
 * （移动端数字键盘 / 粘贴），显示层由调用方负责（本组件不绘制任何东西）。
 * 位数上限静默截断（超出忽略）；mount 期间失焦自动拉回（点击画布不断流）。
 */
const CODE_MAX = 6;

export class CodeCapture {
  private el: HTMLInputElement | null = null;
  private d = '';

  constructor(
    private readonly host: HTMLElement,
    /** 键入变化（含编程式设码）；显示层据此同步 */
    private readonly onChange: (digits: string) => void,
    private readonly onConfirm: () => void,
    private readonly onEscape: () => void,
  ) {}

  get digits(): string {
    return this.d;
  }

  /** 编程式设码（深链 / dev 预填 / 路由键补位）；同步回写 input.value。 */
  set digits(v: string) {
    this.d = v.replace(/\D/g, '').slice(0, CODE_MAX);
    if (this.el) this.el.value = this.d;
    this.onChange(this.d);
  }

  mount(): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = CODE_MAX;
    // 视觉隐藏但仍可聚焦（移动端唤起数字键盘；opacity:0 而非 display:none），
    // 字号 16px 防 iOS 聚焦缩放
    input.style.cssText =
      'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);width:2px;height:2px;' +
      'opacity:0;font-size:16px;border:0;padding:0;margin:0;background:transparent;' +
      'color:transparent;caret-color:transparent;outline:none;z-index:18;';
    input.addEventListener('input', () => {
      const v = input.value.replace(/\D/g, '').slice(0, CODE_MAX);
      if (v !== input.value) input.value = v;
      this.d = v;
      this.onChange(v);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 不泄漏进菜单键盘采集
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.onEscape();
      }
    });
    input.addEventListener('blur', () => {
      // 点击画布等导致的失焦拉回；已撤下的 input（this.el 先置空）不再拉
      if (this.el) window.setTimeout(() => this.el?.focus(), 0);
    });
    this.host.appendChild(input);
    this.el = input;
    input.focus();
  }

  focus(): void {
    this.el?.focus();
  }

  dispose(): void {
    const el = this.el;
    this.el = null;
    el?.remove();
  }
}
