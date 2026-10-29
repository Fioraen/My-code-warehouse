/**
 * dsh-withdraw — 客户端入口。
 *
 * 交互：鼠标右键一条已发送的用户消息 → 立刻停住思考，弹出「修改 / 撤回」两个选项。
 *   - 撤回：Host 用替代节点覆盖「这条消息及其之后的全部内容」，思考到此结束。
 *   - 修改：摊开编辑框；按「保存并继续」才真正往下走——替换成新正文并继续生成。
 *     不保存（Esc／点别处／取消）则保持停住，什么都不做。
 * 三个动作最终都调用 Host 命令 /withdraw-pause、/withdraw、/revise，由 Host 改写 Session surface。
 *
 * 实现方式：注册 shell.overlay 里的一个浮层组件，以 capture 阶段监听 window 的
 * contextmenu，命中聊天行的 [data-chat-flow-kind="user"][data-chat-turn] 时弹出菜单。
 * 这样不需要替换宿主已有的 user 行渲染器（shadows-shipped-ui 风险）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-withdraw',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ZH = {
      revise: '修改',
      withdraw: '撤回',
      save: '保存并继续',
      cancel: '取消',
      busy: '处理中…',
      hint: '回车＝保存并继续，Shift+回车换行。保存后清除其后的对话，按新内容重新回答。',
      withdrawHint: '停止思考，撤回这条消息，并清除它之后的内容。',
      placeholder: '输入修改后的消息内容…',
      failed: '操作失败：',
    }

    const EN = {
      revise: 'Edit',
      withdraw: 'Withdraw',
      save: 'Save & continue',
      cancel: 'Cancel',
      busy: 'Working…',
      hint: 'Enter saves and continues, Shift+Enter adds a line. Everything after it is removed first.',
      withdrawHint: 'Stop the turn, take this message back, and clear everything after it.',
      placeholder: 'Write the replacement message…',
      failed: 'Failed: ',
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        try {
          ctx.locale.register('dsh-withdraw', 'zh', ZH)
          ctx.locale.register('dsh-withdraw', 'en', EN)
        } catch (error) {
          // 字典已存在时继续，用 key 兜底
        }
        const t = ctx.locale.bind('dsh-withdraw')

        const styles = {
          card: {
            position: 'fixed',
            zIndex: 2147483000,
            boxSizing: 'border-box',
            padding: '4px',
            borderRadius: '10px',
            background: 'var(--dsw-alias-surface-raised, #ffffff)',
            border: '1px solid var(--dsw-alias-border-default, #d0d7de)',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
            pointerEvents: 'auto',
            fontSize: '13px',
            lineHeight: 1.5,
            color: 'var(--dsw-alias-text-primary, #1f2328)',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            minWidth: '148px',
          },
          item: {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            textAlign: 'left',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: 1.4,
            padding: '6px 10px',
            borderRadius: '7px',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-text-primary, #1f2328)',
            cursor: 'pointer',
          },
          itemHover: {
            background: 'var(--dsw-alias-surface-sunken, rgba(0, 0, 0, 0.06))',
          },
          danger: {
            color: 'var(--dsw-alias-text-danger, #d1242f)',
          },
          editor: {
            width: '320px',
            boxSizing: 'border-box',
            minHeight: '84px',
            maxHeight: '40vh',
            resize: 'vertical',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            padding: '6px 8px',
            margin: '2px',
            borderRadius: '8px',
            color: 'var(--dsw-alias-text-primary, #1f2328)',
            background: 'var(--dsw-alias-surface-raised, #ffffff)',
            border: '1px solid var(--dsw-alias-border-default, #d0d7de)',
          },
          hint: {
            margin: '2px 8px 4px',
            maxWidth: '320px',
            color: 'var(--dsw-alias-text-weak, #8a8a8a)',
            fontSize: '11px',
            lineHeight: 1.4,
          },
          error: {
            margin: '2px 8px',
            maxWidth: '320px',
            color: 'var(--dsw-alias-text-danger, #d1242f)',
            fontSize: '11px',
            lineHeight: 1.4,
            wordBreak: 'break-word',
          },
          commandNote: {
            padding: '2px 2px',
            color: 'var(--dsw-alias-text-weak, #8a8a8a)',
            fontSize: '12px',
            lineHeight: 1.4,
          },
          row: {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '4px',
            padding: '2px',
          },
          buttonLike: {
            font: 'inherit',
            fontSize: '12px',
            lineHeight: 1.3,
            padding: '4px 10px',
            borderRadius: '7px',
            border: '1px solid var(--dsw-alias-border-default, #d0d7de)',
            background: 'transparent',
            color: 'var(--dsw-alias-text-accent, #3b82f6)',
            cursor: 'pointer',
          },
          disabled: {
            opacity: 0.5,
            cursor: 'default',
          },
        }

        /** 右键命中的那条用户消息所在的行（聊天行的数据属性由宿主 ChatView 渲染）。
         *  kind 为 `user` 是普通发送，`steering` 是「我还在答的时候你插话」那种，两者都要认。 */
        function findUserRow(target) {
          if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') {
            return null
          }
          return target.closest(
            '[data-chat-turn][data-chat-flow-kind="user"], [data-chat-turn][data-chat-flow-kind="steering"]',
          )
        }

        /** 取这行已经显示的正文，作为「修改」输入框的初值（顺手去掉尾部的时间戳）。 */
        function readRowText(row) {
          let raw = ''
          try {
            raw = row.innerText ?? ''
          } catch (error) {
            raw = ''
          }
          const lines = String(raw)
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
          while (lines.length > 0 && /^\d{1,2}:\d{2}(\s*[AaPp][Mm])?$/.test(lines[lines.length - 1])) {
            lines.pop()
          }
          return lines.join('\n')
        }

        async function sendCommand(sessionId, line) {
          let face = null
          try {
            face = ctx.sessions.binding(sessionId)?.session ?? null
          } catch (error) {
            face = null
          }
          if (face === null) throw new Error('session binding unavailable')
          const result = await face.command(line)
          if (result !== null && typeof result === 'object' && result.ok === false) {
            const detail = result.error
            throw new Error(String(detail?.message ?? detail?.code ?? detail ?? 'rejected'))
          }
          const value = result !== null && typeof result === 'object' && 'ok' in result ? result.value : result
          if (value !== null && typeof value === 'object' && value.matched === false) {
            throw new Error('command not registered on the Host')
          }
          return value
        }

        /** 右键菜单本体；常驻 shell.overlay，靠 window 上的 capture 监听定位。 */
        function WithdrawMenu() {
          const [spot, setSpot] = React.useState(null)
          const [editing, setEditing] = React.useState(false)
          const [draft, setDraft] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [hover, setHover] = React.useState('')
          const cardRef = React.useRef(null)
          /** 菜单打开的时刻：刚打开那一下宿主可能正在收尾、界面会自己滚一下，别把它当成「用户跑开了」。 */
          const openedAt = React.useRef(0)

          React.useEffect(() => {
            const onContextMenu = (event) => {
              const row = findUserRow(event.target)
              if (row === null) return
              const rawTurn = row.getAttribute('data-chat-turn')
              if (rawTurn === null) return
              const turn = Number(rawTurn)
              if (!Number.isSafeInteger(turn)) return
              const holder = row.closest('[data-conversation-session]')
              const sessionId = holder === null ? '' : (holder.getAttribute('data-conversation-session') ?? '')
              if (sessionId.length === 0) return
              event.preventDefault()
              event.stopPropagation()
              openedAt.current = Date.now()
              setSpot({ x: event.clientX, y: event.clientY, turn, sessionId })
              setEditing(false)
              setDraft(readRowText(row))
              setError('')
              setBusy(false)
              setHover('')
              // 右键一落下就停住思考：菜单开着的时候不要再有新的内容冒出来，
              // 之后一直停着——保存修改才继续，关掉菜单则什么都不做。
              void sendCommand(sessionId, '/withdraw-pause').catch((problem) => {
                console.warn('[dsh-withdraw] pause failed', problem)
              })
            }
            const close = () => {
              setSpot(null)
              setEditing(false)
            }
            /** 停住思考会让聊天区自己滚一下、窗口也可能短暂失焦，这些都不该把菜单吃掉。 */
            const closeIfUserDriven = () => {
              if (Date.now() - openedAt.current < 700) return
              close()
            }
            const onPointerDown = (event) => {
              const card = cardRef.current
              const target = event.target
              if (card !== null && target !== null && typeof card.contains === 'function' && card.contains(target)) {
                return
              }
              close()
            }
            const onKey = (event) => {
              if (event.key === 'Escape') close()
            }
            window.addEventListener('contextmenu', onContextMenu, true)
            window.addEventListener('mousedown', onPointerDown, true)
            window.addEventListener('wheel', closeIfUserDriven, true)
            window.addEventListener('touchmove', closeIfUserDriven, true)
            window.addEventListener('keydown', onKey, true)
            window.addEventListener('blur', closeIfUserDriven)
            return () => {
              window.removeEventListener('contextmenu', onContextMenu, true)
              window.removeEventListener('mousedown', onPointerDown, true)
              window.removeEventListener('wheel', closeIfUserDriven, true)
              window.removeEventListener('touchmove', closeIfUserDriven, true)
              window.removeEventListener('keydown', onKey, true)
              window.removeEventListener('blur', closeIfUserDriven)
            }
          }, [])

          if (spot === null) return null

          const run = async (line) => {
            setBusy(true)
            setError('')
            try {
              await sendCommand(spot.sessionId, line)
              setSpot(null)
              setEditing(false)
              setDraft('')
              // 宿主改写了会话记录，顺手让界面重新取一次投影。
              try {
                ctx.sessions.refreshProjections?.()
              } catch (refreshError) {
                console.warn('[dsh-withdraw] refreshProjections failed', refreshError)
              }
            } catch (problem) {
              console.error('[dsh-withdraw] command failed', problem)
              setError(t('failed') + String(problem?.message ?? problem))
            } finally {
              setBusy(false)
            }
          }

          const payload = JSON.stringify({ turn: spot.turn })

          const onWithdraw = () => {
            if (!busy) void run('/withdraw ' + payload)
          }

          // 右键时已经停住了，这里只是把编辑框摊开；按「保存并继续」才真的往下走。
          const beginRevise = () => {
            setEditing(true)
            setError('')
          }

          const onSave = () => {
            if (busy || draft.trim().length === 0) return
            void run('/revise ' + JSON.stringify({ turn: spot.turn, text: draft }))
          }

          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720
          const width = editing ? 340 : 168
          const height = editing ? 220 : 116
          const left = Math.max(8, Math.min(spot.x, viewportWidth - width - 8))
          const top = Math.max(8, Math.min(spot.y, viewportHeight - height - 8))

          const item = (key, label, onClick, extra) =>
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.item, ...(hover === key ? styles.itemHover : null), ...(extra ?? null) },
                onMouseEnter: () => setHover(key),
                onMouseLeave: () => setHover(''),
                onClick,
                disabled: busy,
              },
              label,
            )

          const children = []
          if (editing) {
            children.push(
              h('textarea', {
                key: 'editor',
                style: styles.editor,
                value: draft,
                placeholder: t('placeholder'),
                disabled: busy,
                autoFocus: true,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  // 输入法组字时的回车是「选词」，不能当成确认。
                  if (event.isComposing === true || event.nativeEvent?.isComposing === true) return
                  if (event.keyCode === 229) return
                  // 回车＝保存并继续；Shift+回车换行。
                  if (event.shiftKey) return
                  event.preventDefault()
                  onSave()
                },
              }),
              h('div', { key: 'hint', style: styles.hint }, t('hint')),
            )
            if (error.length > 0) children.push(h('div', { key: 'error', style: styles.error }, error))
            children.push(
              h(
                'div',
                { key: 'row', style: styles.row },
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...styles.buttonLike, ...(draft.trim().length === 0 || busy ? styles.disabled : null) },
                    onClick: onSave,
                    disabled: busy || draft.trim().length === 0,
                  },
                  busy ? t('busy') : t('save'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.buttonLike,
                    onClick: () => {
                      setSpot(null)
                      setEditing(false)
                    },
                    disabled: busy,
                  },
                  t('cancel'),
                ),
              ),
            )
          } else {
            children.push(
              item('revise', t('revise'), beginRevise),
              item('withdraw', t('withdraw'), onWithdraw, styles.danger),
              h('div', { key: 'hint', style: styles.hint }, busy ? t('busy') : t('withdrawHint')),
            )
            if (error.length > 0) children.push(h('div', { key: 'error', style: styles.error }, error))
          }

          return h(
            'div',
            {
              ref: cardRef,
              style: { ...styles.card, left: left + 'px', top: top + 'px' },
              role: 'menu',
            },
            children,
          )
        }

        /**
         * 这三条命令自己的行不显示命令名；只有出错时才有文字。
         * 成功时返回 null，聊天里就不会多出一行「/withdraw」。
         */
        function WithdrawCommandRow(props) {
          const data = props?.node?.data ?? props?.node ?? null
          const text = data !== null && typeof data === 'object' && typeof data.text === 'string' ? data.text : ''
          if (text.length === 0) return null
          return h('div', { style: styles.commandNote }, text)
        }

        for (const key of ['withdraw', 'revise', 'withdraw-pause']) {
          ctx.slots.inject('conversation.chat.commandview', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.commandview',
                key,
                label: `Withdraw command row: ${key}`,
              },
              WithdrawCommandRow,
            ),
          )
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-withdraw-menu',
              order: 50,
              label: 'Withdraw menu',
            },
            WithdrawMenu,
          ),
        )
      },
    }
  },
})