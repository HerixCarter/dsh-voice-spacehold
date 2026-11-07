/* dsh-voice-spacehold · 真机探针（Electron）
 *
 * 在真实的 DSH 页面（真实 Lexical 编辑器 + 真实语音输入插件）上逐条验证长按听写，
 * 而不是在假 DOM 上自说自话。
 *
 * 用法：
 *   DSH_COOKIE="dsh-auth-...=v1...." \
 *   DSH_URL="http://127.0.0.1:<port>" \
 *   env -u ELECTRON_RUN_AS_NODE \
 *   ~/.dsh/electron/Electron.app/Contents/MacOS/Electron tools/probe.cjs
 *
 * cookie 从浏览器 DevTools → Application → Cookies 里复制 `dsh-auth-*` 那一对，拼成 NAME=VALUE。
 * SHOW=1 可以看到窗口；DSH_SHOTS 改截图目录（默认 /tmp/dsvsh-shots）。
 * 退出码 0 = 全部通过。
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const BASE = process.env.DSH_URL || 'http://127.0.0.1:53804'
const COOKIE = process.env.DSH_COOKIE || ''
const SHOTS = process.env.DSH_SHOTS || '/tmp/dsvsh-shots'
const SHOW = process.env.SHOW === '1'

if (!COOKIE) {
  console.error('缺少 DSH_COOKIE。从浏览器 DevTools → Application → Cookies 复制 dsh-auth-* 那一对，')
  console.error('拼成 NAME=VALUE 传进来，例如：')
  console.error('  DSH_COOKIE="dsh-auth-xxxx=yyyy" env -u ELECTRON_RUN_AS_NODE \\')
  console.error('    ~/.dsh/electron/Electron.app/Contents/MacOS/Electron tools/probe.cjs')
  app.exit(2)
}

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.disableHardwareAcceleration()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PRELUDE = `
const __t = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  editor: () => document.querySelector('[data-composer-input]'),
  overlay: () => {
    const root = document.querySelector('.dsvsh-root')
    return root ? { phase: root.getAttribute('data-phase'), visible: root.getAttribute('data-visible') } : null
  },
  frame: () => {
    const el = document.querySelector('.dsvsh-frame')
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      pad: parseFloat(cs.paddingTop),
      bg: cs.backgroundImage,
      radius: cs.borderTopLeftRadius,
      opacity: parseFloat(cs.opacity)
    }
  },
  halo: () => {
    const el = document.querySelector('.dsvsh-halo')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { shadow: cs.boxShadow, animation: cs.animationName, opacity: parseFloat(cs.opacity) }
  },
  bars: () => document.querySelectorAll('.dsvsh-bar').length,
  label: () => {
    const el = document.querySelector('.dsvsh-label')
    if (!el) return null
    return { text: el.textContent, size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }
  },
  hint: () => {
    const root = document.querySelector('.dsvsh-root')
    const el = document.querySelector('.dsvsh-hint')
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      text: (el.textContent || '').trim(),
      display: cs.display,
      size: cs.fontSize,
      color: cs.color,
      dataHint: root ? root.getAttribute('data-hint') : null,
      rootOpacity: root ? getComputedStyle(root).opacity : null
    }
  },
  rgb: (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } },
  activity: () => { const row = document.querySelector('[data-voice-activity]'); return row ? row.getAttribute('data-voice-activity') : null },
  fire: (el, type, key, extra) => {
    const options = Object.assign({ key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, composed: true }, extra || {})
    const event = new KeyboardEvent(type, options)
    el.dispatchEvent(event)
    return event.defaultPrevented
  },
  text: () => { const el = __t.editor(); return el ? el.textContent : '' }
}
`

async function main() {
  await app.whenReady()
  fs.mkdirSync(SHOTS, { recursive: true })

  const ses = session.defaultSession
  if (COOKIE) {
    const at = COOKIE.indexOf('=')
    await ses.cookies.set({
      url: `${BASE}/`, name: COOKIE.slice(0, at), value: COOKIE.slice(at + 1),
      httpOnly: false, secure: false, sameSite: 'strict', expirationDate: Date.now() / 1000 + 3600
    })
  }
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(true))
  ses.setPermissionCheckHandler(() => true)

  const win = new BrowserWindow({
    width: 1180, height: 860, show: SHOW, x: 40, y: 40,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'probe-preload.cjs')
    }
  })

  // 探针窗口不出声：启动屏音效、待机屏背景音都不该打扰用户
  win.webContents.setAudioMuted(true)

  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
  }
  // dsh-fairy-zzz 的待机屏会把整页盖住，截图前先收起来
  const maskOff = () => js(`
    for (const sel of ['.fz3-screen', '.fz3-layer']) {
      for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
    }
    return true
  `)
  const shot = async (name) => {
    await maskOff()
    const file = `${SHOTS}/${name}.png`
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG())
    console.log(`  shot ${file}`)
  }
  const js = (body) => win.webContents.executeJavaScript(`(async () => { ${PRELUDE}\n${body}\n})()`, true)
  const waitFor = async (body, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const ok = await js(`return !!(${body})`).catch(() => false)
      if (ok) return true
      await sleep(200)
    }
    return false
  }

  await win.loadURL(`${BASE}/`)

  const ready = await waitFor(`document.querySelector('[data-composer-input]') && document.getElementById('dsh-voice-spacehold-style')`, 40000)
  check('页面就绪且插件已装载（style 注入）', ready)
  if (!ready) { await shot('00-not-ready'); app.exit(1); return }

  // 关掉可能挡在前面的首启弹窗
  await js(`
    for (const b of document.querySelectorAll('button')) {
      const s = (b.textContent || '').trim()
      if (s === '继续' || s === '我知道了' || s === 'Continue') { b.click(); break }
    }
    await __t.sleep(300)
    const el = __t.editor()
    if (el) el.focus()
    return true
  `)
  await sleep(400)
  await maskOff()
  const uncovered = await js(`
    const el = __t.editor()
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 20)
    return { hit: hit ? hit.tagName : null, insideComposer: !!(hit && (hit === el || el.contains(hit))) }
  `)
  check('输入框没有被待机屏/弹层盖住', uncovered.insideComposer, uncovered)
  const draftBeforeProbe = await js(`return __t.text()`)

  await shot('01-idle')

  // ---------- 1. 长按 → arming → listening ----------
  const holding = await js(`
    const el = __t.editor()
    const before = __t.text()
    const prevented = __t.fire(el, 'keydown', ' ')
    await __t.sleep(230)
    return { before, prevented, arming: { overlay: __t.overlay(), frame: __t.frame() } }
  `)
  await shot('02a-arming')

  const listening = await js(`
    await __t.sleep(260)
    return { overlay: __t.overlay(), frame: __t.frame(), halo: __t.halo(), bars: __t.bars(), label: __t.label(), activity: __t.activity(), text: __t.text() }
  `)
  await shot('02-listening')

  const armBg = (holding.arming.frame && holding.arming.frame.bg) || ''
  const listenBg = (listening.frame && listening.frame.bg) || ''
  const isCool = (bg) => /conic-gradient/.test(bg) && /rgb\(\s*(?:\d+),\s*(?:\d+),\s*(?:2[0-9]{2})\s*\)/.test(bg)

  check('长按期间空格被拦截', holding.prevented === true)
  check('250ms 处于 arming', holding.arming.overlay && holding.arming.overlay.phase === 'arming' && holding.arming.overlay.visible === 'true', holding.arming.overlay)
  check('arming 描边 1px', holding.arming.frame && holding.arming.frame.pad === 1, holding.arming.frame && holding.arming.frame.pad)
  check('arming 是冷色渐变而非红色', isCool(armBg), armBg.slice(0, 90))
  check('500ms 之后处于 listening', listening.overlay && listening.overlay.phase === 'listening', listening.overlay)
  check('listening 描边 2px', listening.frame && listening.frame.pad === 2, listening.frame && listening.frame.pad)
  check('listening 用的是硬编码品牌蓝渐变（不是继承白）', /rgb\(\s*77,\s*141,\s*255\s*\)/.test(listenBg), listenBg.slice(0, 120))
  check('不再有假装音量的竖条', listening.bars === 0, listening.bars)
  check('光晕层在呼吸（三层冷光）', listening.halo && listening.halo.shadow !== 'none' && listening.halo.animation === 'dsvsh-halo', listening.halo)
  check('右上角「正在听写…」', listening.label && listening.label.text === '正在听写…', listening.label)
  check('原语音插件进入 recording', listening.activity === 'recording', listening.activity)
  check('按住期间草稿没有多出空格', listening.text === holding.before, { before: holding.before.length, after: listening.text.length })

  // ---------- 2. 松手 → stop ----------
  const release = await js(`
    __t.fire(__t.editor(), 'keyup', ' ')
    await __t.sleep(30)
    const fast = __t.overlay()
    await __t.sleep(200)
    return { fast, settled: __t.overlay(), activity: __t.activity() }
  `)
  check('松手后 150ms 内动效收起', release.fast && release.fast.visible === 'false', release.fast)
  check('松手后不再是 recording', release.activity !== 'recording', release.activity)
  await shot('03-after-release')

  const settled = await js(`
    for (let i = 0; i < 120; i++) {
      const a = __t.activity()
      if (a === null || a === 'feedback') break
      await __t.sleep(100)
    }
    await __t.sleep(400)
    return { activity: __t.activity(), text: __t.text(), overlay: __t.overlay() }
  `)
  check('识别结束无残留录音', settled.activity === null || settled.activity === 'feedback', settled.activity)
  check('识别结束动效不可见', settled.overlay && settled.overlay.visible === 'false', settled.overlay)
  console.log(`  info 识别后草稿：${JSON.stringify(settled.text.slice(-30))}`)

  // ---------- 3. 短按 → 正常空格 ----------
  const short = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(80)
    const before = __t.text()
    __t.fire(el, 'keydown', ' ')
    await __t.sleep(120)
    const mid = __t.overlay()
    __t.fire(el, 'keyup', ' ')
    await __t.sleep(300)
    return { before, after: __t.text(), mid }
  `)
  check('短按不进入 listening', short.mid && short.mid.phase === 'arming', short.mid)
  check('短按补回一个空格', short.after === short.before + ' ', { before: JSON.stringify(short.before.slice(-12)), after: JSON.stringify(short.after.slice(-12)) })
  const hintNow = await js(`return Object.assign({}, __t.hint(), { text: __t.text() })`)
  const draftEmpty = String(hintNow.text || '').trim() === ''
  check(
    '提示显隐与草稿是否为空一致',
    hintNow && (hintNow.dataHint === 'true') === draftEmpty && hintNow.display === (draftEmpty ? 'flex' : 'none'),
    { dataHint: hintNow && hintNow.dataHint, display: hintNow && hintNow.display, draftEmpty }
  )

  // ---------- 4. 输入法组合中的空格 ----------
  const ime = await js(`
    const el = __t.editor()
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const prevented = __t.fire(el, 'keydown', ' ', { isComposing: true, keyCode: 229 })
    await __t.sleep(700)
    const overlay = __t.overlay()
    const activity = __t.activity()
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    __t.fire(el, 'keyup', ' ')
    await __t.sleep(250)
    return { prevented, overlay, activity }
  `)
  check('组合中的空格不 preventDefault', ime.prevented === false)
  check('组合中的空格不触发动效', ime.overlay && ime.overlay.visible === 'false', ime.overlay)
  check('组合中的空格不启动听写', ime.activity !== 'recording', ime.activity)

  // ---------- 5. 非对话输入框 ----------
  const other = await js(`
    const input = document.createElement('input')
    input.id = 'dsvsh-probe-input'
    document.body.appendChild(input)
    input.focus()
    __t.fire(input, 'keydown', ' ')
    await __t.sleep(700)
    const overlay = __t.overlay()
    const activity = __t.activity()
    __t.fire(input, 'keyup', ' ')
    input.remove()
    __t.editor().focus()
    await __t.sleep(150)
    return { overlay, activity }
  `)
  check('其他输入框长按无动效', other.overlay && other.overlay.visible === 'false', other.overlay)
  check('其他输入框长按不启动听写', other.activity !== 'recording', other.activity)

  // ---------- 6. Esc 丢弃 ----------
  const esc = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(80)
    const before = __t.text()
    __t.fire(el, 'keydown', ' ')
    await __t.sleep(760)
    const during = { overlay: __t.overlay(), activity: __t.activity() }
    const prevented = __t.fire(el, 'keydown', 'Escape')
    await __t.sleep(120)
    const after = { overlay: __t.overlay(), activity: __t.activity() }
    __t.fire(el, 'keyup', ' ')
    await __t.sleep(1500)
    return { before, during, prevented, after, finalText: __t.text(), finalActivity: __t.activity() }
  `)
  check('Esc 前确实在听写', esc.during.activity === 'recording', esc.during.activity)
  check('Esc 被拦截', esc.prevented === true)
  check('Esc 后动效立即收起', esc.after.overlay && esc.after.overlay.visible === 'false', esc.after.overlay)
  check('Esc 后草稿与听写前一致', esc.finalText === esc.before, { before: esc.before.length, after: esc.finalText.length })
  check('Esc 后无残留录音', esc.finalActivity === null || esc.finalActivity === 'feedback', esc.finalActivity)
  await shot('04-after-escape')

  // ---------- 7. 听写中窗口失焦 → 立即停止 ----------
  const blur = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(80)
    __t.fire(el, 'keydown', ' ')
    await __t.sleep(700)
    const during = { overlay: __t.overlay(), activity: __t.activity() }
    window.dispatchEvent(new Event('blur'))
    await __t.sleep(80)
    const after = { overlay: __t.overlay(), activity: __t.activity() }
    __t.fire(el, 'keyup', ' ')
    await __t.sleep(600)
    return { during, after, finalActivity: __t.activity() }
  `)
  check('失焦前在听写', blur.during.activity === 'recording', blur.during.activity)
  check('失焦后动效立刻收起', blur.after.overlay && blur.after.overlay.visible === 'false', blur.after.overlay)
  check('失焦后停止录音', blur.finalActivity !== 'recording', blur.finalActivity)

  // ---------- 8. 语音未就绪 → 警示态，2s 自动收起 ----------
  const warn = await js(`
    const el = __t.editor()
    const trigger = window.__dshVoiceSpacehold.findTrigger()
    const saved = trigger && trigger.getAttribute('aria-haspopup')
    if (trigger) trigger.setAttribute('aria-haspopup', 'dialog')
    el.focus()
    await __t.sleep(60)
    __t.fire(el, 'keydown', ' ')
    await __t.sleep(900)
    const during = { overlay: __t.overlay(), frame: __t.frame(), label: __t.label(), activity: __t.activity() }
    __t.fire(el, 'keyup', ' ')
    if (trigger) {
      if (saved === null) trigger.removeAttribute('aria-haspopup')
      else trigger.setAttribute('aria-haspopup', saved)
    }
    await __t.sleep(100)
    return { during, color: __t.rgb(during.frame && during.frame.color) }
  `)
  check('未就绪时进入警示态', warn.during.overlay && warn.during.overlay.phase === 'warning', warn.during.overlay)
  check('警示态文案是麦克风不可用类提示', warn.during.label && warn.during.label.text.length > 0 && warn.during.label.text !== '正在听写…', warn.during.label)
  check('警示态没有真的开录音', warn.during.activity !== 'recording', warn.during.activity)
  const warnHidden = await js(`await __t.sleep(2400); return __t.overlay()`)
  check('警示态 2s 后自动收起', warnHidden && warnHidden.visible === 'false', warnHidden)
  const stillTyping = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(60)
    __t.fire(el, 'keydown', 'a')
    __t.fire(el, 'keyup', 'a')
    await __t.sleep(200)
    return { overlay: __t.overlay(), activity: __t.activity() }
  `)
  check('警示后无动效残留', stillTyping.overlay && stillTyping.overlay.visible === 'false', stillTyping)

  // ---------- 9. 连按不叠加 ----------
  const rapid = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(60)
    const before = __t.text()
    for (let i = 0; i < 3; i++) {
      __t.fire(el, 'keydown', ' ')
      await __t.sleep(60)
      __t.fire(el, 'keyup', ' ')
      await __t.sleep(40)
    }
    await __t.sleep(400)
    return { before, after: __t.text(), overlay: __t.overlay(), activity: __t.activity() }
  `)
  check(
    '连按三次得到三个空格',
    rapid.after.length === rapid.before.length + 3 &&
      rapid.after.replace(/\s+/g, '') === rapid.before.replace(/\s+/g, ''),
    { before: rapid.before.length, after: rapid.after.length }
  )
  check('连按后无动效、无录音', rapid.overlay && rapid.overlay.visible === 'false' && rapid.activity !== 'recording', { overlay: rapid.overlay, activity: rapid.activity })

  // ---------- 10. 还原草稿（测试会往输入框里打空格） ----------
  await win.webContents.executeJavaScript(`window.__probeDraft = ${JSON.stringify(draftBeforeProbe)}; true`)
  const restored = await js(`
    const el = __t.editor()
    el.focus()
    await __t.sleep(120)
    const target = window.__probeDraft
    if (el.textContent !== target) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      await __t.sleep(120)
      document.execCommand('insertText', false, target)
      await __t.sleep(400)
    }
    return { ok: el.textContent === target, now: el.textContent.slice(0, 20) }
  `)
  check('测试结束后草稿恢复原样', restored.ok, restored)

  // ---------- 11. 提示文字（独立最小页面，避免碰真实草稿） ----------
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<html><body style="margin:0;background:#1b1b1f">' +
          '<div data-composer-card style="position:relative;margin:40px;width:640px;height:96px;background:#101014;border-radius:20px">' +
          '<div data-composer-input data-lexical-editor="true" contenteditable="true" style="display:block;width:100%;height:100%;outline:none"></div>' +
          '</div></body></html>'
      )
  )
  await sleep(400)
  const hintPage = await win.webContents.executeJavaScript(`
    window.__ModuleLoader__ = { load: (entry) => { window.__p = entry.factory(() => ({})); window.__p.apply({ logger: console }) } }
    ;(function () { ${clientSrc} })()
    new Promise((resolve) => setTimeout(() => {
      const root = document.querySelector('.dsvsh-root')
      const hint = document.querySelector('.dsvsh-hint')
      const cs = hint ? getComputedStyle(hint) : null
      resolve({
        rootOpacity: root ? getComputedStyle(root).opacity : null,
        dataHint: root ? root.getAttribute('data-hint') : null,
        text: hint ? hint.textContent.trim() : null,
        display: cs ? cs.display : null,
        size: cs ? cs.fontSize : null,
        svg: hint ? hint.querySelectorAll('svg').length : 0,
        placed: root ? Math.round(parseFloat(root.style.left || '0')) : null
      })
    }, 500))
  `, true)
  check('空草稿页面显示提示', hintPage.dataHint === 'true' && hintPage.display === 'flex' && hintPage.text === '长按空格 语音输入', hintPage)
  check('提示带小话筒图标且浮层已定位', hintPage.svg === 1 && hintPage.placed > 0, { svg: hintPage.svg, left: hintPage.placed })
  await shot('05-hint')

  const hintGone = await win.webContents.executeJavaScript(`
    (async () => {
      const el = document.querySelector('[data-composer-input]')
      el.textContent = '你好'
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '你好' }))
      await new Promise((r) => setTimeout(r, 200))
      const root = document.querySelector('.dsvsh-root')
      const hint = document.querySelector('.dsvsh-hint')
      return { dataHint: root.getAttribute('data-hint'), display: getComputedStyle(hint).display }
    })()
  `, true)
  check('有内容后提示收起', hintGone.dataHint === 'false' && hintGone.display === 'none', hintGone)

  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed.map((f) => f.name) }, null, 2))
  app.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => { console.error('probe crashed:', error); app.exit(2) })
