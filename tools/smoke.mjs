/* dsh-voice-spacehold · 无浏览器冒烟测试
 *
 * 用一个极简假 DOM 把真实 lib/client.js 跑起来，验证手势状态机与浮层生命周期。
 * 它替代不了 tools/probe.cjs（那个连真实 DSH 页面），但能在 CI 里跑、也不需要 cookie。
 *
 *   node tools/smoke.mjs
 *
 * 退出码 0 = 全过。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ---------------------------------------------------------------- 极简假 DOM */

function matchOne(el, selector) {
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(selector)
  let rest = selector
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toUpperCase()) return false
    rest = selector.slice(tagMatch[0].length)
  }
  const tokens = rest.match(/\[[^\]]*\]|\.[\w-]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('.')) {
      const cls = token.slice(1)
      if (!(el.getAttribute('class') || '').split(/\s+/).includes(cls)) return false
      continue
    }
    const inner = token.slice(1, -1)
    const parsed = /^([\w-]+)(?:(\*?=)"?([^"]*)"?)?$/.exec(inner)
    if (!parsed) return false
    const [, name, op, value] = parsed
    const actual = el.getAttribute(name)
    if (actual == null) return false
    if (op === '=' && actual !== value) return false
    if (op === '*=' && !actual.includes(value)) return false
  }
  return true
}

const matches = (el, selector) => selector.split(',').some((one) => matchOne(el, one.trim()))

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.attrs = new Map()
    this.children = []
    this.parentNode = null
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }
    this._text = ''
    this._html = ''
    this._clicks = 0
    this.disabled = false
  }

  get className() {
    return this.getAttribute('class') || ''
  }

  set className(value) {
    this.setAttribute('class', value)
  }

  get id() {
    return this.getAttribute('id') || ''
  }

  set id(value) {
    this.setAttribute('id', value)
  }

  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get innerHTML() {
    return this._html
  }

  set innerHTML(value) {
    this._html = String(value)
    // 真实环境会解析出子节点；这里只要接口不炸
    this.children = []
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value))
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }

  removeAttribute(name) {
    this.attrs.delete(name)
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }

  closest(selector) {
    let current = this
    while (current) {
      if (current instanceof FakeElement && matches(current, selector)) return current
      current = current.parentNode
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  addEventListener() {}
  removeEventListener() {}

  dispatchEvent() {
    return true
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }

  click() {
    this._clicks += 1
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 60, right: 800, bottom: 60 }
  }

  get isConnected() {
    return true
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map()
    this.execCommands = []
    this.hidden = false
    this.activeElement = null
    this.head = new FakeElement('head')
    this.body = new FakeElement('body')
    this.head.ownerDocument = this
    this.body.ownerDocument = this
  }

  elementFromPoint() {
    return globalThis.__topElement || null
  }

  createElement(tag) {
    const el = new FakeElement(tag)
    el.ownerDocument = this
    return el
  }

  createTextNode(text) {
    const el = new FakeElement('#text')
    el.textContent = text
    el.ownerDocument = this
    return el
  }

  getElementById(id) {
    return this.body.querySelector(`[id="${id}"]`) || this.head.querySelector(`[id="${id}"]`)
  }

  querySelector(selector) {
    return this.body.querySelector(selector) || this.head.querySelector(selector)
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector).concat(this.head.querySelectorAll(selector))
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  execCommand(command, ui, value) {
    this.execCommands.push({ command, value })
    return true
  }

  createRange() {
    return {
      selectNodeContents() {},
      setStart() {},
      setEnd() {},
      collapse() {},
      addRange() {},
      removeAllRanges() {}
    }
  }

  fire(type, target, patch = {}) {
    const event = {
      type,
      target,
      key: ' ',
      code: 'Space',
      keyCode: 32,
      isComposing: false,
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {}
    }
    Object.assign(event, patch)
    for (const handler of this.listeners.get(type) || []) handler(event)
    return event
  }
}

const document = new FakeDocument()
const windowListeners = new Map()
const window = {
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, [])
    windowListeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = windowListeners.get(type) || []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  },
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  innerWidth: 1440,
  innerHeight: 900
}

/* ---------------------------------------------------------------- 装载插件 */

