// Browser half of the modlens dsh plugin: paste-to-path.
//
// A capture-phase paste listener runs before the composer's own handler.
// When the clipboard carries image files, the default intake (attachment ->
// host image admission -> "model does not support images" for text-only
// models) is suppressed; the bytes go to the plugin's host route
// (POST /modlens/paste), land as a private temp file, and the returned path
// is inserted into the composer as plain text. A text-only model then sees
// exactly what Pi, OpenCode, and Claude Code hand their models: a file path,
// which is also the modlens skill's and the read tool's primary trigger.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half.
window.__ModuleLoader__.load({
  id: '@liustack/modlens',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/modlens/paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET /modlens/paste
    // with the selector label; the host resolves it against real model
    // metadata). A name regex here once declared every vision model it did
    // not recognize text-only and hijacked its native paste. The verdict is
    // cached per label and refreshed in the background; until a label has a
    // cached `true`, pastes stay native — the safe direction for both a
    // vision model (keeps its thumbnail) and a text-only one (keeps only its
    // old error message, once). A 404 means the route is off (pasteToPath:
    // false, or no host half), so the client stands down entirely instead of
    // swallowing pastes into a dead endpoint.
    var routeAvailable = true
    var verdicts = {}
    // A verdict older than this is UNKNOWN again, even while a refresh is in
    // flight: the route's model metadata can change mid-session (discovery
    // sweeps, provider mounts), and acting on a long-stale `true` is exactly
    // the vision-model hijack this design exists to prevent. The bound is a
    // backstop, since every focus and paste re-asks anyway.
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      // Dedupe only on an in-flight request, never on freshness: the host's
      // model inventory can change under an unchanged label (a same-named
      // route mounting mid-session), so every focus and paste re-asks and a
      // stale answer survives at most one local round-trip.
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
      fetch(`/modlens/paste?model=${encodeURIComponent(label)}`)
        .then((res) => {
          if (res.status === 404) {
            routeAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error(`policy ${res.status}`)
          return res.json()
        })
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      if (!routeAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var label = currentModelLabel()
      var cached = verdicts[label]
      refreshVerdict(label)
      // No fresh confirmed host verdict: leave the paste native. Wrong only
      // for a text-only model's very first paste, and self-correcting.
      if (!cached || cached.at === 0 || cached.takeover !== true || Date.now() - cached.at > VERDICT_MAX_AGE_MS) return
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      var target = event.target
      Promise.all(files.map(uploadOne))
        .then((results) => {
          var text = results
            .map((r) => r.path)
            .filter(Boolean)
            .join(' ')
          if (text) insertText(target, `${text} `)
        })
        .catch((error) => {
          // A 404 here means the route vanished AFTER a verdict confirmed it
          // (plugin disposed mid-session): that race can cost this one paste
          // — preventDefault already ran — but never another. Stand down and
          // forget every verdict, so the next paste goes native immediately.
          if (error && error.status === 404) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[modlens] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
    }

    // The settings card (issue #39). dsh renders a fixed set of plugin cards
    // and does not enumerate settings namespaces, so a card is contributed
    // through the `settings.plugin.item` slot rather than by declaring a
    // schema. It reads and writes the host route above, which owns
    // ~/.modlens/config.json: the browser never sees an API key, and never
    // sends a blank one back over a stored key.
    var ENGINES = ['antigravity-cli', 'gemini-api', 'openai', 'anthropic', 'claude-cli']
    var REUSE = ['claude', 'codex', 'opencode', 'pi', 'grok']

    // Two short label sets rather than a locale bundle: the card has a dozen
    // strings, and a bundle would be more machinery than the thing it labels.
    var TEXT = {
      en: {
        title: 'ModLens vision engine',
        subtitle: 'Shared with every harness through ~/.modlens/config.json.',
        engine: 'Engine',
        apiKey: 'API key',
        baseUrl: 'Base URL',
        model: 'Model',
        stored: 'stored, leave empty to keep it',
        unset: 'not set',
        fallback: 'provider default',
        save: 'Save',
        saving: 'saving...',
        saved: 'saved',
        loading: 'loading...',
        discard: 'Discard',
        cliNote: 'This engine signs in through its own CLI: no key, no endpoint.',
        autoTitle: 'Auto mode: reuse local sign-ins',
        autoHint: 'Let a read borrow another harness on this machine when your own engine cannot answer.',
      },
      zh: {
        title: 'ModLens 视觉引擎',
        subtitle: '通过 ~/.modlens/config.json 与所有 harness 共享。',
        engine: '引擎',
        apiKey: 'API 密钥',
        baseUrl: '接口地址',
        model: '模型',
        stored: '已保存，留空即不改动',
        unset: '未设置',
        fallback: '使用该引擎默认值',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loading: '加载中…',
        discard: '放弃修改',
        cliNote: '该引擎通过自己的 CLI 登录，无需密钥和接口地址。',
        autoTitle: 'auto 模式：复用本机已有登录',
        autoHint: '你自己的引擎答不了时，允许一次读取借用本机其他 harness 的登录。',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    function ConfigCard(react, ui) {
      var h = react.createElement
      var DisclosureRow = ui.DisclosureRow
      var Button = ui.Button
      var Input = ui.Input
      return function ModlensCard() {
        var t = labels()
        var openState = react.useState(false)
        var summaryState = react.useState(null)
        var draftState = react.useState(null)
        var noteState = react.useState('')
        var open = openState[0]
        var summary = summaryState[0]
        var draft = draftState[0]
        var note = noteState[0]

        var seed = (next, provider) => {
          var engine = next.engines[provider] || { baseUrl: '', model: '' }
          return {
            provider: provider,
            apiKey: '',
            baseUrl: engine.baseUrl,
            model: engine.model,
            reuse: Object.assign({}, next.reuse),
          }
        }

        var load = react.useCallback(() => {
          fetch('/modlens/config')
            .then((r) =>
              r.json().then((body) => {
                if (!r.ok) throw new Error(body.error || 'load failed')
                return body
              }),
            )
            .then((next) => {
              summaryState[1](next)
              draftState[1](seed(next, next.provider))
              noteState[1]('')
            })
            .catch((error) => {
              noteState[1](String(error.message ? error.message : error))
            })
        }, [])

        react.useEffect(() => {
          if (open && summary === null) load()
        }, [open, summary, load])

        var body = null
        if (open) {
          if (summary === null || draft === null) {
            body = h('div', { style: { padding: '8px 0', opacity: 0.7 } }, note || t.loading)
          } else {
            var keyless = (summary.keyless || []).indexOf(draft.provider) >= 0
            var current = summary.engines[draft.provider] || { hasKey: false }
            var pristine = seed(summary, draft.provider)
            var dirty =
              draft.provider !== summary.provider ||
              draft.apiKey !== '' ||
              draft.baseUrl !== pristine.baseUrl ||
              draft.model !== pristine.model ||
              REUSE.some((name) => draft.reuse[name] !== summary.reuse[name])

            var set = (key, value) => {
              var next = Object.assign({}, draft)
              next[key] = value
              draftState[1](next)
              noteState[1]('')
            }

            var field = (label, key, type, placeholder) =>
              h(
                'label',
                { key: key, style: { display: 'block', padding: '6px 0' } },
                h('div', { style: { fontSize: '12px', opacity: 0.7, paddingBottom: '4px' } }, label),
                h(Input, {
                  type: type,
                  value: draft[key],
                  placeholder: placeholder,
                  style: { width: '100%' },
                  onChange: (event) => {
                    set(key, event.target.value)
                  },
                }),
              )

            body = h(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              h(
                'label',
                { key: 'engine', style: { display: 'block', padding: '6px 0' } },
                h('div', { style: { fontSize: '12px', opacity: 0.7, paddingBottom: '4px' } }, t.engine),
                h(
                  'select',
                  {
                    value: draft.provider,
                    onChange: (event) => {
                      draftState[1](seed(summary, event.target.value))
                      noteState[1]('')
                    },
                    style: {
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                    },
                  },
                  ENGINES.map((name) => h('option', { key: name, value: name }, name)),
                ),
              ),
              // A CLI engine signs in through its own tool: a key and an
              // endpoint would be fields with nothing behind them.
              keyless ? null : field(t.apiKey, 'apiKey', 'password', current.hasKey ? t.stored : t.unset),
              keyless ? null : field(t.baseUrl, 'baseUrl', 'text', t.fallback),
              field(t.model, 'model', 'text', t.fallback),
              keyless
                ? h('div', { key: 'cli', style: { fontSize: '12px', opacity: 0.6, padding: '2px 0 6px' } }, t.cliNote)
                : null,
              h(
                'div',
                { key: 'auto', style: { paddingTop: '10px' } },
                h('div', { style: { fontSize: '12px', opacity: 0.7 } }, t.autoTitle),
                h('div', { style: { fontSize: '12px', opacity: 0.55, paddingBottom: '6px' } }, t.autoHint),
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px' } },
                  REUSE.map((name) =>
                    h(
                      'label',
                      {
                        key: name,
                        style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(draft.reuse[name]),
                        onChange: (event) => {
                          var next = Object.assign({}, draft.reuse)
                          next[name] = event.target.checked
                          set('reuse', next)
                        },
                      }),
                      name,
                    ),
                  ),
                ),
              ),
              h(
                'div',
                {
                  key: 'actions',
                  style: {
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    paddingTop: '12px',
                    marginTop: '10px',
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
                  },
                },
                h('span', { style: { marginRight: 'auto', fontSize: '12px', opacity: 0.7 } }, note),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'sm',
                    disabled: !dirty,
                    onClick: () => {
                      draftState[1](seed(summary, summary.provider))
                      noteState[1]('')
                    },
                  },
                  t.discard,
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    size: 'sm',
                    disabled: !dirty,
                    onClick: () => {
                      noteState[1](t.saving)
                      fetch('/modlens/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(draft),
                      })
                        .then((r) =>
                          r.json().then((payload) => {
                            if (!r.ok) throw new Error(payload.error || 'save failed')
                            return payload
                          }),
                        )
                        .then((next) => {
                          summaryState[1](next)
                          draftState[1](seed(next, next.provider))
                          noteState[1](t.saved)
                        })
                        .catch((error) => {
                          noteState[1](String(error.message ? error.message : error))
                        })
                    },
                  },
                  t.save,
                ),
              ),
            )
          }
        }

        return h(
          DisclosureRow,
          {
            icon: null,
            title: t.title,
            open: open,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => {
              openState[1](!open)
            },
            collapsedContent: h('span', { style: { fontSize: '13px', opacity: 0.6 } }, t.subtitle),
          },
          body,
        )
      }
    }

    function registerCard(ctx) {
      // Reaching for an undeclared service throws in cordis, so the optional
      // dependency rides a scoped ctx.inject: the closure runs where slots
      // exists and never runs where it does not, exactly as the host half
      // takes webServer.
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        try {
          mountCard(scope)
        } catch (error) {
          console.error('[modlens] settings card skipped: ' + error)
        }
      })
    }

    function mountCard(ctx) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error('[modlens] settings card skipped: ' + error)
        return
      }
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      var Card = ConfigCard(react, ui)
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({ name: 'settings.plugin.item', id: 'modlens', order: 30 }, Card)
      })
    }

    function apply(ctx) {
      registerCard(ctx)
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
          },
          'modlens: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    // `slots` is optional, so it is not required here: registerCard checks.
    exports.inject = []
    return module.exports
  },
})
