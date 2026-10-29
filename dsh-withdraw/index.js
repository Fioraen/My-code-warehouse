/**
 * dsh-withdraw — 修改 / 撤回已经发出的消息。
 *
 * 会话日志是 append-only 的，历史改写走 Session 自带的 surface 替换语义：
 * 追加一条 surface 事件，并把 [startSeq, endSeq] 这段 surface 节点整个让位给它。
 *
 * 撤回：用一条极短的占位消息替换「目标用户消息 … 当前最后一条节点」，
 * 该消息及其之后的内容一并从对话中消失，且不再触发新的思考。
 *
 * 修改：替换节点直接携带修改后的正文（不是说明文字），所以那条消息原地变成
 * 新内容；随后 agent.followup() 让模型按新内容作答。模型作答时宿主会把这条
 * inbox 消息再追加一次到日志里——那会渲染成重复的一行，因此等它出现后立刻
 * 用第二次替换把 [替换节点 … 新追加的那条] 合并回一条，界面始终只有一条消息。
 *
 * 停止思考：若 agent 正在运行，先 agent.cancel({ kind: 'user' })（与用户自己的
 * 停止同一条路径，但不保留 inbox，保证撤回之后真的安静下来），然后才改写记录。
 * 取消不是瞬时的——宿主可能还在等一个正在跑的工具收尾——所以改写是「重新取快照 →
 * 定位 → 替换」的原子尝试，失败就重试；替换后又冒出新节点时，从刚换出来的那个节点
 * 继续往后折，直到它是最后一个节点为止。目标只在第一次解析，之后一直锚定它，
 * 避免重试时按 turn 号重新解析、落到更早的那条用户消息上。
 *
 * 暂停：平台没有 suspend/resume 原语（官方文档原话：不存在让轮次继续运行、只中止
 * 步骤的操作），所以「停住」只能靠 cancel；被取消的流会把已交付的部分存成一条
 * `assistant/message { interrupted: true }`，半段内容原样留在对话里。右键一落下就
 * 发 /withdraw-pause（立刻 cancel，不等空闲，否则右键半天没反应），然后一直停着——
 * 点「修改」也只是摊开输入框，保存之后才按新正文继续；关掉菜单则保持停住。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

export const name = 'dsh-withdraw'
export const inject = ['commands', 'sessions', 'agents']

const NOTICE_WITHDRAW = '（已撤回）'
const MARK_REVISE = '（已修改）'

/** 取消之后最多等这么久；工具还在跑时等不到头，剩下的交给改写重试。 */
const SETTLE_TIMEOUT_MS = 3000
/** 命令里最多等这么久让合并发生在返回之前；更慢的就交给 mergeLater 后台处理。 */
const WAKE_TIMEOUT_MS = 1500
const WAKE_POLL_MS = 10

/** 命令返回后仍在后台等宿主补写重复行的时间窗口。 */
const LATE_MERGE_TIMEOUT_MS = 30000
const LATE_MERGE_POLL_MS = 250

/** 改写是「定位 + 替换」的原子尝试，宿主还在写时会失败，最多重试这么多次。 */
const MAX_ATTEMPTS = 6
const RETRY_DELAY_MS = 120

/** 单次替换最多允许波及的节点数；超过它说明目标定位错了，宁可报错也不要清掉半段历史。 */
const MAX_SHADOWED = 400

/** 排查用日志；默认写在工作区的插件目录里，测试时用环境变量改到临时文件。 */
const DEBUG_LOG =
  process.env.DSH_WITHDRAW_LOG ?? 'D:\\deepseek harness\\dsh-withdraw\\debug.log'

function log(...parts) {
  try {
    const line = parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ')
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/** 读取一个非负安全整数，否则 null。 */
function asInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** 解析命令行的 JSON 载荷；纯数字时退化为 seq。 */
function parsePayload(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text.length === 0) return {}
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      /* 落到下面的纯数字解析 */
    }
  }
  return { seq: asInt(text.split(/\s+/u)[0]) }
}

function renderError(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 当前 surface 节点（seq 列表）。 */
function surfaceNodes(session) {
  try {
    const nodes = session?.surface?.nodes
    return Array.isArray(nodes) ? Array.from(nodes) : []
  } catch {
    return null
  }
}

/** 按 seq 取事件，失败返回 null。 */
function eventAt(session, seq) {
  try {
    return session.eventAt(seq) ?? null
  } catch {
    return null
  }
}

/** 从 nodes 中倒序找第一个 <= ceiling 的用户消息节点索引。 */
function lastUserNodeAtOrBefore(session, nodes, ceiling) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (ceiling !== null && seq > ceiling) continue
    if (eventAt(session, seq)?.type === 'user/message') return index
  }
  return -1
}

