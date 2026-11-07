/**
 * dsh-voice-spacehold · 宿主半侧
 *
 * 这个插件的能力全在浏览器半侧（lib/client.js）：长按空格触发原有的听写按钮，
 * 并负责三态动效。宿主这一侧不需要任何服务，只需要存在一个合法的 Cordis 插件行，
 * 让客户端模块系统能扫到本包的 dsh.client 声明。
 */
export const name = 'dsh-voice-spacehold'

export function apply() {
  /* 无需宿主能力 */
}
