/* dsh-voice-spacehold · 浏览器半侧
 *
 * 长按空格 0.5 秒开始听写：只作用于对话输入框（Lexical contenteditable），
 * 其他输入框一律不响应。听写本身复用已经装好的语音输入插件（点它的按钮），
 * 本插件只负责「长按手势 → 启停」和三态动效，不自己录音、不碰识别。
 *
 * 三个刻意的取舍：
 *   1) 空格在 keydown 第一次就 preventDefault，按住期间一个空格都不会落进草稿，
 *      所以到阈值时不需要回删任何字符，短按松手时再补一个空格即可。
 *   2) 补空格走 Lexical 编辑器实例（DOM 上的 __lexicalEditor，Lexical 自己挂的），
 *      在 editor.update() 里调 selection.insertText(' ')，是干净的单次事务；
 *      万一个版本没有该内部字段，退回 document.execCommand('insertText')。
 *   3) 输入法组合中的空格是选词键：用 keydown 的 isComposing/keyCode===229、
 *      元素上的 compositionstart/end 标记、以及 editor.isComposing() 三重判断，
 *      任一条命中就完全不响应，不动效、不 preventDefault。
 *
 * 听写器本身的状态机（recording/transcribing/feedback）、空结果、权限失败、
 * 失焦取消、Esc 取消都由原语音插件负责；这里只按它的 data-voice-activity
 * 属性判断阶段，并点它的按钮。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-spacehold',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /* ------------------------------------------------------------------ 常量 */

    const PLUGIN_ID = 'dsh-voice-spacehold'
    const STYLE_ID = 'dsh-voice-spacehold-style'
    const ROOT_CLASS = 'dsvsh-root'

    const HOLD_MS = 500 // 按住多久算「长按」
    const WARN_MS = 2000 // 警示态停留时间
    const FADE_MS = 150 // 收起淡出时长（与 CSS 保持一致）
    const ACTIVITY_DEADLINE_MS = 4000 // 点了按钮却迟迟不进 recording 的兜底

    const EDITOR_SELECTOR = '[data-composer-input], [data-lexical-editor="true"]'
    const CARD_SELECTOR = '[data-composer-card]'
    const ACTIVITY_SELECTOR = '[data-voice-activity]'
    const COMPOSING_ATTR = 'data-composer-composing'

    /** 原「听写」触发按钮的 aria-label（中英文，含未就绪时的引导态）。 */
    const TRIGGER_LABELS = [
      '开始录音',
      '听写',
      'Start recording',
      'Dictate',
      '打开语音输入引导',
      'Open voice input guide'
    ]

    /** 提示文字前面那个小话筒（12px，跟文字同色）。 */
    const MIC_ICON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>'

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
.${ROOT_CLASS} {
  position: fixed;
  pointer-events: none;
  z-index: 2147482000;
  opacity: 0;
  transition: opacity ${FADE_MS}ms ease;
  /* 固定成主题蓝/青：面板里的 --dsw-alias-brand-primary 可能根本没定义，
     var() 取到空值会让 color 失效、继承成正文白，边框就成了白圈 */
  --dsvsh-accent: #4d8dff;
  --dsvsh-warn: #f2b03d;
  --dsvsh-lo: 0.15;
  --dsvsh-hi: 0.3;
  --dsvsh-width: 1px;
  color: var(--dsvsh-accent);
}
.${ROOT_CLASS}[data-visible="true"],
.${ROOT_CLASS}[data-hint="true"] { opacity: 1; }
.${ROOT_CLASS}[data-phase="idle"] .dsvsh-frame,
.${ROOT_CLASS}[data-phase="idle"] .dsvsh-halo,
.${ROOT_CLASS}[data-phase="idle"] .dsvsh-label { display: none; }
.${ROOT_CLASS}[data-phase="listening"] { --dsvsh-lo: 0.35; --dsvsh-hi: 0.7; --dsvsh-width: 2px; }
.${ROOT_CLASS}[data-phase="warning"] { color: var(--dsvsh-warn); }

