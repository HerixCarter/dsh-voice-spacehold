/* dsh-voice-spacehold · 生成 README 用的示意图（纯合成页面，不含任何真实数据）
 *
 * 用法：
 *   env -u ELECTRON_RUN_AS_NODE \
 *   ~/.dsh/electron/Electron.app/Contents/MacOS/Electron tools/preview.cjs
 *
 * 产出：docs/preview-idle.png（空草稿提示）、docs/preview-listening.png（听写中）
 *
 * 页面是手写的假 composer（DOM 契约与真实一致：data-composer-card / data-composer-input，
 * 再加一颗 aria-label="开始录音" 的假触发按钮），然后灌入真实的 lib/client.js，
 * 所以图里是插件真实渲染的结果，但没有任何用户内容。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs')

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; }
  body {
    background:
      radial-gradient(1200px 620px at 50% -12%, #1b2334 0%, rgba(11, 13, 18, 0) 66%),
      #0b0d12;
    font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    color: #e7e9ee;
    display: flex; align-items: center; justify-content: center;
  }
  .stage { width: 700px; }
  .title { display: flex; align-items: center; gap: 9px; margin: 0 0 16px 4px; opacity: .5; font-size: 12.5px; letter-spacing: .02em; }
  .title i { width: 7px; height: 7px; border-radius: 50%; background: #4d8dff; box-shadow: 0 0 10px #4d8dff; }
  [data-composer-card] {
    position: relative; box-sizing: border-box; width: 100%; min-height: 128px;
    padding: 17px 20px 15px; border-radius: 26px;
    background: rgba(44, 45, 49, .94);
    box-shadow: 0 18px 44px rgba(0, 0, 0, .5);
    display: flex; flex-direction: column; justify-content: space-between;
  }
  [data-composer-input] { outline: none; font-size: 15px; line-height: 1.5; color: #e7e9ee; min-height: 22px; }
  [data-composer-input].empty::before { content: attr(data-placeholder); color: rgba(255, 255, 255, .32); }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 16px; color: rgba(255,255,255,.72); font-size: 12.5px; }
  .icon { width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,.08);
          display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .pill { padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,.06); }
  .spacer { flex: 1; }
  .send { width: 32px; height: 32px; border-radius: 50%; background: #4d8dff; color: #fff;
          display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .rec { display: none; align-items: center; gap: 12px; flex: 1; }
  .rec .line { flex: 1; height: 1px; background: repeating-linear-gradient(90deg, rgba(255,255,255,.3) 0 2px, transparent 2px 7px); }
  .rec .stop { width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,.1);
               display: flex; align-items: center; justify-content: center; }
  .rec .stop i { width: 9px; height: 9px; border-radius: 2px; background: #fff; }
  .row[data-voice-activity] .idle-tools { display: none; }
  .row[data-voice-activity] .rec { display: flex; }
</style></head>
<body>
  <div class="stage">
    <div class="title"><i></i>对话输入框 · 长按空格听写</div>
    <div data-composer-card>
      <div data-composer-input data-lexical-editor="true" contenteditable="true" class="empty"
           data-placeholder="发消息或创建任务。 / 调用指令，@ 文件或对话"></div>

      <div class="row" id="row">
        <div class="idle-tools" style="display:flex;align-items:center;gap:10px;width:100%">
          <span class="icon">+</span><span class="pill">工作区内修改</span><span class="pill">+ 技能</span>
          <span class="spacer"></span><span class="icon">🎙</span><span class="send">↑</span>
        </div>
        <div class="rec">
          <span class="icon">✕</span><span class="line"></span><span class="stop"><i></i></span><span class="send">↑</span>
        </div>
      </div>

      <!-- 假的原生语音触发按钮：让插件走真实的「点按钮开始录音」路径 -->
      <button id="voice-trigger" aria-label="开始录音"
              style="position:absolute;left:-9999px;top:0;width:20px;height:20px"></button>
    </div>
  </div>
  <script>
    const row = document.getElementById('row')
    document.getElementById('voice-trigger').addEventListener('click', () => row.setAttribute('data-voice-activity', 'recording'))
    row.addEventListener('click', () => row.removeAttribute('data-voice-activity'))
  </script>
</body></html>`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 620,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: false, backgroundThrottling: false }
  })
  win.webContents.setFrameRate(30)
  win.webContents.setZoomFactor(2)

  let last = null
  win.webContents.on('paint', (_event, _dirty, image) => { last = image })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(600)

  const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  await win.webContents.executeJavaScript(
    `window.__ModuleLoader__ = { load: (entry) => { entry.factory(() => ({})).apply({ logger: console }) } };
     ;(function () { ${src} })();`,
    true
  )
  await sleep(700)

  fs.mkdirSync(OUT, { recursive: true })
  const save = async (name) => {
    for (let i = 0; i < 40 && !last; i++) await sleep(50)
    if (!last) throw new Error('没有抓到画面')
    fs.writeFileSync(path.join(OUT, name), last.toPNG())
    console.log('wrote', path.join('docs', name))
  }

  await save('preview-idle.png')

  const editor = `document.querySelector('[data-composer-input]')`
  await win.webContents.executeJavaScript(
    `(() => { const el = ${editor}; el.focus();
       el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })); })()`,
    true
  )
  await sleep(900)
  await save('preview-listening.png')

  await win.webContents.executeJavaScript(
    `(() => { ${editor}.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })); })()`,
    true
  )
  await sleep(300)
  app.quit()
}).catch((error) => { console.error('preview failed:', error); app.exit(1) })