let factory = null
window.__ModuleLoader__ = {
  load(entry) {
    if (entry.id !== 'dsh-voice-spacehold') throw new Error(`unexpected module id: ${entry.id}`)
    factory = entry.factory
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const sandbox = {
  window,
  document,
  navigator: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  getComputedStyle: () => ({ borderRadius: '16px' }),
  ResizeObserver: FakeResizeObserver,
  InputEvent: class {},
  Event: class {}
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox)

if (!factory) throw new Error('client.js 没有注册到 window.__ModuleLoader__')
const mod = factory(() => ({}))
const logger = { debug() {}, info() {}, warn() {}, error() {} }

/* ---------------------------------------------------------------- 搭场景 */

// 对话输入框：card > editor > p > span（结构照抄真实 Lexical composer）
const card = document.createElement('div')
card.setAttribute('data-composer-card', '')
const editor = document.createElement('div')
editor.setAttribute('data-composer-input', '')
editor.setAttribute('data-lexical-editor', 'true')
editor.setAttribute('contenteditable', 'true')
const paragraph = document.createElement('p')
paragraph.appendChild(document.createTextNode(''))
editor.appendChild(paragraph)
card.appendChild(editor)

// 原语音插件的触发按钮（idle 态才渲染）
const anchor = document.createElement('span')
anchor.setAttribute('class', 'pn0E2q_triggerAnchor')
const trigger = document.createElement('button')
trigger.setAttribute('aria-label', '开始录音')
anchor.appendChild(trigger)
card.appendChild(anchor)

document.body.appendChild(card)

// 一个和对话无关的输入框（设置页搜索框）
const otherInput = document.createElement('input')
document.body.appendChild(otherInput)

/* ---------------------------------------------------------------- 断言 */

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`)
  }
}

const phase = () => {
  const root = document.querySelector('.dsvsh-root')
  return root ? root.getAttribute('data-phase') : null
}
const hintShown = () => {
  const root = document.querySelector('.dsvsh-root')
  return root ? root.getAttribute('data-hint') : null
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 「最上层是谁」默认就是编辑器自己（= 没被盖住）
globalThis.__topElement = editor

const dispose = mod.apply({ logger })
check('apply 后注入了样式表', !!document.getElementById('dsh-voice-spacehold-style'))
check('apply 后挂上了浮层', !!document.querySelector('.dsvsh-root'))
check('初始 phase 是 idle', phase() === 'idle', phase())
check('空草稿时提示可见', hintShown() === 'true', hintShown())

// 1) 输入法组合中的空格：完全不响应
const ime = document.fire('keydown', editor, { isComposing: true })
check('IME 组合中不 preventDefault', ime.defaultPrevented === false)
check('IME 组合中不进 arming', phase() === 'idle', phase())
document.fire('keyup', editor, { isComposing: true })

// 2) 不在对话输入框里：不响应
const outside = document.fire('keydown', otherInput)
check('设置页输入框不 preventDefault', outside.defaultPrevented === false)
check('设置页输入框不进 arming', phase() === 'idle', phase())
document.fire('keyup', otherInput)

// 3) 短按：补一个空格，无动效
const execBefore = document.execCommands.length
document.fire('keydown', editor)
await sleep(120)
check('短按期间 phase 是 arming', phase() === 'arming', phase())
document.fire('keyup', editor)
await sleep(30)
check('短按后回到 idle', phase() === 'idle', phase())
check(
  '短按补了一个空格',
  document.execCommands.length === execBefore + 1 && document.execCommands.at(-1).value === ' ',
  document.execCommands.at(-1)
)

// 4) 长按：到点进 listening，并点开原插件的触发按钮
document.fire('keydown', editor)
await sleep(200)
check('按住 200ms 时是 arming', phase() === 'arming', phase())
await sleep(420)
check('按住 620ms 后是 listening', phase() === 'listening', phase())
check('长按点开了原听写按钮', trigger._clicks === 1, trigger._clicks)
document.fire('keyup', editor)
await sleep(30)
check('松手回到 idle', phase() === 'idle', phase())

// 5) 草稿有内容后提示收起
editor.querySelector('p').textContent = '你好'
document.fire('input', editor)
check('有内容后提示收起', hintShown() === 'false', hintShown())

// 6) 被开屏动画/全屏弹层盖住时：整层藏起来，提示也不显示
globalThis.__topElement = otherInput // 一个不在卡片里的元素 = 卡片被盖住
document.fire('input', editor)       // 触发一次刷新
window.__dshVoiceSpacehold.refreshIdle()
check('被盖住时浮层隐藏', (document.querySelector('.dsvsh-root') || {}).style.display === 'none',
  (document.querySelector('.dsvsh-root') || {}).style)
check('被盖住时不显示提示', hintShown() === 'false', hintShown())

globalThis.__topElement = editor // 开屏结束，卡片重新露出来
window.__dshVoiceSpacehold.refreshIdle()
check('露出来后浮层恢复', (document.querySelector('.dsvsh-root') || {}).style.display !== 'none',
  (document.querySelector('.dsvsh-root') || {}).style)

// 7) dispose 清理干净
dispose()
check('dispose 后浮层移除', !document.querySelector('.dsvsh-root'))
check('dispose 后样式表移除', !document.getElementById('dsh-voice-spacehold-style'))
check('dispose 后调试把手移除', !window.__dshVoiceSpacehold)

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