/* 描边：conic-gradient + 双 mask 只留出「边」这一圈，
   颜色沿环从青→蓝→紫再回青，是一圈冷光而不是一条死板纯色线 */
.${ROOT_CLASS} .dsvsh-frame {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: var(--dsvsh-width);
  background: conic-gradient(from 195deg,
    #8ff2ff 0%, #4d8dff 20%, #8a6dff 42%, #4d8dff 64%, #8ff2ff 86%, #8ff2ff 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: dsvsh-breathe 1.6s ease-in-out infinite;
  will-change: opacity;
}
.${ROOT_CLASS}[data-phase="warning"] .dsvsh-frame {
  background: conic-gradient(from 200deg, #ffd79a 0%, #f2b03d 45%, #f2b03d 75%, #ffd79a 100%);
  animation: none;
  opacity: 0.85;
}

/* 光晕：三层不同半径的冷光，只做 opacity 呼吸，不重绘几何 */
.${ROOT_CLASS} .dsvsh-halo {
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  opacity: var(--dsvsh-lo);
  animation: dsvsh-halo 2.4s ease-in-out infinite;
  will-change: opacity;
}
.${ROOT_CLASS}[data-phase="arming"] .dsvsh-halo {
  box-shadow: 0 0 16px 0 rgba(77, 141, 255, 0.18);
}
.${ROOT_CLASS}[data-phase="listening"] .dsvsh-halo {
  box-shadow:
    /* 内圈：让光渗进输入框内侧边缘 */
    inset 0 0 22px -10px rgba(110, 178, 255, 0.55),
    /* 外圈：贴边高光 + 中景扩散 + 远景雾 */
    0 0 10px -1px rgba(130, 205, 255, 0.55),
    0 0 30px 3px rgba(77, 141, 255, 0.26),
    0 0 70px 14px rgba(96, 116, 255, 0.14);
}
.${ROOT_CLASS}[data-phase="warning"] .dsvsh-halo {
  box-shadow: 0 0 18px 0 rgba(242, 176, 61, 0.22);
  animation: none;
  opacity: 0.8;
}

.${ROOT_CLASS} .dsvsh-label {
  position: absolute;
  top: 6px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  line-height: 14px;
  letter-spacing: 0.06em;
  white-space: nowrap;
  color: currentColor;
  opacity: 0.75;
}
.${ROOT_CLASS}[data-phase="arming"] .dsvsh-label { opacity: 0; }
.${ROOT_CLASS} .dsvsh-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: dsvsh-dot 1.6s ease-in-out infinite;
}

.${ROOT_CLASS} .dsvsh-hint {
  position: absolute;
  top: 9px;
  right: 14px;
  display: none;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.34);
  pointer-events: none;
  user-select: none;
}
.${ROOT_CLASS}[data-hint="true"] .dsvsh-hint { display: flex; }
.${ROOT_CLASS}[data-phase="arming"] .dsvsh-hint,
.${ROOT_CLASS}[data-phase="listening"] .dsvsh-hint,
.${ROOT_CLASS}[data-phase="warning"] .dsvsh-hint { display: none; }
.${ROOT_CLASS} .dsvsh-hint svg { width: 12px; height: 12px; opacity: 0.8; }