/**
 * 一轮的边界 seq：有 turn/end 用它的 seq，否则用 turn/start 的 seq。
 * 注意 turn/start 总是排在触发它的用户消息之后，所以「该轮的用户消息」
 * 是边界之前最近的那条用户消息。
 */
function turnBoundary(session, turn) {
  let start = null
  let end = null
  try {
    for (const event of session.ownEvents()) {
      if (event?.data?.turn !== turn) continue
      if (event.type === 'turn/start' && start === null) start = event.seq
      if (event.type === 'turn/end') end = event.seq
    }
  } catch {
    return null
  }
  return end ?? start
}

/**
 * 在给定快照上定位目标用户消息的下标；找不到返回 -1。
 * 目标必须是 user/message：整段替换会把它之后的所有节点一起吃掉，选错的代价很大。
 */
function targetIndex(session, nodes, payload) {
  if (nodes.length < 2) return -1

  const exact = asInt(payload.seq)
  const turn = asInt(payload.turn)
  let index = -1

  if (turn !== null) {
    const boundary = turnBoundary(session, turn)
    if (boundary !== null) index = lastUserNodeAtOrBefore(session, nodes, boundary)
  }

  if (index <= 0 && exact !== null) {
    const at = nodes.indexOf(exact)
    if (at > 0) {
      index = at
      while (index > 0 && eventAt(session, nodes[index])?.type !== 'user/message') index -= 1
    } else if (at < 0) {
      index = lastUserNodeAtOrBefore(session, nodes, exact)
    }
  }

  if (index <= 0) index = lastUserNodeAtOrBefore(session, nodes, null)

  // 第 0 个节点是系统提示，永远不能被遮蔽。
  return index <= 0 ? -1 : index
}

/**
 * 一次替换：startSeq 这个节点之后（含）的全部节点 → 一条新的用户消息。
 * 传入的是节点 seq 而不是下标，遮蔽集在自己刚读到的快照上算——
 * 宿主还在写的时候，紧跟其后的那次读可能已经变了，跨快照复用下标就会触发
 * 宿主的遮蔽集校验错误（sourceEventSeqs must include every shadowed surface node）。
 */
function replaceTail(session, startSeq, template, text) {
  const nodes = surfaceNodes(session)
  if (nodes === null) return null
  const at = nodes.indexOf(startSeq)
  if (at < 1) return null
  const shadowed = nodes.slice(at)
  const created = session.append(
    'user/message',
    { ...template, id: randomUUID(), content: [{ type: 'text', text }] },
    {
      surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
      sourceEventSeqs: shadowed,
    },
  )
  const seq = created?.seq
  return typeof seq === 'number' ? { head: seq, removed: shadowed.length } : null
}

/** 用一条新消息覆盖 [startSeq, endSeq]（合并宿主补写的重复行时用），遮蔽集同样取自当前快照。 */
function replaceSpan(session, startSeq, endSeq, template, text) {
  const nodes = surfaceNodes(session)
  if (nodes === null) return null
  const from = nodes.indexOf(startSeq)
  const to = nodes.indexOf(endSeq)
  if (from < 1 || to < from) return null
  const shadowed = nodes.slice(from, to + 1)
  const created = session.append(
    'user/message',
    { ...template, id: randomUUID(), content: [{ type: 'text', text }] },
    {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: shadowed,
    },
  )
  const seq = created?.seq
  return typeof seq === 'number' ? { head: seq, removed: shadowed.length } : null
}

/**
 * 等宿主为刚排队的消息补写 user/message 事件。
 * 用户消息是模型开始作答时才进日志的（宿主用它作为本轮的提问），
 * 所以这里要等一小会儿，拿到那条重复行再把它合并掉。
 */
async function waitForUserEventAfter(session, afterSeq) {
  const deadline = Date.now() + WAKE_TIMEOUT_MS
  for (;;) {
    try {
      for (const event of session.ownEvents()) {
        if (event?.seq > afterSeq && event.type === 'user/message') return event
      }
    } catch {
      return null
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS))
  }
}

/**
 * 停止当前思考：与停止按钮相同的取消路径。
 * `wait` 为真时再等 agent 回到空闲（有上限）；暂停场景不等——用户要的是「立刻停住」，
 * 而且宿主收尾还要一会儿，等它反而让右键毫无反应。
 */
