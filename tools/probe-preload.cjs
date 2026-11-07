/* 探针专用 preload：
 * 1) 在页面脚本之前就标记「启动屏已看过」，避免每跑一次探针就响一遍开屏音效、闪一遍启动动画；
 * 2) 顺手把待机屏（dsh-fairy-zzz）的开关也设上，截图里就不会盖着一层时钟。
 *
 * 只在探针窗口里生效，不影响用户自己的窗口。
 */
try {
  sessionStorage.setItem('dsh-startup-screen:shown', '1')
  localStorage.setItem('dsh-startup-screen:day', new Date().toISOString().slice(0, 10))
  localStorage.setItem('dsh-fairy-zzz:skip', '1')
} catch (error) {
  // 忽略：拿不到存储时后面的断言逻辑不受影响
}