@keyframes dsvsh-breathe {
  0%, 100% { opacity: var(--dsvsh-lo); }
  50% { opacity: var(--dsvsh-hi); }
}
@keyframes dsvsh-halo {
  0%, 100% { opacity: var(--dsvsh-lo); }
  50% { opacity: var(--dsvsh-hi); }
}
@keyframes dsvsh-dot {
  0%, 100% { opacity: 0.4; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS} .dsvsh-frame { animation-duration: 3.2s; }
  .${ROOT_CLASS} .dsvsh-halo { animation-duration: 3.2s; }
  .${ROOT_CLASS} .dsvsh-dot { animation-duration: 3.2s; }
}
`

    /* ------------------------------------------------------------------ 工具 */

    function isSpaceEvent(event) {
      return event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space'
    }

    function getEditorFrom(el) {
      if (!el) return undefined
      const own = el.__lexicalEditor
      if (own) return own
      const root = el.closest && el.closest('[data-lexical-editor="true"]')
      return root ? root.__lexicalEditor : undefined
    }

    /* -------------------------------------------------------------- 主控制器 */

    function createController(logger) {
      const state = {
        phase: 'idle', // idle | arming | listening | warning
        epoch: 0,
        armTimer: 0,
        warnTimer: 0,
        watchTimer: 0,
        editorEl: null,
        cardEl: null,
        overlay: null,
        resizeObserver: null,
        observedCard: null,
        trackTimer: 0,
        lastBoxKey: '',
        occluded: false,
        idleTimer: 0,
        composing: false,
        composingEndedAt: 0,
        started: false
      }

      const warn = (message) => logger.warn(`[${PLUGIN_ID}] ${message}`)

      /* ---------- 样式与浮层 ---------- */

      function injectStyle() {
        if (document.getElementById(STYLE_ID)) return
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }

      function buildOverlay() {
        if (state.overlay) return state.overlay
        const root = document.createElement('div')
        root.className = ROOT_CLASS
        root.setAttribute('data-phase', 'idle')
        root.setAttribute('aria-hidden', 'true')

        const halo = document.createElement('div')
        halo.className = 'dsvsh-halo'

        const frame = document.createElement('div')
        frame.className = 'dsvsh-frame'

        const label = document.createElement('div')
        label.className = 'dsvsh-label'
        const dot = document.createElement('i')
        dot.className = 'dsvsh-dot'
        const labelText = document.createElement('span')
        label.appendChild(dot)
        label.appendChild(labelText)

        const hint = document.createElement('div')
        hint.className = 'dsvsh-hint'
        hint.innerHTML = `${MIC_ICON}<span>长按空格 语音输入</span>`

        root.appendChild(halo)
        root.appendChild(frame)
        root.appendChild(label)
        root.appendChild(hint)
        document.body.appendChild(root)
        state.overlay = root
        return root
      }

      function overlayLabel(text) {
        const root = buildOverlay()
        const label = root.querySelector('.dsvsh-label')
        if (!label) return
        const span = label.querySelector('span')
        if (span) span.textContent = text
        else label.textContent = text
      }

      function findCard() {
        const ok = (card) => (card && card.isConnected ? card : null)
        if (state.editorEl && state.editorEl.isConnected) {
          const card = ok(state.editorEl.closest(CARD_SELECTOR))
          if (card) return card
        }
        const editor = document.querySelector(EDITOR_SELECTOR)
        if (editor) {
          const card = ok(editor.closest(CARD_SELECTOR))
          if (card) return card
        }
        return ok(document.querySelector(CARD_SELECTOR))
      }

      /** 整层收起：卡片没了 / 被盖住 / 被隐藏时都走这里。 */
      function hideOverlay() {
        const overlay = state.overlay
        if (!overlay) return
        overlay.setAttribute('data-hint', 'false')
        if (overlay.style.display !== 'none') overlay.style.display = 'none'
        state.occluded = true
      }

      /** 把浮层贴到输入框卡片的内框上（多行展开、附件行都会改高度）。 */
      /**
       * 卡片被盖住了吗？
       * 浮层挂在 body 上、z-index 极高，所以开屏动画、全屏弹层这类东西盖不住它，
       * 只能反过来问：卡片自己现在还剩多少「可见」——用 elementFromPoint 打点。
       */
      function isCardOccluded(card) {
        // 隐藏的分支（切到别的页面、被折叠的面板）里卡片仍有布局，但用户看不见。
        // 注意别用 checkOpacity：外层容器的入场动画常常停在 0.999，会被判成「不可见」，
        // 结果卡片明明好好的、提示却整天躲着不出来。只认 display/visibility，透明度单独看卡片自己。
        if (typeof card.checkVisibility === 'function' &&
            !card.checkVisibility({ checkVisibilityCSS: true })) return true
        const ownOpacity = parseFloat(getComputedStyle(card).opacity || '1')
        if (ownOpacity < 0.05) return true
        const rect = card.getBoundingClientRect()
        if (rect.width < 8 || rect.height < 8) return true
        const vh = window.innerHeight || 0
        const vw = window.innerWidth || 0
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) return true
        const points = [
          [rect.left + rect.width / 2, rect.top + Math.min(14, rect.height / 2)],
          [rect.left + rect.width / 2, rect.top + rect.height / 2]
        ]
        let hitOpen = false
        for (const [x, y] of points) {
          if (x < 0 || y < 0 || x > vw || y > vh) continue
          hitOpen = true
          const hit = document.elementFromPoint(Math.round(x), Math.round(y))
          if (hit && card.contains(hit)) return false
        }
        return hitOpen
      }

      /** 被盖住就整层藏起来；露出来时再恢复判定。 */
      function applyOcclusion(card) {
        const overlay = state.overlay
        if (!overlay) return
        const occluded = isCardOccluded(card)
        if (occluded === state.occluded) return
        state.occluded = occluded
        if (occluded) {
          hideOverlay()
        } else {
          overlay.style.display = ''
          updateHint()
        }
      }

      function syncBox() {
        const overlay = state.overlay
        if (!overlay) return
        const card = findCard()
        if (!card) {
          hideOverlay()
          return
        }
        state.cardEl = card
        applyOcclusion(card)
        const rect = card.getBoundingClientRect()
        const key = `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`
        if (key === state.lastBoxKey) return // 位置没变就别碰样式，省掉每次重排
        state.lastBoxKey = key
        const radius = getComputedStyle(card).borderRadius || '12px'
        overlay.style.left = `${rect.left}px`
        overlay.style.top = `${rect.top}px`
        overlay.style.width = `${rect.width}px`
        overlay.style.height = `${rect.height}px`
        overlay.style.borderRadius = radius
      }

      /**
       * 只跟着卡片的大小走：ResizeObserver + 400ms 兜底轮询。
       * 之前是每帧 rAF 读 rect，录制时等于每帧强制同步布局，白占了主线程。
       */
      function startTracking() {
        state.lastBoxKey = ''
        const card = findCard()
        if (card && state.observedCard !== card) {
          if (state.resizeObserver) state.resizeObserver.disconnect()
          state.resizeObserver = new ResizeObserver(syncBox)
          state.resizeObserver.observe(card)
          state.observedCard = card
        }
        syncBox()
        if (!state.trackTimer) state.trackTimer = setInterval(syncBox, 400)
      }

      function stopTracking() {
        if (state.resizeObserver) {
          state.resizeObserver.disconnect()
          state.resizeObserver = null
        }
        state.observedCard = null
        if (state.trackTimer) clearInterval(state.trackTimer)
        state.trackTimer = 0
        state.lastBoxKey = ''
      }

      function renderPhase(phase, label) {
        const overlay = buildOverlay()
        overlay.setAttribute('data-phase', phase)
        overlay.setAttribute('data-visible', phase === 'idle' ? 'false' : 'true')
        if (label !== undefined) overlayLabel(label)
        if (phase === 'idle') {
          stopTracking()
        } else {
          startTracking()
        }
        updateHint()
      }

      /* ---------- 空草稿提示 ---------- */

      /** null = 编辑器还没挂上，此时不要动提示的显隐，免得闪一下。 */
      function composerIsEmpty() {
        const editor = state.editorEl || document.querySelector(EDITOR_SELECTOR)
        if (!editor) return null
        return (editor.textContent || '').trim() === ''
      }

      /** 空草稿时在输入框右上角留一句「长按空格 语音输入」，纯提示、不吃事件。 */
      /**
       * 占位符第一行文字的最右边缘。
       * 提示挂在卡片右上角、只占第一行的高度，所以只看第一行；
       * 拿整块 getBoundingClientRect 会把整行宽度当文字宽度，缩窄窗口时会误判成「放不下」。
       */
      function textRightEdge(card) {
        const placeholder = card.querySelector('[class*="placeholder"]')
        if (!placeholder || typeof document.createRange !== 'function') return 0
        try {
          const range = document.createRange()
          range.selectNodeContents(placeholder)
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 1)
          if (rects.length === 0) return 0
          rects.sort((a, b) => (a.top - b.top) || (a.left - b.left))
          return rects[0].right
        } catch (error) {
          return 0
        }
      }

      function updateHint() {
        if (typeof document === 'undefined' || !document.body) return
        const empty = composerIsEmpty()
        if (empty === null) return
        const overlay = buildOverlay()
        const show = state.phase === 'idle' && empty && !state.occluded
        overlay.setAttribute('data-hint', show ? 'true' : 'false')
        if (!show) return

        syncBox()
        // 输入框窄的时候，提示会压到占位符/正文的尾巴上 —— 先量，再决定露不露
        const hint = overlay.querySelector('.dsvsh-hint')
        const card = findCard()
        if (!hint || !card) return
        const textRight = textRightEdge(card)
        if (textRight <= 0) return

        // 放不下就干脆不显示：宁可没有，也不要在字上叠东西
        const hintRect = hint.getBoundingClientRect()
        if (hintRect.width > 0 && textRight + 12 > hintRect.left) {
          overlay.setAttribute('data-hint', 'false')
        }
      }

      /* ---------- 计时器 ---------- */

      function clearArmTimer() {
        if (state.armTimer) clearTimeout(state.armTimer)
        state.armTimer = 0
      }

      function clearWatchTimer() {
        if (state.watchTimer) clearTimeout(state.watchTimer)
        state.watchTimer = 0
      }

      function clearWarnTimer() {
        if (state.warnTimer) clearTimeout(state.warnTimer)
        state.warnTimer = 0
      }

      function clearAllTimers() {
        clearArmTimer()
        clearWatchTimer()
        clearWarnTimer()
      }

      /* ---------- 输入法 ---------- */

      function isComposing(event, editorEl) {
        if (event && (event.isComposing === true || event.keyCode === 229)) return true
        if (state.composing) return true
        // Safari 会在 keydown 之前先发 compositionend，留一小段余量
        if (state.composingEndedAt && Date.now() - state.composingEndedAt < 80) return true
        const editor = getEditorFrom(editorEl)
        if (editor && typeof editor.isComposing === 'function') {
          try {
            if (editor.isComposing()) return true
          } catch (error) {
            /* 编辑器内部状态异常时按「没在组合」处理 */
          }
        }
        const target = event && event.target
        if (target && target.closest && target.closest(`[${COMPOSING_ATTR}]`)) return true
        return false
      }

      function onCompositionStart() {
        state.composing = true
        state.composingEndedAt = 0
      }

      function onCompositionEnd() {
        state.composing = false
        state.composingEndedAt = Date.now()
      }

      /* ---------- 空格的补偿插入 ---------- */

      /**
       * 短按松手时补回那个被 preventDefault 吞掉的空格。
       * 优先用 Lexical 编辑器实例（单次事务、光标自然前移），失败再退回 execCommand。
       * @returns {boolean} 是否已经插入
       */
      function insertSpace() {
        const el = state.editorEl
        if (!el) return false

        const editor = getEditorFrom(el)
        if (editor && typeof editor.update === 'function') {
          let inserted = false
          try {
            editor.update(function () {
              try {
                const editorState = editor.getEditorState()
                const selection = editorState && editorState._selection
                if (selection && typeof selection.insertText === 'function') {
                  selection.insertText(' ')
                  inserted = true
                }
              } catch (error) {
                /* 交给下面的兜底 */
              }
            })
          } catch (error) {
            inserted = false
          }
          if (inserted) return true
        }

        // 兜底：浏览器级插入，Lexical 会经 beforeinput 接住
        try {
          if (typeof el.focus === 'function' && document.activeElement !== el) el.focus()
          if (document.execCommand && document.execCommand('insertText', false, ' ')) return true
        } catch (error) {
          /* 落到下面 */
        }

        // 最后兜底：直接把空格写进可编辑元素，再报一次 input 让 Lexical 同步
        try {
          if (document.activeElement !== el) el.focus()
          const selection = window.getSelection()
          if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0)
            range.deleteContents()
            const text = document.createTextNode(' ')
            range.insertNode(text)
            range.setStartAfter(text)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }))
            return true
          }
        } catch (error) {
          /* 放弃 */
        }
        return false
      }

      /* ---------- 原语音插件的按钮 ---------- */

      function activityRow() {
        const card = findCard()
        return card ? card.querySelector(ACTIVITY_SELECTOR) : document.querySelector(ACTIVITY_SELECTOR)
      }

      function activityPhase() {
        const row = activityRow()
        return row ? row.getAttribute('data-voice-activity') : ''
      }

      function findTrigger() {
        const card = findCard()
        if (!card) return null
        const labelled = card.querySelectorAll('button[aria-label]')
        for (const button of labelled) {
          if (TRIGGER_LABELS.indexOf(button.getAttribute('aria-label') || '') >= 0) return button
        }
        // aria-label 随语言变化，退回语音插件自己的类名片段
        const anchor = card.querySelector('[class*="_triggerAnchor"]')
        if (anchor) return anchor.querySelector('button')
        return null
      }

      function clickTrigger() {
        const trigger = findTrigger()
        if (!trigger || trigger.disabled) return 'missing'
        if (trigger.getAttribute('aria-haspopup') === 'dialog') return 'unusable'
        trigger.click()
        return 'ok'
      }

      function clickFirstActivityButton() {
        const row = activityRow()
        if (!row) return false
        const button = row.querySelector('button')
        if (!button) return false
        button.click()
        return true
      }

      function clickStop() {
        const row = activityRow()
        if (!row) return false
        const buttons = row.querySelectorAll('button')
        if (buttons.length === 0) return false
        buttons[buttons.length - 1].click()
        return true
      }

      /* ---------- 状态机 ---------- */

      function end(reason) {
        state.phase = 'idle'
        state.epoch++
        clearAllTimers()
        renderPhase('idle')
        if (reason) logger.debug(`[${PLUGIN_ID}] end: ${reason}`)
      }

      function showWarning(reason) {
        clearWatchTimer()
        clickFirstActivityButton() // 万一已经开录，先让它收手
        state.phase = 'warning'
        state.epoch++
        renderPhase('warning', '麦克风不可用')
        warn(`warning: ${reason}`)
        clearWarnTimer()
        state.warnTimer = setTimeout(() => {
          state.warnTimer = 0
          if (state.phase === 'warning') end('warning-timeout')
        }, WARN_MS)
      }

      function arm() {
        state.phase = 'arming'
        const epoch = ++state.epoch
        renderPhase('arming', '正在听写…')
        clearArmTimer()
        state.armTimer = setTimeout(() => {
          state.armTimer = 0
          if (state.phase !== 'arming' || state.epoch !== epoch) return
          beginListening(epoch)
        }, HOLD_MS)
      }

      function beginListening(epoch) {
        state.phase = 'listening'
        ++state.epoch
        renderPhase('listening', '正在听写…')
        tryStart(state.epoch, 0)
      }

      /**
       * 点原插件的触发按钮。
       * 上一轮如果停在 feedback 行（比如「未识别到语音」），触发按钮是不渲染的，
       * 所以先点掉那一行再重试；连续几次都找不到才认为是真的不可用。
       */
      function tryStart(epoch, attempt) {
        if (state.phase !== 'listening' || state.epoch !== epoch) return
        const result = clickTrigger()
        if (result === 'ok') {
          watchActivityStart(epoch)
          return
        }
        if (result === 'unusable') {
          showWarning('语音输入尚未就绪')
          return
        }
        if (activityRow() && attempt < 4) {
          clickFirstActivityButton()
          state.watchTimer = setTimeout(() => tryStart(epoch, attempt + 1), 70)
          return
        }
        showWarning('找不到听写按钮')
      }

      /** 点了按钮之后确认它真的开录了；没开起来就是权限/设备问题。 */
      function watchActivityStart(epoch) {
        const startedAt = Date.now()
        const tick = () => {
          state.watchTimer = 0
          if (state.phase !== 'listening' || state.epoch !== epoch) return
          const row = activityRow()
          const phase = row ? row.getAttribute('data-voice-activity') : ''
          if (phase === 'recording') return
          if (phase === 'feedback') {
            showWarning('语音插件反馈失败')
            return
          }
          if (Date.now() - startedAt > ACTIVITY_DEADLINE_MS) {
            showWarning('长时间没有进入录音')
            return
          }
          state.watchTimer = setTimeout(tick, 60)
        }
        state.watchTimer = setTimeout(tick, 60)
      }

      /** 松手：等 recording 出现后点「停止并识别」。 */
      function stop() {
        if (state.phase !== 'listening') return
        const phase = activityPhase()
        end('keyup')
        if (phase === 'recording') {
          clickStop()
          return
        }
        // 还在 requesting：等它真正开录再停，免得录个不停
        const startedAt = Date.now()
        const tick = () => {
          const current = activityPhase()
          if (current === 'recording') {
            clickStop()
            return
          }
          if (current !== 'requesting') return
          if (Date.now() - startedAt > ACTIVITY_DEADLINE_MS) {
            clickFirstActivityButton()
            return
          }
          setTimeout(tick, 40)
        }
        setTimeout(tick, 40)
      }

      /** Esc：丢掉这次结果。原插件的 cancel() 会 abort 录音，不会插入任何文字。 */
      function cancel() {
        if (state.phase !== 'listening') return
        clickFirstActivityButton()
        end('escape')
      }

      /* ---------- 事件 ---------- */

      function onKeyDown(event) {
        const editorEl = composerOf(event.target)
        if (!editorEl) return
        if (state.occluded) refreshIdle() // 只在对话输入框里认空格，其他输入框一概不管
        state.editorEl = editorEl

        if (isSpaceEvent(event)) {
          if (isComposing(event, editorEl)) return // 选词：完全不管
          if (event.metaKey || event.ctrlKey || event.altKey) return // 组合键不管

          if (state.phase === 'warning') {
            end('typing-during-warning') // 警示态不挡打字
            return
          }
          if (state.phase === 'arming' || state.phase === 'listening') {
            event.preventDefault() // 按住期间的重复空格一律吞掉
            return
          }
          if (event.repeat) return
          event.preventDefault()
          arm()
          return
        }

        if (event.key === 'Escape' && state.phase === 'listening') {
          event.preventDefault()
          cancel()
        }
      }

      function onKeyUp(event) {
        if (!isSpaceEvent(event)) return
        if (state.phase === 'arming') {
          clearArmTimer()
          end('short-press')
          insertSpace()
          return
        }
        if (state.phase === 'listening') stop()
      }

      function onWindowBlur() {
        if (state.phase === 'listening') {
          clickFirstActivityButton()
          end('blur')
        } else if (state.phase === 'arming') {
          clearArmTimer()
          end('blur-arming')
        }
      }

      function onDocumentEscape(event) {
        if (event.key !== 'Escape' || state.phase !== 'listening') return
        event.preventDefault()
        cancel()
      }

      function onPointerDown(event) {
        // 在输入框里点一下，就顺手复审一次遮挡，避免状态卡在「被盖住」
        if (state.occluded && event.target instanceof Node) {
          const editorEl = composerOf(event.target)
          if (editorEl) refreshIdle()
        }
        // 听写中点别处：按失焦处理（原插件也可能自己 cancel）
        if (state.phase !== 'listening') return
        if (event.target instanceof Node && state.cardEl && state.cardEl.contains(event.target)) return
        clickFirstActivityButton()
        end('pointer-outside')
      }

      /* ---------- 绑定 ---------- */

      /** 事件目标是否落在对话输入框（Lexical 根 + 卡片内）里。 */
      function composerOf(target) {
        if (!target || typeof target.closest !== 'function') return null
        const el = target.closest(EDITOR_SELECTOR)
        if (!el) return null
        return el.closest(CARD_SELECTOR) ? el : null
      }

      /** 输入/组合事件：只在对话输入框里更新空草稿提示。 */
      function onEditorInput(event) {
        const el = composerOf(event.target)
        if (!el) return
        state.editorEl = el
        updateHint()
      }

      /* ---------- 生命周期 ---------- */

      function start() {
        if (state.started) return
        state.started = true
        injectStyle()
        updateHint()
        // 编辑器可能比插件晚挂载：再试着找几次，找到就把提示亮出来
        let tries = 0
        const kickHint = () => {
          updateHint()
          if (++tries < 8) setTimeout(kickHint, 250)
        }
        setTimeout(kickHint, 0)

        // 全部走 document 捕获阶段：不用 MutationObserver 盯着整棵 body，
        // 也不依赖「先找到编辑器再绑事件」，会话切换、输入框重建都自动跟上。
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('keyup', onKeyUp, true)
        document.addEventListener('compositionstart', onCompositionStart, true)
        document.addEventListener('compositionend', onCompositionEnd, true)
        document.addEventListener('input', onEditorInput, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onDocumentEscape, true)
        window.addEventListener('blur', onWindowBlur)
        document.addEventListener('visibilitychange', onVisibilityChange)
        window.addEventListener('resize', syncBox)
        window.addEventListener('scroll', syncBox, true)

        // 空闲时也要复查：开屏动画、全屏弹层、切路由都可能把输入框盖住
        if (!state.idleTimer) state.idleTimer = setInterval(refreshIdle, 500)
      }

      /** 空闲态每 500ms 复查一次：卡片还在最上层吗？草稿是不是空的？ */
      function refreshIdle() {
        if (state.phase !== 'idle') return
        const card = findCard()
        if (!card) {
          hideOverlay()
          return
        }
        updateHint() // 顺带把浮层建出来
        applyOcclusion(card)
        updateHint()
      }

      function onVisibilityChange() {
        if (document.hidden && state.phase !== 'idle') {
          clickFirstActivityButton()
          end('hidden')
        }
      }

      function stopController() {
        state.started = false
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('keyup', onKeyUp, true)
        document.removeEventListener('compositionstart', onCompositionStart, true)
        document.removeEventListener('compositionend', onCompositionEnd, true)
        document.removeEventListener('input', onEditorInput, true)
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onDocumentEscape, true)
        window.removeEventListener('blur', onWindowBlur)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('resize', syncBox)
        window.removeEventListener('scroll', syncBox, true)
        clearAllTimers()
        stopTracking()
        if (state.idleTimer) clearInterval(state.idleTimer)
        state.idleTimer = 0
        if (state.overlay && state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay)
        state.overlay = null
        const style = document.getElementById(STYLE_ID)
        if (style && style.parentNode) style.parentNode.removeChild(style)
      }

      return {
        start,
        stop: stopController,
        _state: state,
        _internals: {
          isSpaceEvent,
          isComposing,
          insertSpace,
          findTrigger,
          activityPhase,
          renderPhase,
          refreshIdle,
          onKeyDown,
          onKeyUp
        }
      }
    }

    /* ------------------------------------------------------------------ 装配 */

    function apply(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      const logger = (ctx && ctx.logger) || console
      const controller = createController(logger)
      controller.start()
      exports.__controller = controller
      // 调试把手：控制台里 __dshVoiceSpacehold.state 看状态，.insertSpace() 手动测补空格
      try {
        window.__dshVoiceSpacehold = controller._internals
        window.__dshVoiceSpacehold.state = controller._state
      } catch (error) {
        /* 只读窗口无视 */
      }
      return function dispose() {
        controller.stop()
        exports.__controller = undefined
        try {
          delete window.__dshVoiceSpacehold
        } catch (error) {
          /* ignore */
        }
      }
    }

    exports.name = 'dsh-voice-spacehold'
    exports.inject = []
    exports.apply = apply

    return module.exports
  }
})