async function stopThinking(ctx, agent, wait) {
  if (agent === void 0 || agent === null) return
  if (agent.status !== 'running') return

  try {
    // 不保留 inbox：撤回/修改都要求先彻底安静下来，稍后需要继续时再显式排队。
    agent.cancel({ kind: 'user' })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-withdraw: cancel failed: ${renderError(error)}`)
    return
  }

  if (wait !== true) return

  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, SETTLE_TIMEOUT_MS)
  })
  try {
    // 取消不是瞬时的：宿主可能还在等一个正在跑的工具收尾。
    // 这里只等到「够用来改写记录」，剩下的竞态由改写本身的重试兜住。
    await Promise.race([agent.whenIdle().catch(() => void 0), timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 后台等待宿主补写的那条重复行并合并掉；不阻塞命令返回。 */
async function mergeLater(ctx, session, head, template, text) {
  const deadline = Date.now() + LATE_MERGE_TIMEOUT_MS
  for (;;) {
    if (Date.now() >= deadline) {
      log('late-merge', 'timeout', 'head=', head)
      return
    }
    await sleep(LATE_MERGE_POLL_MS)
    let wake = null
    try {
      for (const event of session.ownEvents()) {
        if (event?.seq > head && event.type === 'user/message') {
          wake = event
          break
        }
      }
    } catch {
      return
    }
    if (wake === null) continue
    try {
      const merged = replaceSpan(session, head, wake.seq, template, text)
      log('late-merge', 'merged', 'head=', merged?.head)
      await ctx.sessions.flush(session)
    } catch (error) {
      log('late-merge', 'failed', renderError(error))
    }
    return
  }
}

/** 同一会话上的改写串行执行：两道命令并发时，后一个会基于前一个的结果再算，不会互相拆台。 */
const sessionLocks = new WeakMap()

function withSessionLock(session, task) {
  const previous = sessionLocks.get(session) ?? Promise.resolve()
  const next = previous.then(task, task)
  sessionLocks.set(
    session,
    next.catch(() => void 0),
  )
  return next
}

/** 执行一次撤回或修改。 */
async function execute(ctx, invocation, withdraw) {
  const agent = invocation.agent
  const session = agent?.session
  const kind = withdraw ? 'withdraw' : 'revise'
  log('BEGIN', kind, 'raw=', invocation.rawInput, 'status=', agent?.status, 'seq=', session?.seq)

  if (session === void 0 || session === null) {
    log('END', kind, 'no-session')
    return { kind: 'error', text: '当前会话不可用，无法处理这条消息。' }
  }

  try {
    return await withSessionLock(session, () => run(ctx, invocation, withdraw, session, agent))
  } catch (error) {
    log('END', kind, 'threw', renderError(error), error?.stack ?? '')
    return { kind: 'error', text: `更新对话失败：${renderError(error)}` }
  }
}

async function run(ctx, invocation, withdraw, session, agent) {
  const kind = withdraw ? 'withdraw' : 'revise'
  const payload = parsePayload(invocation.rawInput)
  await stopThinking(ctx, agent, true)
  log('after-stop', kind, 'status=', agent?.status)

  const text = typeof payload.text === 'string' ? payload.text : ''
  if (!withdraw && text.trim().length === 0) {
    log('END', kind, 'no-text')
    return { kind: 'error', text: '修改需要提供新内容。' }
  }

  // 停止之后宿主可能还在收尾（工具没结束、流没断），surface 会继续变。
  // 所以每次尝试都在「同一份快照」上定位并替换，失败就重来：
  // 跨快照复用下标正是宿主报 `sourceEventSeqs must include every shadowed surface node` 的原因。
  let head = null
  let removed = 0
  let template = null
  // 目标只解析一次：替换之后原节点就变成了 head，再按 turn/seq 重新解析会落到更早的
  // 那条用户消息上，一下把整段历史折掉。后续重试只从 head 继续往后折。
  let targetSeq = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const nodes = surfaceNodes(session)
    if (nodes === null) return { kind: 'error', text: '当前会话不可用，无法处理这条消息。' }

    let startSeq = targetSeq
    if (startSeq === null || nodes.indexOf(startSeq) < 1) {
      if (targetSeq !== null) {
        // head 竟然不在 surface 里：说明有别的东西把这一段换掉了，不再冒险。
        log('END', kind, 'target-lost', 'target=', targetSeq)
        return { kind: 'error', text: '目标消息在改写过程中被替换掉了，请再试一次。' }
      }
      const index = targetIndex(session, nodes, payload)
      if (index <= 0) {
        log('END', kind, 'no-target', 'attempt=', attempt)
        return { kind: 'error', text: '找不到可撤回的消息（对话可能为空，或只剩系统提示）。' }
      }
      if (nodes.length - index > MAX_SHADOWED) {
        log('END', kind, 'too-many', 'count=', nodes.length - index)
        return { kind: 'error', text: `这次会连带清掉 ${nodes.length - index} 条内容，已中止（目标可能定位错了）。` }
      }
      const current = eventAt(session, nodes[index])?.data
      if (current === null || typeof current !== 'object') {
        log('END', kind, 'no-template')
        return { kind: 'error', text: '目标消息无法作为改写模板。' }
      }
      template = current
      startSeq = nodes[index]
      targetSeq = startSeq
    }

    try {
      const outcome = replaceTail(session, startSeq, template, withdraw ? NOTICE_WITHDRAW : MARK_REVISE)
      if (outcome === null) throw new Error('没有可替换的节点')
      head = outcome.head
      removed = outcome.removed
      targetSeq = head
      log('replaced', kind, 'attempt=', attempt, 'head=', head, 'removed=', removed)
    } catch (error) {
      log('replace-failed', kind, 'attempt=', attempt, renderError(error))
      if (attempt >= MAX_ATTEMPTS) {
        return { kind: 'error', text: `改写对话失败：${renderError(error)}` }
      }
      await sleep(RETRY_DELAY_MS)
      continue
    }

    // 替换之后又有新节点冒出来（宿主还在写这一轮），从 head 再折一次把它一起收掉。
    const after = surfaceNodes(session)
    if (after !== null && after[after.length - 1] !== head && attempt < MAX_ATTEMPTS) {
      log('grow-after-replace', kind, 'last=', after[after.length - 1], 'head=', head)
      await sleep(RETRY_DELAY_MS)
      continue
    }
    break
  }

  if (head === null) {
    log('END', kind, 'no-head')
    return { kind: 'error', text: '改写会话记录失败：没有可替换的节点。' }
  }

  if (!withdraw) {
    try {
      agent.followup({ ...template, id: randomUUID(), content: [{ type: 'text', text }] })
    } catch (error) {
      log('followup-failed', renderError(error))
      return { kind: 'error', text: `记录已改写，但继续生成失败：${renderError(error)}` }
    }
    log('followed-up', 'head=', head)

    // 宿主为这条 inbox 消息补写的行会与替换节点重复，出现即合并回一条。
    const wake = await waitForUserEventAfter(session, head)
    log('wake', wake === null ? 'timeout' : wake.seq)
    if (wake !== null) {
      try {
        const merged = replaceSpan(session, head, wake.seq, template, text)
        log('merged', 'head=', merged?.head)
      } catch (error) {
        log('merge-failed', renderError(error))
        ctx.logger?.warn?.(`dsh-withdraw: merge failed: ${renderError(error)}`)
      }
    } else {
      // 宿主这次启动得特别慢（排队、等模型）。别让界面一直转圈：后台继续等，
      // 等到了再合并，省得聊天里留下两条一模一样的消息。
      void mergeLater(ctx, session, head, template, text)
    }
  }

  try {
    await ctx.sessions.flush(session)
  } catch (error) {
    log('flush-failed', renderError(error))
    ctx.logger?.warn?.(`dsh-withdraw: flush failed: ${renderError(error)}`)
  }

  log('END', kind, 'ok', 'removed=', removed)
  return { kind: 'success' }
}

/** 只停住思考，不改写任何记录：编辑框一打开就调用，编辑期间不再有新内容产生。 */
async function pause(ctx, invocation) {
  const agent = invocation.agent
  const session = agent?.session
  log('BEGIN pause', 'status=', agent?.status, 'seq=', session?.seq)
  const wasRunning = agent?.status === 'running'
  // 故意不等空闲：右键要立刻见效，宿主那边的收尾交给她后面那次改写去重试。
  await stopThinking(ctx, agent, false)
  log('END pause', 'status=', agent?.status, 'was-running=', wasRunning)
  if (session !== undefined && session !== null) {
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      log('flush-failed', renderError(error))
    }
  }
  return { kind: 'success' }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'withdraw',
        description: '撤回一条已发出的消息：先停止当前思考，再清除该消息及其之后的内容',
        recordInput: false,
        handler: (invocation) => execute(ctx, invocation, true),
      }),
    'dsh-withdraw: /withdraw',
  )
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'withdraw-pause',
        description: '只停止当前思考，不改写记录（右键时先调用它）',
        recordInput: false,
        handler: (invocation) => pause(ctx, invocation),
      }),
    'dsh-withdraw: /withdraw-pause',
  )
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'revise',
        description: '修改一条已发出的消息：替换内容后继续生成',
        recordInput: false,
        handler: (invocation) => execute(ctx, invocation, false),
      }),
    'dsh-withdraw: /revise',
  )
}