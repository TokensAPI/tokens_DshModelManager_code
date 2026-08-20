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
  id: '@tokens/dsh-model-manager',
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
        title: 'Vision engine (ModLens)',
        subtitle: 'Vision engine provider configuration.',
        openConfig: 'Open config file',
        automatic: 'Automatic (failover chain decides)',
        pickToConfigure: 'Pick an engine above to configure its key and endpoint.',
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
        autoTitle: 'Auto mode',
        autoHint: 'Reuse the vision engines already on this machine.',
        found: 'found',
        notLoggedIn: 'found, not signed in',
        notFound: 'not on this machine',
        envSourced:
          'These come from environment variables. Saving copies them into the config file, which then becomes this engine’s only source.',
      },
      zh: {
        title: '视觉引擎（ModLens）',
        subtitle: '视觉引擎提供商配置。',
        openConfig: '打开配置文件',
        automatic: '自动（不固定，由故障转移链决定）',
        pickToConfigure: '在上面选一个引擎，才能配置它的密钥和地址。',
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
        autoTitle: 'auto 模式',
        autoHint: '自动复用本机已有视觉引擎。',
        found: '已找到',
        notLoggedIn: '已找到，未登录',
        notFound: '本机没有',
        envSourced: '这些值来自环境变量。保存会把它们写进配置文件，此后该引擎只认配置文件。',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    // The next draft when the engine changes or a summary arrives. The three
    // engine fields belong to the newly selected engine; the reuse grants are
    // the user's pending answers and survive an engine switch, since granting
    // codex has nothing to do with which engine reads the images.
    function nextDraft(summary, provider, keepReuse) {
      // provider '' is its own answer: not pinned, the failover chain
      // decides. There is then no single engine whose key belongs in these
      // fields, so they stay empty and the card says how to get them back.
      var engine = summary.engines[provider] || { baseUrl: '', model: '' }
      return {
        provider: provider,
        apiKey: '',
        baseUrl: engine.baseUrl,
        model: engine.model,
        reuse: Object.assign({}, keepReuse || summary.reuse),
      }
    }

    // What one save is actually about. The pin travels only when the select
    // moved; the engine fields only when they were edited. A save that always
    // carried both pinned an engine nobody chose and wrote the values the
    // card loaded back over whatever the file holds now.
    function savePayload(summary, draft) {
      var payload = { reuse: {} }
      REUSE.forEach((name) => {
        if (draft.reuse[name] !== summary.reuse[name]) {
          payload.reuse[name] = draft.reuse[name]
        }
      })
      if (draft.provider !== summary.provider) {
        payload.provider = draft.provider
      }
      var pristine = nextDraft(summary, draft.provider, draft.reuse)
      var engineEdited = draft.apiKey !== '' || draft.baseUrl !== pristine.baseUrl || draft.model !== pristine.model
      if (draft.provider !== '' && engineEdited) {
        payload.engine = draft.provider
        payload.apiKey = draft.apiKey
        payload.baseUrl = draft.baseUrl
        payload.model = draft.model
      }
      return payload
    }

    /**
     * How to render the API key field so the characters are hidden.
     *
     * A real password input makes Safari's iCloud Keychain offer to enable
     * autofill for the site and then pop its bubble on every focus, for a
     * field that is always empty: the key lives in the config file and the
     * host never sends it here, only whether one is stored. `autocomplete`
     * cannot turn that off, because WebKit ignores it on password fields on
     * purpose (issue #56). Masking with text-security gets the same hidden
     * characters without ever being a password field, and it also keeps a key
     * meant for one machine out of a synced keychain.
     *
     * Feature-detected rather than assumed. Where the property is missing the
     * field stays a password input: the nuisance is worth more than the
     * alternative, which is somebody's API key rendered in clear text while
     * they type it.
     *
     * This is a trade, not a free win, and the cost falls on people who are
     * not in the room. A password input carries a protected state into the
     * accessibility tree, and screen readers stop reading characters back
     * because of it. Masking is only paint: VoiceOver and NVDA will read this
     * key aloud, and ARIA has no equivalent to restore. Selection and copy
     * also become possible, and an IME candidate window shows what is being
     * typed above the field. Accepted here because the field is empty in
     * normal use (the key lives in the config file and is never sent to the
     * browser), so what a screen reader can read back is what the user is
     * typing at that moment, not a stored secret.
     */
    /**
     * Whether this browser masks a text field's characters. Only the prefixed
     * property exists: there is no unprefixed `text-security`, so probing for
     * one would be dead code that reads like a real path.
     *
     * A throwing `supports` counts as no support. The spec says the two
     * argument form returns false for an unknown property rather than
     * throwing, but this runs inside render, where an exception takes the
     * whole settings surface down instead of costing one field.
     */
    function supportsTextSecurity() {
      try {
        return (
          typeof CSS === 'object' &&
          CSS !== null &&
          typeof CSS.supports === 'function' &&
          CSS.supports('-webkit-text-security', 'disc') === true
        )
      } catch {
        return false
      }
    }

    function secretFieldProps() {
      if (!supportsTextSecurity()) {
        return { type: 'password' }
      }
      return {
        type: 'text',
        autoComplete: 'off',
        autoCorrect: 'off',
        autoCapitalize: 'off',
        spellCheck: false,
        style: { WebkitTextSecurity: 'disc' },
      }
    }

    function ConfigCard(react, ui) {
      var h = react.createElement
      var Input = ui.Input

      // The chrome is the native plugin card's, value for value (border,
      // layer backgrounds, 12px radius, header row with a rotating chevron,
      // footer with discard ghost + save primary), so this card reads as a
      // sibling of the built-in three rather than a lodger.
      var chevron = (open) =>
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )

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

        var seed = (next, provider, keepReuse) => nextDraft(next, provider, keepReuse)

        var load = react.useCallback(() => {
          // discover: the self-check probing which local harnesses exist to
          // be borrowed. Paid once per expand, cached host-side.
          fetch('/modlens/config?discover=1')
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

        // A row wrapping ONE control is a label, which names that control. A
        // row wrapping a set of them must not be: the label becomes the first
        // checkbox's accessible name and swallows the whole section's prose.
        // Those rows are a named group instead.
        var fieldRow = (label, control, key, groupName) =>
          h(
            groupName ? 'div' : 'label',
            {
              key: key,
              role: groupName ? 'group' : undefined,
              'aria-label': groupName || undefined,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } }, label),
            control,
          )

        var body = null
        if (open) {
          if (summary === null || draft === null) {
            body = h(
              'div',
              {
                style: {
                  padding: '12px 0',
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                  fontSize: '13px',
                },
              },
              note || t.loading,
            )
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

            var inputProps = (key, placeholder) => ({
              value: draft[key],
              placeholder: placeholder,
              onChange: (event) => {
                set(key, event.target.value)
              },
            })
            var textField = (label, key, type, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), { type: type })), key)
            // Its own function rather than a `type` string the caller has to
            // spell right. A sentinel compared with `===` fails open: one
            // typo, or a later edit passing 'text', and the key renders in
            // clear text with every test still green.
            var secretField = (label, key, placeholder) =>
              fieldRow(label, h(Input, Object.assign(inputProps(key, placeholder), secretFieldProps())), key)

            // Auto mode: the probes say which harnesses exist on this
            // machine. Found ones get a checkbox with their status; missing
            // ones are named as absent so the list explains itself.
            var probes = Array.isArray(summary.discovery) ? summary.discovery : null
            // Being listed means being found: an absent harness is simply
            // not shown, and only "not signed in" earns a note.
            var autoRows = REUSE.filter((name) => {
              if (!probes) return true
              var probe = probes.find((candidate) => candidate.harness === name)
              return probe ? probe.cliFound : false
            }).map((name) => {
              var probe = probes?.find((candidate) => candidate.harness === name)
              return h(
                'label',
                {
                  key: name,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                  },
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
                h('span', null, name),
                probe && probe.loggedIn === false
                  ? h(
                      'span',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                          fontSize: '12px',
                        },
                      },
                      t.notLoggedIn,
                    )
                  : null,
              )
            })

            body = h(
              'div',
              null,
              fieldRow(
                t.engine,
                h(
                  'select',
                  {
                    value: draft.provider,
                    onChange: (event) => {
                      draftState[1](seed(summary, event.target.value, draft.reuse))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: '13px',
                    },
                  },
                  [h('option', { key: '', value: '' }, t.automatic)].concat(
                    ENGINES.map((name) => h('option', { key: name, value: name }, name)),
                  ),
                ),
                'engine',
              ),
              draft.provider === ''
                ? fieldRow(
                    t.apiKey,
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.pickToConfigure,
                    ),
                    'unpinned',
                  )
                : keyless
                  ? fieldRow(
                      t.apiKey,
                      h(
                        'div',
                        {
                          style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
                        },
                        t.cliNote,
                      ),
                      'clinote',
                    )
                  : secretField(t.apiKey, 'apiKey', current.hasKey ? t.stored : t.unset),
              draft.provider === '' || keyless ? null : textField(t.baseUrl, 'baseUrl', 'text', t.fallback),
              draft.provider === '' ? null : textField(t.model, 'model', 'text', t.fallback),
              // Where these values are coming from, said once, because the
              // first save moves them: an engine the file names takes its
              // settings from the file alone.
              draft.provider === '' || current.source !== 'env'
                ? null
                : fieldRow(
                    '',
                    h(
                      'div',
                      {
                        style: {
                          fontSize: '13px',
                          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        },
                      },
                      t.envSourced,
                    ),
                    'envsourced',
                  ),
              fieldRow(
                h(
                  'span',
                  null,
                  t.autoTitle,
                  h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                        fontWeight: 400,
                        marginLeft: '8px',
                      },
                    },
                    t.autoHint,
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 18px', paddingTop: '2px' } },
                  autoRows,
                ),
                'auto',
                t.autoTitle,
              ),
              h(
                'div',
                {
                  key: 'footer',
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'a',
                  {
                    href: '#',
                    onClick: (event) => {
                      event.preventDefault()
                      fetch('/modlens/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ open: true }),
                      }).catch(() => {})
                    },
                    style: {
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                    },
                  },
                  t.openConfig,
                ),
                h(
                  'span',
                  {
                    role: 'status',
                    style: {
                      marginRight: 'auto',
                      marginLeft: '10px',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    },
                  },
                  note,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      draftState[1](seed(summary, summary.provider))
                      noteState[1]('')
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'none',
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      opacity: dirty ? 1 : 0.4,
                    },
                  },
                  t.discard,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !dirty || note === t.saving,
                    onClick: () => {
                      noteState[1](t.saving)
                      var payload = savePayload(summary, draft)
                      fetch('/modlens/config', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(payload),
                      })
                        .then((r) =>
                          r.json().then((payload) => {
                            if (!r.ok) throw new Error(payload.error || 'save failed')
                            return payload
                          }),
                        )
                        .then((next) => {
                          // The save response carries no discovery; keep the
                          // probes already on screen.
                          next.discovery = summary.discovery
                          summaryState[1](next)
                          draftState[1](seed(next, next.provider))
                          noteState[1](t.saved)
                        })
                        .catch((error) => {
                          noteState[1](String(error.message ? error.message : error))
                        })
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: dirty ? 'pointer' : 'default',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-state-business-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
                      opacity: dirty ? 1 : 0.4,
                    },
                  },
                  t.save,
                ),
              ),
            )
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => {
                openState[1](!open)
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                {
                  style: {
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                    fontSize: '13px',
                    lineHeight: 1.5,
                  },
                },
                t.subtitle,
              ),
            ),
            chevron(open),
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
        )
      }
    }

    var MANAGER_TEXT = {
      en: {
        nav: 'Models',
        title: 'TokensAPI models',
        intro: 'Manage the TokensAPI endpoint, chat model, vision model, and API key in one place.',
        key: 'API key',
        missing: 'Not configured',
        ready: 'Configured',
        save: 'Save API key',
        saveModels: 'Save model choices',
        saving: 'Saving...',
        modelsSaved: 'Model choices saved',
        modelsUnavailable: 'The model list is temporarily unavailable.',
        stored: 'Saved API key',
        keyHint: 'Use Show or Copy, or type a new key to replace the saved value.',
        copy: 'Copy',
        copied: 'API key copied',
        copyFailed: 'Unable to copy the API key',
        searchModels: 'Search models',
        noModels: 'No matching models',
        main: 'Main model',
        vision: 'Vision model',
        nativeVision: 'The main model supports images directly. The separate vision bridge is not used.',
        directVision:
          'This model uses its direct route. Native image support is not confirmed, so the separate vision bridge is not used.',
        endpoint: 'Endpoint',
        gateTitle: 'Enter your TokensAPI API key',
        gateIntro: 'The key is verified before Desktop opens. Chat and vision stay locked until verification succeeds.',
        gateReverify: 'A key is stored but was not verified by this version. Enter it again to continue.',
        checking: 'Checking sign-in status...',
        verify: 'Verify and continue',
        verifying: 'Verifying...',
        show: 'Show',
        hide: 'Hide',
      },
      zh: {
        nav: '模型',
        title: 'TokensAPI 模型',
        intro: '在这里统一管理 TokensAPI 接口、主模型、视觉模型和 API Key。',
        key: 'API Key',
        missing: '未配置',
        ready: '已配置',
        save: '保存 API Key',
        saveModels: '保存模型选择',
        saving: '保存中…',
        modelsSaved: '模型选择已保存',
        modelsUnavailable: '暂时无法获取模型列表。',
        stored: 'API Key 已保存',
        keyHint: '可点击“显示”或“复制”，也可以直接输入新 Key 进行替换。',
        copy: '复制',
        copied: 'API Key 已复制',
        copyFailed: '无法复制 API Key',
        searchModels: '搜索模型',
        noModels: '没有匹配的模型',
        main: '主模型',
        vision: '视觉模型',
        nativeVision: '当前主模型原生支持图片，直接使用其视觉能力，无需单独的视觉桥接模型。',
        directVision: '当前模型使用直连模式；尚未确认其原生图片能力，因此不启用额外的视觉桥接模型。',
        endpoint: '接口地址',
        gateTitle: '请输入 TokensAPI API Key',
        gateIntro: 'Desktop 会先验证 Key；验证成功前，聊天和识图功能保持锁定。',
        gateReverify: '检测到旧版本保存的 Key，但尚未经过本版本验证。请重新输入后继续。',
        checking: '正在检查登录状态…',
        verify: '验证并进入',
        verifying: '正在验证…',
        show: '显示',
        hide: '隐藏',
      },
    }

    function managerLabels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? MANAGER_TEXT.zh : MANAGER_TEXT.en
    }

    /**
     * Full-screen, fail-closed Desktop gate. It is deliberately plain DOM so
     * it mounts before React slots and cannot briefly expose the chat shell.
     * The API key lives only in the password input and the one POST request.
     */
    function registerAccessGate() {
      var root = document.body || document.documentElement
      if (!root || typeof document.createElement !== 'function' || typeof root.appendChild !== 'function')
        return () => {}
      var previous = document.getElementById?.('tokens-model-manager-gate')
      if (previous) previous.remove()
      var t = managerLabels()
      var overlay = document.createElement('div')
      overlay.id = 'tokens-model-manager-gate'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:linear-gradient(145deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-1) 45%,var(--dsw-alias-bg-layer-2));font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary)'
      var oldOverflow = document.documentElement?.style?.overflow || ''
      if (document.documentElement?.style) document.documentElement.style.overflow = 'hidden'
      root.appendChild(overlay)
      var closed = false

      function close() {
        if (closed) return
        closed = true
        overlay.remove()
        if (document.documentElement?.style) document.documentElement.style.overflow = oldOverflow
      }

      function node(tag, text, css) {
        var element = document.createElement(tag)
        if (text !== undefined) element.textContent = text
        if (css) element.style.cssText = css
        return element
      }

      function cardShell() {
        overlay.replaceChildren()
        var card = node(
          'div',
          undefined,
          'width:min(440px,100%);box-sizing:border-box;padding:32px;border:1px solid var(--dsw-alias-bg-layer-3);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 70px rgba(30,64,175,.16)',
        )
        var brand = node(
          'div',
          'TokensAPI',
          'font-size:14px;font-weight:750;letter-spacing:.12em;color:var(--dsw-alias-state-business-primary);margin-bottom:16px',
        )
        card.appendChild(brand)
        overlay.appendChild(card)
        return card
      }

      function renderChecking() {
        var card = cardShell()
        card.appendChild(node('h1', t.gateTitle, 'font-size:25px;line-height:1.25;margin:0 0 12px'))
        card.appendChild(node('p', t.checking, 'margin:0;color:var(--dsw-alias-label-secondary);line-height:1.6'))
      }

      function renderForm(status, errorMessage) {
        var card = cardShell()
        card.appendChild(node('h1', t.gateTitle, 'font-size:25px;line-height:1.25;margin:0 0 12px'))
        card.appendChild(
          node(
            'p',
            status?.configured && !status?.authenticated ? t.gateReverify : t.gateIntro,
            'margin:0 0 22px;color:var(--dsw-alias-label-secondary);line-height:1.6',
          ),
        )
        var form = node('form')
        var label = node('label', t.key, 'display:block;font-size:14px;font-weight:650;margin-bottom:8px')
        label.setAttribute('for', 'tokens-model-manager-key')
        var inputRow = node('div', undefined, 'display:flex;gap:8px')
        var input = node(
          'input',
          undefined,
          'min-width:0;flex:1;box-sizing:border-box;padding:12px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;outline:none',
        )
        input.id = 'tokens-model-manager-key'
        input.name = 'apiKey'
        input.type = 'password'
        input.autocomplete = 'off'
        input.spellcheck = false
        var reveal = node(
          'button',
          t.show,
          'padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer',
        )
        reveal.type = 'button'
        reveal.addEventListener('click', () => {
          var visible = input.type === 'text'
          input.type = visible ? 'password' : 'text'
          reveal.textContent = visible ? t.show : t.hide
          input.focus()
        })
        inputRow.appendChild(input)
        inputRow.appendChild(reveal)
        var message = node(
          'p',
          errorMessage || '',
          `min-height:21px;margin:10px 0;color:${errorMessage ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'};font-size:13px;line-height:1.5`,
        )
        message.setAttribute(errorMessage ? 'role' : 'aria-live', errorMessage ? 'alert' : 'polite')
        var submit = node(
          'button',
          t.verify,
          'width:100%;padding:12px 16px;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-bg-layer-2);font:inherit;font-weight:700;cursor:pointer',
        )
        submit.type = 'submit'
        form.appendChild(label)
        form.appendChild(inputRow)
        form.appendChild(message)
        form.appendChild(submit)
        form.addEventListener('submit', (event) => {
          event.preventDefault()
          var apiKey = input.value.trim()
          if (!apiKey) {
            message.textContent = t.missing
            message.style.color = 'var(--dsw-alias-state-error-primary)'
            return
          }
          input.disabled = true
          reveal.disabled = true
          submit.disabled = true
          submit.textContent = t.verifying
          message.textContent = ''
          fetch('/tokens/model-manager', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: apiKey }),
          })
            .then((response) =>
              response
                .json()
                .catch(() => ({}))
                .then((body) => ({ response: response, body: body })),
            )
            .then(({ response, body }) => {
              input.value = ''
              if (!response.ok || body?.authenticated !== true) throw new Error(body?.error || t.missing)
              close()
            })
            .catch((error) => {
              message.textContent = String(error.message || error)
              message.style.color = 'var(--dsw-alias-state-error-primary)'
              input.disabled = false
              reveal.disabled = false
              submit.disabled = false
              submit.textContent = t.verify
              input.focus()
            })
        })
        card.appendChild(form)
        setTimeout(() => input.focus(), 0)
      }

      renderChecking()
      fetch('/tokens/model-manager', { cache: 'no-store' })
        .then((response) =>
          response
            .json()
            .catch(() => ({}))
            .then((body) => ({ response: response, body: body })),
        )
        .then(({ response, body }) => {
          if (!response.ok) throw new Error(body?.error || 'status unavailable')
          if (body?.authenticated === true) close()
          else renderForm(body, '')
        })
        .catch((error) => renderForm(null, String(error.message || error)))
      return close
    }

    function ModelManagerSection(react, synchronizeMainSelection) {
      var h = react.createElement
      return function TokensModelManager() {
        var statePair = react.useState(null)
        var keyPair = react.useState('')
        var mainPair = react.useState('')
        var visionPair = react.useState('')
        var revealPair = react.useState(false)
        var pickerPair = react.useState('')
        var queryPair = react.useState('')
        var notePair = react.useState('')
        var busyPair = react.useState(false)
        var state = statePair[0]
        var apiKey = keyPair[0]
        var mainModel = mainPair[0]
        var visionModel = visionPair[0]
        var keyVisible = revealPair[0]
        var openPicker = pickerPair[0]
        var modelQuery = queryPair[0]
        var note = notePair[0]
        var busy = busyPair[0]
        var t = managerLabels()

        var load = react.useCallback(
          () =>
            fetch('/tokens/model-manager', { cache: 'no-store' })
              .then((response) =>
                response.json().then((body) => {
                  if (!response.ok) throw new Error(body.error || 'load failed')
                  return body
                }),
              )
              .then((body) => {
                statePair[1](body)
                mainPair[1](body.mainModel || '')
                visionPair[1](body.visionModel || '')
                notePair[1]('')
              })
              .catch((error) => {
                notePair[1](String(error.message || error))
              }),
          [],
        )

        react.useEffect(() => {
          load()
        }, [load])

        var save = (event) => {
          event.preventDefault()
          if (!apiKey.trim() || busy) return
          busyPair[1](true)
          notePair[1]('')
          fetch('/tokens/model-manager', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: apiKey }),
          })
            .then((response) =>
              response.json().then((body) => {
                if (!response.ok) throw new Error(body.error || 'save failed')
                return body
              }),
            )
            .then((body) =>
              Promise.resolve(synchronizeMainSelection(body.mainModel, body.mainProvider)).then(() => body),
            )
            .then((body) => {
              statePair[1](body)
              mainPair[1](body.mainModel || '')
              visionPair[1](body.visionModel || '')
              keyPair[1]('')
              revealPair[1](false)
              notePair[1](t.ready)
            })
            .catch((error) => {
              notePair[1](String(error.message || error))
            })
            .finally(() => {
              busyPair[1](false)
            })
        }

        var saveModels = (event) => {
          event.preventDefault()
          if (!mainModel || !visionModel || busy || !state?.modelsAvailable) return
          busyPair[1](true)
          notePair[1]('')
          fetch('/tokens/model-manager', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mainModel: mainModel, visionModel: visionModel }),
          })
            .then((response) =>
              response.json().then((body) => {
                if (!response.ok) throw new Error(body.error || 'save failed')
                return body
              }),
            )
            .then((body) =>
              Promise.resolve(synchronizeMainSelection(body.mainModel, body.mainProvider)).then(() => body),
            )
            .then((body) => {
              statePair[1](body)
              mainPair[1](body.mainModel || '')
              visionPair[1](body.visionModel || '')
              notePair[1](t.modelsSaved)
            })
            .catch((error) => notePair[1](String(error.message || error)))
            .finally(() => busyPair[1](false))
        }

        var fetchStoredKey = () =>
          fetch('/tokens/model-manager', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'revealApiKey' }),
          }).then((response) =>
            response.json().then((body) => {
              if (!response.ok || typeof body.apiKey !== 'string') throw new Error(body.error || 'load failed')
              keyPair[1](body.apiKey)
              return body.apiKey
            }),
          )

        var toggleKey = () => {
          if (busy) return
          if (apiKey) {
            revealPair[1](!keyVisible)
            return
          }
          busyPair[1](true)
          notePair[1]('')
          fetchStoredKey()
            .then(() => revealPair[1](true))
            .catch((error) => notePair[1](String(error.message || error)))
            .finally(() => busyPair[1](false))
        }

        var copyKey = () => {
          if (busy) return
          busyPair[1](true)
          notePair[1]('')
          Promise.resolve(apiKey || fetchStoredKey())
            .then((value) => {
              if (typeof navigator.clipboard?.writeText !== 'function') throw new Error(t.copyFailed)
              return navigator.clipboard.writeText(value)
            })
            .then(() => notePair[1](t.copied))
            .catch((error) => notePair[1](String(error.message || error)))
            .finally(() => busyPair[1](false))
        }

        var row = (label, value) =>
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, padding: '8px 0' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, label),
            h('code', null, value || '—'),
          )

        var modelRow = (label, value, setValue, pickerId) => {
          var expanded = openPicker === pickerId
          var query = modelQuery.trim().toLowerCase()
          var models = (state?.models || []).filter((model) => {
            if (!query) return true
            return `${model.id} ${model.name || ''}`.toLowerCase().includes(query)
          })
          return h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, padding: '8px 0' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)', paddingTop: 10 } }, label),
            h(
              'div',
              {
                style: { position: 'relative', minWidth: 0 },
                onBlur: (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) pickerPair[1]('')
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy || !state?.modelsAvailable,
                  'aria-expanded': expanded,
                  onClick: () => {
                    pickerPair[1](expanded ? '' : pickerId)
                    queryPair[1]('')
                  },
                  style: {
                    width: '100%',
                    minHeight: 44,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '9px 12px',
                    borderRadius: 10,
                    border: `1px solid ${expanded ? 'var(--dsw-alias-primary, var(--dsw-alias-state-business-primary))' : 'var(--dsw-alias-border-l2, var(--dsw-alias-border-l2))'}`,
                    background: 'var(--dsw-alias-background-layer-1, var(--dsw-alias-bg-layer-2))',
                    color: 'inherit',
                    font: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                    boxShadow: expanded ? '0 0 0 3px rgba(49,87,213,.10)' : 'none',
                  },
                },
                h(
                  'span',
                  { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  value || '—',
                ),
                h(
                  'span',
                  {
                    'aria-hidden': 'true',
                    style: {
                      color: 'var(--dsw-alias-label-secondary, #666)',
                      transform: expanded ? 'rotate(180deg)' : 'none',
                      transition: 'transform .15s ease',
                    },
                  },
                  '⌄',
                ),
              ),
              expanded
                ? h(
                    'div',
                    {
                      style: {
                        position: 'absolute',
                        zIndex: 50,
                        top: 'calc(100% + 6px)',
                        left: 0,
                        right: 0,
                        padding: 8,
                        border: '1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l2))',
                        borderRadius: 12,
                        background: 'var(--dsw-alias-background-layer-1, var(--dsw-alias-bg-layer-2))',
                        boxShadow: '0 14px 36px rgba(15,23,42,.14)',
                      },
                    },
                    h('input', {
                      value: modelQuery,
                      placeholder: t.searchModels,
                      onChange: (event) => queryPair[1](event.target.value),
                      style: {
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '9px 10px',
                        marginBottom: 6,
                        border: '1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l2))',
                        borderRadius: 8,
                        background: 'var(--dsw-alias-background-layer-1, var(--dsw-alias-bg-layer-2))',
                        color: 'inherit',
                        font: 'inherit',
                        outline: 'none',
                      },
                    }),
                    h(
                      'div',
                      { style: { maxHeight: 260, overflowY: 'auto', padding: '2px 0' } },
                      models.length === 0
                        ? h(
                            'div',
                            { style: { padding: '12px 10px', color: 'var(--dsw-alias-label-secondary, #666)' } },
                            t.noModels,
                          )
                        : models.map((model) =>
                            h(
                              'button',
                              {
                                key: model.id,
                                type: 'button',
                                onClick: () => {
                                  setValue(model.id)
                                  pickerPair[1]('')
                                  queryPair[1]('')
                                  notePair[1]('')
                                },
                                style: {
                                  width: '100%',
                                  display: 'block',
                                  padding: '9px 10px',
                                  border: 0,
                                  borderRadius: 8,
                                  background:
                                    model.id === value
                                      ? 'var(--dsw-alias-background-selected, var(--dsw-alias-bg-layer-1))'
                                      : 'transparent',
                                  color: 'inherit',
                                  font: 'inherit',
                                  textAlign: 'left',
                                  cursor: 'pointer',
                                },
                              },
                              model.name && model.name !== model.id
                                ? h(
                                    'span',
                                    null,
                                    h('span', { style: { display: 'block' } }, model.name),
                                    h(
                                      'code',
                                      { style: { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 12 } },
                                      model.id,
                                    ),
                                  )
                                : model.id,
                            ),
                          ),
                    ),
                  )
                : null,
            ),
          )
        }

        return h(
          'div',
          { style: { maxWidth: 760, padding: '8px 0 32px' } },
          h('h2', { style: { margin: '0 0 8px' } }, t.title),
          h('p', { style: { margin: '0 0 20px', color: 'var(--dsw-alias-label-secondary, #666)' } }, t.intro),
          state
            ? h(
                'div',
                {
                  style: {
                    border: '1px solid var(--dsw-alias-border-l2, #ddd)',
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 16,
                  },
                },
                row(t.endpoint, state.baseURL),
                h(
                  'form',
                  { onSubmit: saveModels },
                  modelRow(t.main, mainModel, mainPair[1], 'main'),
                  state.visionMode !== 'bridge'
                    ? h(
                        'div',
                        {
                          style: {
                            margin: '8px 0',
                            padding: '10px 12px',
                            borderRadius: 10,
                            background: 'var(--dsw-alias-bg-layer-2)',
                            color: 'var(--dsw-alias-label-secondary)',
                            fontSize: 13,
                            lineHeight: 1.5,
                          },
                        },
                        state.visionMode === 'native' ? t.nativeVision : t.directVision,
                      )
                    : modelRow(t.vision, visionModel, visionPair[1], 'vision'),
                  !state.modelsAvailable
                    ? h(
                        'p',
                        { style: { margin: '8px 0', color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } },
                        state.modelListError || t.modelsUnavailable,
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'submit',
                      disabled:
                        busy ||
                        !state.modelsAvailable ||
                        (mainModel === state.mainModel && visionModel === state.visionModel),
                      style: {
                        marginTop: 10,
                        padding: '9px 16px',
                        border: 0,
                        borderRadius: 8,
                        cursor: 'pointer',
                        background: 'var(--dsw-alias-state-business-primary)',
                        color: 'var(--dsw-alias-bg-layer-2)',
                        fontWeight: 700,
                        opacity:
                          busy ||
                          !state.modelsAvailable ||
                          (mainModel === state.mainModel && visionModel === state.visionModel)
                            ? 0.5
                            : 1,
                      },
                    },
                    busy ? t.saving : t.saveModels,
                  ),
                ),
              )
            : null,
          h(
            'form',
            {
              onSubmit: save,
              style: { border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, padding: 16 },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
              h('strong', null, t.key),
              h(
                'span',
                {
                  style: {
                    color: state?.authenticated
                      ? 'var(--dsw-alias-state-success-primary)'
                      : 'var(--dsw-alias-state-error-primary)',
                  },
                },
                state?.authenticated ? t.ready : t.missing,
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginBottom: 10 } },
              h('input', {
                value: apiKey,
                disabled: busy || (state && state.writable === false),
                placeholder: state?.configured ? t.stored : t.key,
                onChange: (event) => {
                  keyPair[1](event.target.value)
                  notePair[1]('')
                },
                style: {
                  width: '100%',
                  minWidth: 0,
                  flex: 1,
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                  ...(keyVisible ? { WebkitTextSecurity: 'none' } : secretFieldProps().style || {}),
                },
                type: keyVisible ? 'text' : secretFieldProps().type,
                autoComplete: 'off',
                autoCorrect: 'off',
                autoCapitalize: 'off',
                spellCheck: false,
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy || !state?.configured,
                  onClick: toggleKey,
                  style: {
                    padding: '0 13px',
                    border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                    borderRadius: 8,
                    background: 'var(--dsw-alias-background-layer-1, var(--dsw-alias-bg-layer-2))',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                keyVisible ? t.hide : t.show,
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy || !state?.configured,
                  onClick: copyKey,
                  style: {
                    padding: '0 13px',
                    border: '1px solid var(--dsw-alias-border-l2, #ccc)',
                    borderRadius: 8,
                    background: 'var(--dsw-alias-background-layer-1, var(--dsw-alias-bg-layer-2))',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                t.copy,
              ),
            ),
            state?.configured
              ? h(
                  'p',
                  {
                    style: {
                      margin: '-2px 0 8px',
                      fontSize: 13,
                      color: 'var(--dsw-alias-label-secondary, #666)',
                    },
                  },
                  t.keyHint,
                )
              : null,
            h(
              'p',
              {
                style: {
                  minHeight: 20,
                  margin: '0 0 10px',
                  fontSize: 13,
                  color: note ? 'var(--dsw-alias-label-secondary, #666)' : 'transparent',
                },
                role: 'status',
              },
              note || '.',
            ),
            h(
              'button',
              {
                type: 'submit',
                disabled: busy || !apiKey.trim() || (state && state.writable === false),
                style: {
                  padding: '9px 16px',
                  border: 0,
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: 'var(--dsw-alias-state-business-primary)',
                  color: 'var(--dsw-alias-bg-layer-2)',
                  fontWeight: 700,
                  opacity: busy || !apiKey.trim() || (state && state.writable === false) ? 0.5 : 1,
                },
              },
              busy ? t.saving : t.save,
            ),
          ),
        )
      }
    }

    /**
     * Apply the managed main model to the currently open ordinary session.
     *
     * The Host setting changed by /tokens/model-manager is the default for new
     * sessions. Existing sessions retain their own durable selection, so the
     * composer must submit session.selectModel through its shared directory as
     * well or it keeps displaying and using the previous model.
     */
    async function synchronizeCurrentSessionModel(sessions, modelDirectories, mainModel, mainProvider, retry) {
      if (typeof mainModel !== 'string' || mainModel.trim() === '') return false
      var provider = mainProvider === 'tokensapi' ? 'tokensapi' : 'modlens-tokensapi'
      var model = mainModel.trim()
      var sessionId = sessions?.list?.getSnapshot?.()?.current
      if (!sessionId || typeof modelDirectories?.directoryFor !== 'function') return false
      // Addressed subagent sessions intentionally do not expose model selection.
      if (typeof sessions?.subagentAddress === 'function' && sessions.subagentAddress(sessionId)) {
        return false
      }
      var directory = modelDirectories.directoryFor(sessionId)
      if (typeof directory?.select !== 'function') return false
      if (typeof directory.load === 'function') {
        var attempts = Number.isInteger(retry?.attempts) && retry.attempts > 0 ? retry.attempts : 20
        var delayMs = Number.isFinite(retry?.delayMs) && retry.delayMs >= 0 ? retry.delayMs : 100
        var available = false
        var loadError = null
        for (var attempt = 0; attempt < attempts; attempt += 1) {
          try {
            var loaded = await directory.load()
            var groups = Array.isArray(loaded?.groups) ? loaded.groups : directory.store?.getSnapshot?.()?.groups
            available =
              Array.isArray(groups) &&
              groups.some(
                (group) =>
                  group?.id === provider &&
                  Array.isArray(group.models) &&
                  group.models.some((entry) => entry?.id === model),
              )
            loadError = null
          } catch (error) {
            loadError = error
          }
          if (available) break
          if (attempt + 1 < attempts && delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs))
          }
        }
        if (!available) {
          if (loadError) throw new Error('模型目录刷新失败，请稍后重试')
          throw new Error(`模型目录尚未刷新到 ${provider}/${model}，请稍后重试`)
        }
      }
      await directory.select({ provider: provider, model: model })
      return true
    }

    function registerManagerSection(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots', 'sessions', 'modelDirectories'], (scope) => {
        fetch('/tokens/model-manager', { cache: 'no-store' })
          .then((response) => response.json().then((body) => ({ response, body })))
          .then(({ response, body }) => {
            if (!response.ok || body?.provider !== 'TokensAPI') return
            var react = require('react')
            var Section = ModelManagerSection(react, (mainModel, mainProvider) =>
              synchronizeCurrentSessionModel(scope.sessions, scope.modelDirectories, mainModel, mainProvider),
            )
            scope.slots.inject('settings.section', function* () {
              yield scope.slots.register(
                {
                  name: 'settings.section',
                  id: 'models',
                  order: 10,
                  label: () => managerLabels().nav,
                  inject: () => ({}),
                },
                Section,
              )
            })
          })
          .catch((error) => {
            console.error(`[tokens-model-manager] settings section skipped: ${error}`)
          })
      })
    }

    function apply(ctx) {
      var disposeGate = registerAccessGate()
      // The branded Models section owns endpoint, key, chat model, and vision
      // model now. Do not also mount the legacy ModLens engine card under
      // Plugins: it duplicates the same product settings and its route is
      // intentionally disabled by the TokensAPI bundle.
      registerManagerSection(ctx)
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
            disposeGate()
          },
          'modlens: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    // Exposed for the repo's tests only; not part of the plugin contract.
    exports.__card = {
      nextDraft: nextDraft,
      savePayload: savePayload,
      secretFieldProps: secretFieldProps,
      ConfigCard: ConfigCard,
    }
    exports.__manager = {
      registerAccessGate: registerAccessGate,
      synchronizeCurrentSessionModel: synchronizeCurrentSessionModel,
    }
    // Settings integration is optional, so its services are acquired through
    // registerManagerSection instead of making the whole browser plugin wait.
    exports.inject = []
    return module.exports
  },
})
